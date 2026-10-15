"""The adapters that ship with the helper: the Stunfisk model, and the pscpp and Showdown engines.

Both depend on the Stunfisk repository's Python packages (``stunfisk_common``, ``stunfisk_interface``,
``stunfisk_cpu``), which must be importable. When they are not, the adapter still lists itself, marked unavailable with
the reason, so the settings screen can say what is missing instead of hiding the choice.
"""

from __future__ import annotations

import importlib.util
import json
from typing import Any

from stunfisk_plugin_common import (AdapterError, AdapterInfo, Analysis, Choice, EngineAdapter, ModelAdapter, ModelGame,
                                    Position, Registry)

VGC_FORMATS = ("vgc", "doubles")


def _missing(*modules: str) -> str:
    for name in modules:
        try:
            found = importlib.util.find_spec(name)
        except (ImportError, ValueError):
            found = None
        if found is None:
            return f"The Python package {name} is not installed. Install the Stunfisk repository into this environment."
    return ""


class StunfiskEngine(EngineAdapter):
    """A Stunfisk oracle backend. ``oracle`` is the name Stunfisk's registry knows it by."""

    def __init__(self, oracle: str, name: str, module: str):
        self.oracle, self.name, self.module = oracle, name, module

    def info(self) -> AdapterInfo:
        reason = _missing("stunfisk_interface", self.module)
        return AdapterInfo(id=self.oracle, name=self.name, level="B", available=not reason, reason=reason)

    def create(self) -> Any:
        from stunfisk_interface import get_engine

        return get_engine(self.oracle)


class StunfiskModel(ModelAdapter):
    def info(self) -> AdapterInfo:
        reason = _missing("stunfisk_common", "stunfisk_cpu", "stunfisk_drivers")
        return AdapterInfo(id="stunfisk", name="Stunfisk", level="A", formats=VGC_FORMATS,
                           available=not reason, reason=reason)

    def open_game(self, engine: EngineAdapter, room: str, format_id: str, user: str) -> ModelGame:
        if not isinstance(engine, StunfiskEngine):
            raise AdapterError("Stunfisk needs one of the Stunfisk engines (showdown or pscpp).")
        return StunfiskGame(engine.create(), room, format_id, user)


class StunfiskGame(ModelGame):
    """Feeds the open battle's lines to Stunfisk's own live player and reads what it would have chosen.

    The player's ``send`` callback is where a bot would submit its choice. Here it only records it: the helper never
    submits anything to Showdown.
    """

    def __init__(self, engine: Any, room: str, format_id: str, user: str, *, player_factory: Any = None):
        self.engine = engine
        self.captured: list[tuple[str, int | None]] = []
        self.infos: list[dict[str, Any]] = []
        if player_factory is None:
            from stunfisk_common.dex import Dex
            from stunfisk_common.player import BattlePlayer
            from stunfisk_drivers.playlib import build_bot

            agent = build_bot(engine, "matrix", [], seed=1)

            def player_factory(send: Any, on_decision: Any) -> Any:
                return BattlePlayer(room, engine, agent, [], format_id, user, send, dex=Dex(engine), belief=True,
                                    await_sheets=False, on_decision=on_decision)
        self.player = player_factory(lambda choice, rqid: self.captured.append((choice, rqid)), self.infos.append)

    def analyse(self, position: Position) -> Analysis:
        self.captured.clear()
        self.infos.clear()
        for line in position.new_lines:
            self.player.line(line)
        if position.request_changed and position.request:
            self.player.line("|request|" + json.dumps(position.request, separators=(",", ":")))
        notes: list[str] = []
        recommended = None
        if self.captured:
            choice = self.captured[-1][0]
            info = self.infos[-1] if self.infos else {}
            recommended = Choice(action=_describe(choice, info), choice=choice)
            notes += [f"Assumed: {n}" for n in info.get("assumed", [])]
            if info and not info.get("searched", True):
                notes.append(f"Stunfisk fell back to a simple policy: {info.get('reason') or 'no position could be built'}.")
        elif position.phase in ("preview", "turn", "switch"):
            notes.append("Waiting for the information Stunfisk needs (the opponent's team sheet or the current request).")
        return Analysis(phase=position.phase, turn=position.turn, side=position.side, recommended=recommended,
                        choices=[recommended] if recommended else [], notes=notes)

    def close(self) -> None:
        close = getattr(self.engine, "close", None)
        if callable(close):
            close()


def _describe(choice: str, info: dict[str, Any]) -> str:
    try:
        from stunfisk_drivers import cli

        return str(cli.describe_choice(choice, info["decision"], info["field"]))
    except Exception:  # noqa: BLE001 — a readable name is a nicety; the raw choice is always valid
        return choice


def default_registry() -> Registry:
    registry = Registry()
    registry.add_model(StunfiskModel())
    registry.add_engine(StunfiskEngine("pscpp", "pscpp (native)", "stunfisk_pscpp"))
    registry.add_engine(StunfiskEngine("showdown", "Pokémon Showdown simulator", "stunfisk_showdown"))
    return registry
