"""The helper service's HTTP API (v1). Standard library only.

    GET    /v1/health
    POST   /v1/auth/request          {email}
    POST   /v1/auth/verify           {email, code}              -> {token, expires_at, email}
    GET    /v1/me                                               -> {email}
    GET    /v1/capabilities                                     -> {models, engines}
    POST   /v1/helper/sessions       {room, format, model, engine, analysis_mode, user?}
    POST   /v1/helper/sessions/{id}/events   {from, lines, side?, request?}
    GET    /v1/helper/sessions/{id}?after=<revision>&wait=<seconds>
    DELETE /v1/helper/sessions/{id}

Everything but health and the two auth calls needs ``Authorization: Bearer <token>``.
"""

from __future__ import annotations

import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from stunfisk_plugin_common import Registry

from .auth import AuthError, AuthService
from .sessions import SessionError, SessionManager

MAX_BODY = 2_000_000
DEFAULT_ORIGINS = ("https://play.pokemonshowdown.com", "http://localhost:8000", "http://127.0.0.1:8000")
SESSION = re.compile(r"^/v1/helper/sessions/([0-9a-f]{16})(/events)?$")


def origin_allowed(origin: str, allowed: tuple[str, ...]) -> bool:
    if origin in allowed:
        return True
    # The Showdown client is also served from *.psim.us, and an extension page has its own scheme.
    return bool(re.fullmatch(r"https://[a-z0-9-]+\.psim\.us", origin)) or origin.startswith(("chrome-extension://", "moz-extension://"))


def make_server(host: str, port: int, auth: AuthService, registry: Registry, *,
                origins: tuple[str, ...] = DEFAULT_ORIGINS) -> ThreadingHTTPServer:
    sessions = SessionManager(registry)

    class Handler(BaseHTTPRequestHandler):
        server_version = "stunfisk-helper"
        protocol_version = "HTTP/1.1"

        def log_message(self, *_: Any) -> None:  # quiet: bodies hold battles
            pass

        # --- plumbing ---
        def _cors(self) -> None:
            origin = self.headers.get("Origin")
            if origin and origin_allowed(origin, origins):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
                if self.headers.get("Access-Control-Request-Private-Network"):
                    self.send_header("Access-Control-Allow-Private-Network", "true")

        def _send(self, status: int, body: Any = None) -> None:
            data = b"" if body is None else json.dumps(body).encode()
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                raise SessionError("The request is too large.", 413)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                value = json.loads(raw or b"{}")
            except ValueError as error:
                raise SessionError("The body is not valid JSON.") from error
            if not isinstance(value, dict):
                raise SessionError("The body must be a JSON object.")
            return value

        def _user(self) -> str:
            header = self.headers.get("Authorization", "")
            email = auth.authenticate(header[7:] if header.startswith("Bearer ") else None)
            if not email:
                raise AuthError("Sign in first.", 401)
            return email

        def _route(self, method: str) -> None:
            url = urlparse(self.path)
            path, query = url.path, parse_qs(url.query)
            if method == "GET" and path == "/v1/health":
                return self._send(200, {"ok": True, "api": "v1"})
            if method == "POST" and path == "/v1/auth/request":
                auth.request_code(str(self._body().get("email", "")))
                return self._send(202, {"sent": True})
            if method == "POST" and path == "/v1/auth/verify":
                body = self._body()
                return self._send(200, auth.verify(str(body.get("email", "")), str(body.get("code", ""))))
            owner = self._user()
            if method == "GET" and path == "/v1/me":
                return self._send(200, {"email": owner})
            if method == "GET" and path == "/v1/capabilities":
                return self._send(200, registry.capabilities())
            if method == "POST" and path == "/v1/helper/sessions":
                session = sessions.create(owner, self._body())
                return self._send(201, session.view())
            match = SESSION.match(path)
            if match:
                sid, events = match.groups()
                if events and method == "POST":
                    body = self._body()
                    start = body.get("from")
                    if not isinstance(start, int) or isinstance(start, bool) or start < 0:
                        raise SessionError("from must be a non-negative integer.")
                    side = body.get("side")
                    return self._send(200, sessions.get(owner, sid).add_events(start, body.get("lines", []), side, body.get("request")))
                if not events and method == "GET":
                    after = int(query["after"][0]) if query.get("after", [""])[0].isdigit() else None
                    wait = float(query["wait"][0]) if query.get("wait", [""])[0].replace(".", "", 1).isdigit() else 0.0
                    return self._send(200, sessions.get(owner, sid).view(after, wait))
                if not events and method == "DELETE":
                    sessions.close(owner, sid)
                    return self._send(204)
            raise SessionError("Not found.", 404)

        def _handle(self, method: str) -> None:
            try:
                self._route(method)
            except AuthError as error:
                self._send(error.status, {"error": str(error)})
            except SessionError as error:
                self._send(error.status, {"error": str(error), **error.extra})
            except (BrokenPipeError, ConnectionResetError):
                pass  # the client gave up (an aborted long poll); nobody is left to answer
            except Exception as error:  # noqa: BLE001 — never leak a traceback to a client
                try:
                    self._send(500, {"error": f"Internal error: {type(error).__name__}"})
                except OSError:
                    pass

        def do_GET(self) -> None: self._handle("GET")  # noqa: E704
        def do_POST(self) -> None: self._handle("POST")  # noqa: E704
        def do_DELETE(self) -> None: self._handle("DELETE")  # noqa: E704

        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.sessions = sessions  # type: ignore[attr-defined]
    return server
