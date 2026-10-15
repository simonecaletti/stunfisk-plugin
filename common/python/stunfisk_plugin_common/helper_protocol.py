"""The Live Match Helper's wire format (v1). The JSON Schema in ``common/schema`` is the reference.

The client sends what it reads from the battle it has open: new protocol lines and the current request. The service
answers with an :class:`Analysis`. The helper observes; nothing here carries a choice back to Showdown.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

API_VERSION = "v1"

# Phases of the battle as the helper sees them.
PHASES = ("waiting", "preview", "turn", "switch", "ended")


@dataclass
class Choice:
    """One suggested play. ``choice`` is the exact text Showdown's ``/choose`` takes; ``win`` is a probability or None."""

    action: str
    choice: str
    win: float | None = None
    likelihood: float | None = None


@dataclass
class Analysis:
    phase: str
    turn: int = 0
    side: str | None = None
    win: float | None = None
    recommended: Choice | None = None
    choices: list[Choice] = field(default_factory=list)
    expected_opponent: list[Choice] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    model: str = ""
    engine: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
