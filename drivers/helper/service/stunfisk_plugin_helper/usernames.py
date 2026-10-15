"""Sign in with a Showdown username, proved by the user's own logged-in browser. For a service only you can reach.

Showdown has no sign-in a third party can use, and Coach never asks for the password. So the proof is the browser: the
page asks to sign in as a name, and the extension, running in a Showdown page logged in as that name, approves it.

This proves nothing against someone who can call the service directly, because the approving call is just an HTTP
request. It is therefore only offered when the service listens on this computer alone. A service anyone can reach keeps
the email sign-in, which proves control of an inbox.
"""

from __future__ import annotations

import re
import secrets
import threading
import time
from collections.abc import Callable
from typing import Any

from .links import NAME, to_id

SUBJECT = "showdown:"


class UsernameError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def subject_for(name: str) -> str:
    return SUBJECT + to_id(name)


def is_username_subject(subject: str) -> bool:
    return subject.startswith(SUBJECT)


def check_name(name: str) -> str:
    name = (name or "").strip()
    if not NAME.match(name) or not to_id(name):
        raise UsernameError("Enter your Showdown name: up to 18 letters, digits, spaces, dots, dashes or underscores.")
    if re.fullmatch(r"guest\d*", to_id(name)):
        raise UsernameError("A guest name cannot sign in. Log in to Showdown with your own name first.")
    return name


class UsernameLogin:
    def __init__(self, *, clock: Callable[[], float] = time.time, ttl: int = 300, max_pending: int = 20, per_name: int = 5):
        self.clock, self.ttl, self.max_pending, self.per_name = clock, ttl, max_pending, per_name
        self._pending: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def _expire(self) -> None:
        now = self.clock()
        for rid in [rid for rid, p in self._pending.items() if p["expires"] < now]:
            del self._pending[rid]

    def start(self, name: str) -> str:
        """A page asks to sign in as ``name``. Returns the request id the page polls with."""
        name = check_name(name)
        with self._lock:
            self._expire()
            wanted = to_id(name)
            if len(self._pending) >= self.max_pending or sum(p["id"] == wanted for p in self._pending.values()) >= self.per_name:
                raise UsernameError("Too many sign-in attempts. Wait a few minutes.", 429)
            rid = secrets.token_hex(8)
            self._pending[rid] = {"id": wanted, "asked": name, "expires": self.clock() + self.ttl, "approved": None}
            return rid

    def approve(self, name: str) -> str | None:
        """A browser logged in to Showdown as ``name`` approves. Returns the exact name, or None if nobody asked for it."""
        name = check_name(name)
        wanted = to_id(name)
        with self._lock:
            self._expire()
            hit = [p for p in self._pending.values() if p["id"] == wanted and p["approved"] is None]
            for p in hit:
                p["approved"] = name
            return name if hit else None

    def poll(self, rid: str) -> dict[str, Any]:
        with self._lock:
            self._expire()
            p = self._pending.get(rid)
            if not p:
                return {"status": "expired"}
            if p["approved"] is None:
                return {"status": "pending", "name": p["asked"]}
            del self._pending[rid]  # one use
            return {"status": "approved", "name": p["approved"]}
