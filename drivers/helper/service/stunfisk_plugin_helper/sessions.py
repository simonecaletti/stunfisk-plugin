"""Helper sessions: one per open battle, each with its own model game and a worker thread.

A client feeds a session with the lines it reads from its open battle and the current request. The worker waits
briefly for a packet to settle, then asks the model for an analysis. The client reads the result by polling.
"""

from __future__ import annotations

import re
import threading
import time
import uuid
from typing import Any

from stunfisk_plugin_common import (ANALYSIS_MODES, AdapterError, Analysis, ModelGame, Position, Registry)

from .battle_state import BattleState

MAX_ACTIVE_PER_USER = 4
IDLE_SECONDS = 3 * 3600
SETTLE_SECONDS = 0.12
ROOM = re.compile(r"^battle-[a-z0-9-]+$")


class SessionError(Exception):
    def __init__(self, message: str, status: int = 400, extra: dict[str, Any] | None = None):
        super().__init__(message)
        self.status = status
        self.extra = extra or {}


class Session:
    def __init__(self, owner: str, body: dict[str, Any], registry: Registry):
        room, fmt = str(body.get("room", "")), str(body.get("format", ""))
        if not ROOM.match(room):
            raise SessionError("The room must be a battle room such as battle-gen9vgc2026regmc-123.")
        mode = body.get("analysis_mode", "fast")
        if mode not in ANALYSIS_MODES:
            raise SessionError("Choose an analysis mode: fast, standard or deep.")
        try:
            self.model = registry.model(str(body.get("model", "")))
            self.engine = registry.engine(str(body.get("engine", "")))
            self.engine.check()
        except AdapterError as error:
            raise SessionError(str(error), 422) from error
        info = self.model.info()
        if not info.available:
            raise SessionError(info.reason or f"The model {info.id} is not available.", 422)
        self.id = uuid.uuid4().hex[:16]
        self.owner, self.room, self.format, self.user = owner, room, fmt, str(body.get("user", ""))
        self.analysis_mode = mode
        self.state = BattleState()
        self.format_note = ""
        if fmt and not info.supports(fmt):
            self.format_note = f"{info.name} is not trained for {fmt}. Advice may be inaccurate."
        self.request: dict[str, Any] | None = None
        self.side_hint: str | None = None
        self.request_dirty = False
        self.fed = 0
        self.game: ModelGame | None = None
        self.status = "idle"
        self.revision = 0
        self.analysis: dict[str, Any] | None = None
        self.error: str | None = None
        self.touched = time.time()
        self.cond = threading.Condition()
        self.wake = threading.Event()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._work, daemon=True, name=f"helper-{self.id}")
        self.thread.start()

    # --- called from request threads ---------------------------------------------------

    def add_events(self, start: int, lines: list[str], side: str | None, request: dict[str, Any] | None) -> dict[str, Any]:
        if not isinstance(lines, list) or not all(isinstance(x, str) for x in lines):
            raise SessionError("lines must be a list of strings.")
        if request is not None and not isinstance(request, dict):
            raise SessionError("request must be an object or null.")
        with self.cond:
            if self.status == "closed":
                raise SessionError("This session is closed.", 410)
            have = self.state.received
            if start != have:
                raise SessionError("The service holds a different number of lines.", 409, {"have": have})
            try:
                changed = self.state.append(lines)
            except ValueError as error:
                self.status, self.error = "error", str(error)
                self.cond.notify_all()
                raise SessionError(str(error), 413) from error
            if side in ("p1", "p2"):
                self.side_hint = side
            if request != self.request:
                self.request = request
                self.request_dirty = bool(request)
                changed = changed or bool(request)
            self.touched = time.time()
            if changed:
                self.status = "analysing"
                self.wake.set()
            return {"accepted": len(lines), "lines": self.state.received}

    def view(self, after: int | None = None, wait: float = 0) -> dict[str, Any]:
        deadline = time.time() + max(0.0, min(wait, 25.0))
        with self.cond:
            while after is not None and self.revision <= after and self.status not in ("closed", "error"):
                left = deadline - time.time()
                if left <= 0:
                    break
                self.cond.wait(left)
            self.touched = time.time()
            return {"id": self.id, "status": self.status, "revision": self.revision, "lines": self.state.received,
                    "analysis": self.analysis, "error": self.error}

    def close(self) -> None:
        with self.cond:
            self.status = "closed"
            self.cond.notify_all()
        self.stop.set()
        self.wake.set()
        if threading.current_thread() is not self.thread:
            self.thread.join(timeout=5)
        self._close_game()

    # --- the worker -------------------------------------------------------------------

    def _close_game(self) -> None:
        game, self.game = self.game, None
        if game:
            try:
                game.close()
            except Exception:  # noqa: BLE001 — closing must not raise into the caller
                pass

    def _work(self) -> None:
        while not self.stop.is_set():
            self.wake.wait(1)
            if not self.wake.is_set():
                if time.time() - self.touched > IDLE_SECONDS:
                    self.close()
                continue
            self.wake.clear()
            if self.stop.wait(SETTLE_SECONDS):
                break
            with self.cond:
                request, dirty = self.request, self.request_dirty
                self.request_dirty = False
                side = self.state.side_for(self.side_hint, request)
                new_lines = self.state.lines[self.fed:]
                self.fed = len(self.state.lines)
                position = Position(room=self.room, format=self.state.format or self.format, side=side,
                                    phase=self.state.phase(request), turn=self.state.turn, new_lines=list(new_lines),
                                    request=request, request_changed=dirty, analysis_mode=self.analysis_mode)
            try:
                analysis = self._analyse(position)
                result, error = analysis.to_dict(), None
            except Exception as exc:  # noqa: BLE001 — a model failure is reported, not fatal to the service
                result, error = None, f"{type(exc).__name__}: {exc}"
            with self.cond:
                if self.status == "closed":
                    break
                if error:
                    self.status, self.error = "error", error
                else:
                    self.analysis, self.error = result, None
                    self.status = "analysing" if self.wake.is_set() else "ready"
                self.revision += 1
                self.cond.notify_all()
        self._close_game()

    def _analyse(self, position: Position) -> Analysis:
        notes: list[str] = []
        if self.format_note:
            notes.append(self.format_note)
        if position.phase == "ended":
            return Analysis(phase="ended", turn=position.turn, side=position.side, notes=notes,
                            model=self.model.info().id, engine=self.engine.info().id)
        if position.side is None:
            notes.append("Join the battle as a player to get advice. Spectators have no private request.")
            return Analysis(phase=position.phase, turn=position.turn, notes=notes,
                            model=self.model.info().id, engine=self.engine.info().id)
        if self.game is None:
            self.game = self.model.open_game(self.engine, position.room, position.format, self.user)
        analysis = self.game.analyse(position)
        analysis.notes = [*notes, *analysis.notes]
        analysis.model, analysis.engine = self.model.info().id, self.engine.info().id
        return analysis


class SessionManager:
    def __init__(self, registry: Registry):
        self.registry = registry
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def create(self, owner: str, body: dict[str, Any]) -> Session:
        with self._lock:
            self._reap()
            mine = [s for s in self._sessions.values() if s.owner == owner and s.status != "closed"]
            if len(mine) >= MAX_ACTIVE_PER_USER:
                raise SessionError("Close an existing helper before opening another.", 429)
            session = Session(owner, body, self.registry)
            self._sessions[session.id] = session
            return session

    def get(self, owner: str, session_id: str) -> Session:
        with self._lock:
            session = self._sessions.get(session_id)
        if not session or session.owner != owner:
            raise SessionError("No such helper session.", 404)
        return session

    def close(self, owner: str, session_id: str) -> None:
        session = self.get(owner, session_id)
        session.close()
        with self._lock:
            self._sessions.pop(session_id, None)

    def close_all(self) -> None:
        with self._lock:
            sessions, self._sessions = list(self._sessions.values()), {}
        for s in sessions:
            s.close()

    def _reap(self) -> None:
        for sid in [sid for sid, s in self._sessions.items() if s.status == "closed"]:
            del self._sessions[sid]
