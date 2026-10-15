"""Sign in with an email address: a one-time code, then a signed token.

Nothing here stores a password. A code is six digits, valid for ten minutes, good for one sign-in, and dies after five
wrong guesses. A token is ``email|expiry`` signed with the service's secret, so the service keeps no session table.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import threading
import time
from collections.abc import Callable
from pathlib import Path

from .mailers import Mailer

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class AuthError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def load_secret(path: Path) -> bytes:
    """The signing secret, created with owner-only permissions on first use."""
    if path.exists():
        return bytes.fromhex(path.read_text().strip())
    path.parent.mkdir(parents=True, exist_ok=True)
    value = secrets.token_bytes(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(value.hex())
    return value


class AuthService:
    def __init__(self, mailer: Mailer, secret: bytes, *, allowed: set[str] | None = None,
                 clock: Callable[[], float] = time.time, code_ttl: int = 600, token_ttl: int = 30 * 86400,
                 max_attempts: int = 5, min_interval: int = 30, max_per_hour: int = 5):
        self.mailer, self.secret, self.allowed = mailer, secret, allowed
        self.clock, self.code_ttl, self.token_ttl = clock, code_ttl, token_ttl
        self.max_attempts, self.min_interval, self.max_per_hour = max_attempts, min_interval, max_per_hour
        self._codes: dict[str, dict] = {}
        self._sent: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    @staticmethod
    def normalise(email: str) -> str:
        email = (email or "").strip().lower()
        if len(email) > 254 or not _EMAIL.match(email) or email.startswith("showdown:"):
            raise AuthError("Enter a valid email address.")
        return email

    def _digest(self, email: str, code: str) -> str:
        return hmac.new(self.secret, f"code|{email}|{code}".encode(), hashlib.sha256).hexdigest()

    def request_code(self, email: str) -> None:
        """Emails a code. An address that is not allowed gets the same answer, so the list cannot be probed."""
        email = self.normalise(email)
        now = self.clock()
        with self._lock:
            history = [t for t in self._sent.get(email, []) if now - t < 3600]
            if history and now - history[-1] < self.min_interval:
                raise AuthError("A code was just sent. Wait a moment before asking for another.", 429)
            if len(history) >= self.max_per_hour:
                raise AuthError("Too many codes were requested for this address. Try again later.", 429)
            self._sent[email] = [*history, now]
            if self.allowed is not None and email not in self.allowed:
                return
            code = f"{secrets.randbelow(10**6):06d}"
            self._codes[email] = {"digest": self._digest(email, code), "expires": now + self.code_ttl, "attempts": 0}
        self.mailer.send_code(email, code, self.code_ttl // 60)

    def verify(self, email: str, code: str) -> dict:
        email = self.normalise(email)
        now = self.clock()
        with self._lock:
            entry = self._codes.get(email)
            if not entry or entry["expires"] < now:
                self._codes.pop(email, None)
                raise AuthError("That code is wrong or has expired.", 401)
            entry["attempts"] += 1
            if entry["attempts"] > self.max_attempts:
                self._codes.pop(email, None)
                raise AuthError("That code is wrong or has expired.", 401)
            if not hmac.compare_digest(entry["digest"], self._digest(email, str(code).strip())):
                raise AuthError("That code is wrong or has expired.", 401)
            del self._codes[email]
        return {**self.token_for(email), "email": email}

    def token_for(self, subject: str) -> dict:
        """A signed token for an identity the caller has already proved: an email, or a ``showdown:`` subject."""
        expires = int(self.clock() + self.token_ttl)
        return {"token": self._sign(subject, expires), "expires_at": expires}

    def _sign(self, email: str, expires: int) -> str:
        body = base64.urlsafe_b64encode(f"{email}|{expires}".encode()).decode().rstrip("=")
        mac = hmac.new(self.secret, f"token|{body}".encode(), hashlib.sha256).hexdigest()
        return f"{body}.{mac}"

    def authenticate(self, token: str | None) -> str | None:
        """The email a token belongs to, or None."""
        try:
            body, mac = (token or "").split(".", 1)
            expected = hmac.new(self.secret, f"token|{body}".encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(mac, expected):
                return None
            email, expires = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)).decode().rsplit("|", 1)
            if int(expires) < self.clock():
                return None
            if self.allowed is not None and not email.startswith("showdown:") and email not in self.allowed:
                return None
            return email
        except (ValueError, UnicodeError):
            return None
