"""Model and engine adapters: what the settings choose between (ADR 0002).

A *model* is the bot that proposes plays (Stunfisk). An *engine* is the simulator it searches on (pscpp, Showdown).
This matches Stunfisk's own words: the bot is the model and its backend is the oracle.

Applications differ in what they need (ADR 0001): level A needs only a move, level B also needs value estimates.
``Analysis`` carries both and leaves the extra fields empty for a level A model, so one panel serves both.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from .helper_protocol import Analysis


class AdapterError(Exception):
    """A model or engine that cannot be used. The message is shown to the user."""


@dataclass
class Position:
    """Everything the client read from the open battle, in the order Showdown sent it."""

    room: str
    format: str
    side: str | None
    phase: str
    turn: int
    new_lines: list[str]
    """Protocol lines not yet given to this game. The first call of a game gets all of them."""
    request: dict[str, Any] | None
    """The latest private request, or None (spectating, or between decisions)."""
    request_changed: bool
    analysis_mode: str = "fast"


@dataclass
class AdapterInfo:
    id: str
    name: str
    level: str = "A"
    formats: tuple[str, ...] = ()
    """Format id fragments this adapter supports, matched as lowercase substrings. Empty means any."""
    available: bool = True
    reason: str = ""
    """Why it is unavailable, when it is."""

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "level": self.level, "formats": list(self.formats),
                "available": self.available, "reason": self.reason}

    def supports(self, format_id: str) -> bool:
        wanted = format_id.lower().replace(" ", "")
        return not self.formats or any(f in wanted for f in self.formats)


class EngineAdapter(ABC):
    """A simulator backend. It is chosen in settings and handed to the model."""

    @abstractmethod
    def info(self) -> AdapterInfo: ...

    def check(self) -> None:
        """Raise :class:`AdapterError` if this engine cannot run here. The default trusts ``info().available``."""
        info = self.info()
        if not info.available:
            raise AdapterError(info.reason or f"The engine {info.id} is not available.")


class ModelGame(ABC):
    """One model playing one battle. The service keeps one per session and feeds it positions in order."""

    @abstractmethod
    def analyse(self, position: Position) -> Analysis: ...

    def close(self) -> None:
        """Release processes and handles."""


class ModelAdapter(ABC):
    @abstractmethod
    def info(self) -> AdapterInfo: ...

    @abstractmethod
    def open_game(self, engine: EngineAdapter, room: str, format_id: str, user: str) -> ModelGame: ...


@dataclass
class Registry:
    models: dict[str, ModelAdapter] = field(default_factory=dict)
    engines: dict[str, EngineAdapter] = field(default_factory=dict)

    def add_model(self, adapter: ModelAdapter) -> None:
        self.models[adapter.info().id] = adapter

    def add_engine(self, adapter: EngineAdapter) -> None:
        self.engines[adapter.info().id] = adapter

    def model(self, model_id: str) -> ModelAdapter:
        if model_id not in self.models:
            raise AdapterError(f"Unknown model {model_id!r}. Available: {', '.join(sorted(self.models)) or 'none'}.")
        return self.models[model_id]

    def engine(self, engine_id: str) -> EngineAdapter:
        if engine_id not in self.engines:
            raise AdapterError(f"Unknown engine {engine_id!r}. Available: {', '.join(sorted(self.engines)) or 'none'}.")
        return self.engines[engine_id]

    def capabilities(self) -> dict[str, Any]:
        return {"models": [m.info().to_dict() for m in self.models.values()],
                "engines": [e.info().to_dict() for e in self.engines.values()]}
