"""What the helper knows about a battle, from the protocol lines the client read and its latest request.

Ported from VGC Lab's ``live_analysis.player_side`` and ``live_service.network``: the same lines are dropped, the same
lines trigger a new analysis, and the same pivot moves count as a decision point.
"""

from __future__ import annotations

import re
from typing import Any

# Lines that are chat or page furniture, never battle state.
IGNORED = ("|c|", "|c:|", "|j|", "|l|", "|J|", "|L|", "|uhtml", "|html|", "|raw|", "|t:|", "|inactive", "|timer",
           "|sentchoice")
# Lines after which the position has changed enough to be worth a new analysis.
TRIGGERS = ("|showteam|", "|teampreview", "|turn|", "|upkeep", "|win|", "|tie", "|faint|")
# Moves and items that hand the player a decision in the middle of a turn.
PIVOT_MOVES = {"uturn", "voltswitch", "flipturn", "partingshot", "teleport", "batonpass", "shedtail", "chillyreception"}
EJECT_TEXT = ("Emergency Exit", "Eject Button", "Eject Pack")

MAX_LINES = 50_000


def to_id(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


class BattleState:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.received = 0
        """Lines the client has sent, ignored ones included. The client counts the same way."""
        self.format = ""
        self.players: dict[str, str] = {}
        self.teams: dict[str, list[str]] = {"p1": [], "p2": []}
        self.turn = 0
        self.ended = False
        self.winner: str | None = None
        self.preview = False

    def append(self, lines: list[str]) -> bool:
        """Accepts new lines in order. Returns True if any of them is a point worth analysing."""
        changed = False
        self.received += len(lines)
        for line in lines:
            if not line.startswith("|") or line.startswith(IGNORED):
                continue
            if len(self.lines) >= MAX_LINES:
                raise ValueError("The battle log is too large.")
            self.lines.append(line)
            changed |= self._apply(line)
        return changed

    def _apply(self, line: str) -> bool:
        p = line.split("|")
        cmd = p[1] if len(p) > 1 else ""
        if cmd == "tier" and len(p) > 2:
            self.format = p[2]
        elif cmd == "player" and len(p) > 3 and p[3]:
            self.players[p[2]] = p[3]
        elif cmd == "poke" and len(p) > 3 and p[2] in self.teams:
            self.teams[p[2]].append(p[3].split(",")[0])
        elif cmd == "teampreview":
            self.preview = True
        elif cmd == "turn" and len(p) > 2 and p[2].isdigit():
            self.turn = int(p[2])
        elif cmd == "win" or line == "|tie" or cmd == "tie":
            self.ended = True
            self.winner = p[2] if cmd == "win" and len(p) > 2 else None
        changed = line.startswith(TRIGGERS)
        if cmd == "move" and len(p) > 3 and to_id(p[3]) in PIVOT_MOVES:
            changed = True
        if cmd in ("-activate", "-enditem") and any(name in line for name in EJECT_TEXT):
            changed = True
        return changed

    def side_for(self, hint: str | None, request: dict[str, Any] | None) -> str | None:
        """Which side the user plays: the client's word, else the private request's, else unknown (a spectator)."""
        if hint in ("p1", "p2"):
            return hint
        side = ((request or {}).get("side") or {}).get("id")
        return side if side in ("p1", "p2") else None

    def phase(self, request: dict[str, Any] | None) -> str:
        if self.ended:
            return "ended"
        if request and request.get("wait"):
            return "waiting"
        if self.turn == 0:
            if (request and request.get("teamPreview")) or self.preview:
                return "preview"
            return "waiting"
        if request and any(request.get("forceSwitch") or []):
            return "switch"
        return "turn"
