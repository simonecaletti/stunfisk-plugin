"""The helper service's HTTP API (v1). Standard library only.

    GET    /v1/health
    POST   /v1/auth/request          {email}
    POST   /v1/auth/verify           {email, code}              -> {token, expires_at, email}
    POST   /v1/auth/username/start   {username}                 sign in as a Showdown name (local services only)
    GET    /v1/auth/username/poll?request=<id>                  -> {status, token?}
    POST   /v1/auth/username/approve {name}                     the browser logged in as that name approves
    GET    /v1/me                                               -> {email, username, showdown}
    PUT    /v1/me/showdown           {name}                     link a Showdown name to this account
    DELETE /v1/me/showdown                                      unlink it
    POST   /v1/me/showdown/seen      {name}                     the browser reports the name it is logged in as
    GET    /v1/helper/current                                   -> {session}  the game being played now
    GET    /v1/capabilities                                     -> {models, engines}
    POST   /v1/helper/sessions       {room, format, model, engine, analysis_mode, user?}
    POST   /v1/helper/sessions/{id}/events   {from, lines, side?, request?}
    GET    /v1/helper/sessions/{id}?after=<revision>&wait=<seconds>
    DELETE /v1/helper/sessions/{id}

Everything but health and the two auth calls needs ``Authorization: Bearer <token>``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from stunfisk_plugin_common import Registry

from .auth import AuthError, AuthService
from .links import LinkError, LinkStore, to_id
from .usernames import UsernameError, UsernameLogin, is_username_subject, subject_for
from .sessions import SessionError, SessionManager

PAGE = Path(__file__).parent / "web" / "index.html"
MAX_BODY = 2_000_000
DEFAULT_ORIGINS = ("https://play.pokemonshowdown.com", "http://localhost:8000", "http://127.0.0.1:8000")
SESSION = re.compile(r"^/v1/helper/sessions/([0-9a-f]{16})(/events)?$")


def origin_allowed(origin: str, allowed: tuple[str, ...]) -> bool:
    if origin in allowed:
        return True
    # The Showdown client is also served from *.psim.us, and an extension page has its own scheme.
    return bool(re.fullmatch(r"https://[a-z0-9-]+\.psim\.us", origin)) or origin.startswith(("chrome-extension://", "moz-extension://"))


def _hash(text: str) -> str:
    return "'sha256-" + base64.b64encode(hashlib.sha256(text.encode()).digest()).decode() + "'"


def landing_page() -> tuple[bytes, str]:
    """The landing page and the Content-Security-Policy that allows exactly its own inline style and script."""
    html = PAGE.read_text(encoding="utf-8")
    style = re.search(r"<style>(.*?)</style>", html, re.S)
    script = re.search(r"<script>(.*?)</script>", html, re.S)
    policy = ("default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'self'; "
              f"style-src {_hash(style.group(1)) if style else 'none'}; "
              f"script-src {_hash(script.group(1)) if script else 'none'}")
    return html.encode("utf-8"), policy


def _service_version() -> str:
    try:
        return package_version("stunfisk-plugin")
    except PackageNotFoundError:
        return "dev"


def make_server(host: str, port: int, auth: AuthService, registry: Registry, *,
                origins: tuple[str, ...] = DEFAULT_ORIGINS, signin: str = "console",
                links: LinkStore | None = None, username_login: bool = False) -> ThreadingHTTPServer:
    sessions = SessionManager(registry)
    links = links or LinkStore()
    usernames = UsernameLogin()

    def account_for(name: str) -> str:
        """The account a browser-approved Showdown name signs in to. Its link is confirmed by that approval."""
        subject = subject_for(name)
        links.set(subject, name)
        links.seen(subject, name)
        return subject

    def username_only() -> None:
        if not username_login:
            raise SessionError("Signing in with a Showdown name is not available on this service. Use your email.", 404)
    page, page_policy = landing_page()

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
                self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
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

        def _send_page(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.send_header("Content-Security-Policy", page_policy)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(page)

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
            if method == "GET" and path in ("/", "/index.html"):
                return self._send_page()
            if method == "GET" and path == "/v1/health":
                return self._send(200, {"ok": True, "api": "v1"})
            if method == "GET" and path == "/v1/status":
                # Public: names and whether each is available. Reasons and details stay behind the sign-in.
                caps = registry.capabilities()
                brief = lambda items: [{"id": i["id"], "name": i["name"], "available": i["available"]} for i in items]  # noqa: E731
                return self._send(200, {"ok": True, "api": "v1", "version": _service_version(), "signin": signin,
                                        "username_login": username_login,
                                        "models": brief(caps["models"]), "engines": brief(caps["engines"])})
            if method == "POST" and path == "/v1/auth/username/start":
                username_only()
                try:
                    return self._send(200, {"request": usernames.start(str(self._body().get("username", "")))})
                except UsernameError as error:
                    raise SessionError(str(error), error.status) from error
            if method == "GET" and path == "/v1/auth/username/poll":
                username_only()
                result = usernames.poll(query.get("request", [""])[0])
                if result["status"] == "approved":
                    subject = account_for(result["name"])
                    result = {**result, **auth.token_for(subject)}
                return self._send(200, result)
            if method == "POST" and path == "/v1/auth/username/approve":
                username_only()
                try:
                    name = usernames.approve(str(self._body().get("name", "")))
                except UsernameError as error:
                    raise SessionError(str(error), error.status) from error
                if not name:
                    raise SessionError("Nobody is signing in as that name.", 404)
                return self._send(200, {**auth.token_for(account_for(name)), "name": name})
            if method == "POST" and path == "/v1/auth/request":
                auth.request_code(str(self._body().get("email", "")))
                return self._send(202, {"sent": True})
            if method == "POST" and path == "/v1/auth/verify":
                body = self._body()
                return self._send(200, auth.verify(str(body.get("email", "")), str(body.get("code", ""))))
            owner = self._user()
            if method == "GET" and path == "/v1/me":
                link = links.get(owner)
                if is_username_subject(owner):
                    return self._send(200, {"email": None, "username": link["name"] if link else None, "showdown": link})
                return self._send(200, {"email": owner, "username": None, "showdown": link})
            if path == "/v1/me/showdown":
                if method in ("PUT", "DELETE") and is_username_subject(owner):
                    raise SessionError("This account is signed in with its Showdown name. Sign out to change it.")
                if method == "PUT":
                    try:
                        return self._send(200, links.set(owner, str(self._body().get("name", ""))))
                    except LinkError as error:
                        raise SessionError(str(error)) from error
                if method == "DELETE":
                    links.clear(owner)
                    return self._send(204)
            if method == "POST" and path == "/v1/me/showdown/seen":
                return self._send(200, links.seen(owner, str(self._body().get("name", ""))))
            if method == "GET" and path == "/v1/helper/current":
                session = sessions.current(owner)
                summary = session.summary() if session else None
                if summary:
                    link = links.get(owner)
                    summary["linked"] = bool(link) and to_id(link["name"]) == to_id(summary["player"])
                return self._send(200, {"session": summary, "showdown": links.get(owner)})
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
        def do_PUT(self) -> None: self._handle("PUT")  # noqa: E704
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
