"""Which Showdown name belongs to which Coach account.

Showdown has no sign-in a third party can use, and Coach never asks for a Showdown password. So a link is two things: the
name the user typed, and a confirmation from their own browser. The extension, running in a page where the user is
logged in to Showdown, reports the name it sees. When that matches the linked name, the link is confirmed. That shows
the browser using this Coach account is logged in as that name. It is not a cryptographic proof, and nothing here
depends on it being one: the helper only reads battles and never acts on the Showdown account.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,17}$")


def to_id(name: str) -> str:
    """Showdown's own id for a name: lowercase letters and digits only."""
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


class LinkError(ValueError):
    pass


class LinkStore:
    """A small JSON file, or memory when no path is given."""

    def __init__(self, path: Path | None = None):
        self.path = path
        self._lock = threading.Lock()
        self._data: dict[str, dict[str, Any]] = {}
        if path and path.exists():
            try:
                loaded = json.loads(path.read_text())
                if isinstance(loaded, dict):
                    self._data = {k: v for k, v in loaded.items() if isinstance(v, dict) and "name" in v}
            except (OSError, ValueError):
                self._data = {}

    def _save(self) -> None:
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(self._data, f)
        os.replace(tmp, self.path)

    @staticmethod
    def _public(entry: dict[str, Any] | None) -> dict[str, Any] | None:
        return None if not entry else {"name": entry["name"], "confirmed": bool(entry.get("confirmed"))}

    def get(self, email: str) -> dict[str, Any] | None:
        with self._lock:
            return self._public(self._data.get(email))

    def set(self, email: str, name: str) -> dict[str, Any]:
        name = (name or "").strip()
        if not NAME.match(name) or not to_id(name):
            raise LinkError("Enter your Showdown name: up to 18 letters, digits, spaces, dots, dashes or underscores.")
        if to_id(name).startswith("guest") and re.fullmatch(r"guest\d*", to_id(name)):
            raise LinkError("A guest name cannot be linked. Log in to Showdown with your own name first.")
        with self._lock:
            self._data[email] = {"name": name, "confirmed": False, "updated": int(time.time())}
            self._save()
            return self._public(self._data[email])  # type: ignore[return-value]

    def clear(self, email: str) -> None:
        with self._lock:
            if self._data.pop(email, None) is not None:
                self._save()

    def seen(self, email: str, name: str) -> dict[str, Any]:
        """The browser says it is logged in to Showdown as ``name``. Confirms the link if that is the linked name."""
        with self._lock:
            entry = self._data.get(email)
            if not entry:
                return {"linked": False, "match": False, "confirmed": False}
            match = to_id(name) == to_id(entry["name"]) and bool(to_id(name))
            if match and not entry.get("confirmed"):
                entry["confirmed"] = True
                self._save()
            return {"linked": True, "match": match, "confirmed": bool(entry.get("confirmed")), "name": entry["name"]}
