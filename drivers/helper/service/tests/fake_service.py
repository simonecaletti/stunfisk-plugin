"""A real helper service with a fake model, for the client's end-to-end test. Prints ``PORT <n>`` then each sign-in code.

    PYTHONPATH=... python3 fake_service.py
"""

import sys
import threading

from stunfisk_plugin_common import AdapterInfo, Analysis, Choice, EngineAdapter, ModelAdapter, ModelGame, Registry
from stunfisk_plugin_helper.auth import AuthService
from stunfisk_plugin_helper.mailers import Mailer
from stunfisk_plugin_helper.server import make_server


class PrintMailer(Mailer):
    def send_code(self, email, code, minutes):
        print(f"CODE {email} {code}", flush=True)


class Engine(EngineAdapter):
    def info(self):
        return AdapterInfo("fake", "Fake engine")


class Game(ModelGame):
    def __init__(self):
        self.lines = 0

    def analyse(self, position):
        self.lines += len(position.new_lines)
        pick = Choice(f"Play after {self.lines} lines", "move 1, move 1", win=0.55)
        return Analysis(phase=position.phase, turn=position.turn, side=position.side, recommended=pick, choices=[pick], win=0.55)


class Model(ModelAdapter):
    def info(self):
        return AdapterInfo("fake", "Fake model")

    def open_game(self, engine, room, format_id, user):
        return Game()


registry = Registry()
registry.add_model(Model())
registry.add_engine(Engine())
server = make_server("127.0.0.1", 0, AuthService(PrintMailer(), b"e" * 32, min_interval=0, max_per_hour=1000), registry,
                     origins=("https://play.pokemonshowdown.com",))
print(f"PORT {server.server_address[1]}", flush=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
sys.stdin.read()  # the test closes stdin to stop us
server.sessions.close_all()
