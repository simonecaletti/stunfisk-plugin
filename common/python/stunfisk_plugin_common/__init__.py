"""Interfaces shared by every part of the Stunfisk plugin."""

from .adapters import (AdapterError, AdapterInfo, EngineAdapter, ModelAdapter, ModelGame, Position, Registry)
from .helper_protocol import API_VERSION, PHASES, Analysis, Choice
from .settings import ANALYSIS_MODES, DEFAULT_LOCAL_URL, RUN_MODES, Settings

__all__ = ["ANALYSIS_MODES", "API_VERSION", "DEFAULT_LOCAL_URL", "PHASES", "RUN_MODES", "AdapterError", "AdapterInfo",
           "Analysis", "Choice", "EngineAdapter", "ModelAdapter", "ModelGame", "Position", "Registry", "Settings"]
