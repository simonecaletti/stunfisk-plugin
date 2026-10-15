"""Plugin settings: the one record every driver reads (ADR 0001, ADR 0002).

The client stores it; the service never does. The service only receives the model, engine and analysis mode that a
session names, so a setting can change without restarting the service.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, fields
from typing import Any
from urllib.parse import urlparse

RUN_MODES = ("local", "remote")
ANALYSIS_MODES = ("fast", "standard", "deep")
DEFAULT_LOCAL_URL = "http://127.0.0.1:8787"

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_ID = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_LOOPBACK = {"127.0.0.1", "localhost", "::1", "[::1]"}


@dataclass
class Settings:
    email: str = ""
    model: str = "stunfisk"
    engine: str = "pscpp"
    run_mode: str = "local"
    local_url: str = DEFAULT_LOCAL_URL
    remote_url: str = ""
    analysis_mode: str = "fast"

    def problems(self) -> list[str]:
        """Everything wrong with these settings, as sentences. Empty when they are usable."""
        out: list[str] = []
        if self.email and not _EMAIL.match(self.email):
            out.append("The email address is not valid.")
        if not _ID.match(self.model):
            out.append("The model must be a lowercase identifier.")
        if not _ID.match(self.engine):
            out.append("The engine must be a lowercase identifier.")
        if self.run_mode not in RUN_MODES:
            out.append(f"The run mode must be one of {', '.join(RUN_MODES)}.")
        if self.analysis_mode not in ANALYSIS_MODES:
            out.append(f"The analysis mode must be one of {', '.join(ANALYSIS_MODES)}.")
        if self.run_mode == "local":
            out += _url_problems("The local service address", self.local_url, loopback_only=True)
        elif self.run_mode == "remote":
            out += _url_problems("The remote service address", self.remote_url, loopback_only=False)
        return out

    def service_url(self) -> str:
        """The base URL of the service to talk to, without a trailing slash."""
        problems = self.problems()
        if problems:
            raise ValueError(problems[0])
        url = self.local_url if self.run_mode == "local" else self.remote_url
        return url.rstrip("/")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> Settings:
        """Known keys only; anything missing keeps its default. Does not validate."""
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in (data or {}).items() if k in known and isinstance(v, str)})


def _url_problems(label: str, url: str, *, loopback_only: bool) -> list[str]:
    if not url:
        return [f"{label} is empty."]
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        return [f"{label} must be an http(s) URL without a user name or password."]
    host = parsed.hostname.lower()
    loopback = host in _LOOPBACK
    if loopback_only and not loopback:
        return [f"{label} must be on this computer (127.0.0.1 or localhost). Use remote mode for another host."]
    if not loopback and parsed.scheme != "https":
        return [f"{label} must use https, because it carries your login and your battles."]
    return []
