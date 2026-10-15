import json
import threading
import time
import unittest
import urllib.error
import urllib.request

from stunfisk_plugin_common import (AdapterInfo, Analysis, Choice, EngineAdapter, ModelAdapter, ModelGame, Registry)
from stunfisk_plugin_helper.auth import AuthService
from stunfisk_plugin_helper.mailers import Mailer
from stunfisk_plugin_helper.server import make_server


class Capture(Mailer):
    def __init__(self):
        self.sent = []

    def send_code(self, email, code, minutes):
        self.sent.append((email, code))


class FakeEngine(EngineAdapter):
    def __init__(self, id="fake", available=True):
        self.id, self.available = id, available

    def info(self):
        return AdapterInfo(self.id, "Fake engine", available=self.available, reason="" if self.available else "not built")


class FakeGame(ModelGame):
    def __init__(self, fail=False):
        self.positions, self.closed, self.fail = [], False, fail

    def analyse(self, position):
        if self.fail:
            raise RuntimeError("boom")
        self.positions.append(position)
        pick = Choice("Earthquake", "move 1, move 2", win=0.6)
        return Analysis(phase=position.phase, turn=position.turn, side=position.side, recommended=pick, choices=[pick],
                        win=0.6, notes=[])

    def close(self):
        self.closed = True


class FakeModel(ModelAdapter):
    def __init__(self):
        self.games, self.fail = [], False

    def info(self):
        return AdapterInfo("fake", "Fake model", formats=("vgc",))

    def open_game(self, engine, room, format_id, user):
        game = FakeGame(self.fail)
        self.games.append(game)
        return game


class Client:
    def __init__(self, base):
        self.base, self.token = base, None

    def call(self, method, path, body=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None), r.headers
        except urllib.error.HTTPError as e:
            raw = e.read()
            return e.code, (json.loads(raw) if raw else None), e.headers


def wait_for(client, sid, pred, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        _, view, _ = client.call("GET", f"/v1/helper/sessions/{sid}")
        if pred(view):
            return view
        time.sleep(0.05)
    raise AssertionError(f"timed out; last view {view}")


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.mail = Capture()
        self.model = FakeModel()
        registry = Registry()
        registry.add_model(self.model)
        registry.add_engine(FakeEngine())
        registry.add_engine(FakeEngine("down", available=False))
        self.server = make_server("127.0.0.1", 0, AuthService(self.mail, b"s" * 32, min_interval=0, max_per_hour=100), registry)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.c = Client(f"http://127.0.0.1:{self.server.server_address[1]}")

    def tearDown(self):
        self.server.sessions.close_all()
        self.server.shutdown()
        self.server.server_close()

    def sign_in(self, email="me@example.com"):
        self.assertEqual(self.c.call("POST", "/v1/auth/request", {"email": email})[0], 202)
        status, body, _ = self.c.call("POST", "/v1/auth/verify", {"email": email, "code": self.mail.sent[-1][1]})
        self.assertEqual(status, 200)
        self.c.token = body["token"]

    def create(self, **over):
        body = {"room": "battle-gen9vgc2026regmc-1", "format": "gen9vgc2026regmc", "model": "fake", "engine": "fake",
                "analysis_mode": "fast", **over}
        return self.c.call("POST", "/v1/helper/sessions", body)

    def test_needs_sign_in(self):
        self.assertEqual(self.c.call("GET", "/v1/health")[0], 200)
        for method, path in (("GET", "/v1/me"), ("GET", "/v1/capabilities"), ("POST", "/v1/helper/sessions")):
            self.assertEqual(self.c.call(method, path, {} if method == "POST" else None)[0], 401, path)

    def test_sign_in_and_capabilities(self):
        self.sign_in()
        self.assertEqual(self.c.call("GET", "/v1/me")[1], {"email": "me@example.com"})
        caps = self.c.call("GET", "/v1/capabilities")[1]
        self.assertEqual([m["id"] for m in caps["models"]], ["fake"])
        self.assertEqual({e["id"]: e["available"] for e in caps["engines"]}, {"fake": True, "down": False})

    def test_wrong_code(self):
        self.c.call("POST", "/v1/auth/request", {"email": "me@example.com"})
        self.assertEqual(self.c.call("POST", "/v1/auth/verify", {"email": "me@example.com", "code": "x"})[0], 401)

    def test_full_flow_reads_the_battle_in_increments(self):
        self.sign_in()
        status, view, _ = self.create()
        self.assertEqual(status, 201)
        sid = view["id"]
        preview = ["|player|p1|Alice|1|", "|c|Alice|gl", "|tier|[Gen 9] VGC", "|poke|p1|Garchomp, L50|", "|teampreview|4"]
        request = {"teamPreview": True, "side": {"id": "p1", "pokemon": []}}
        status, ack, _ = self.c.call("POST", f"/v1/helper/sessions/{sid}/events", {"from": 0, "lines": preview, "request": request})
        self.assertEqual((status, ack["lines"]), (200, 5))
        view = wait_for(self.c, sid, lambda v: v["analysis"] is not None)
        self.assertEqual(view["analysis"]["phase"], "preview")
        self.assertEqual(view["analysis"]["side"], "p1")
        self.assertEqual(view["analysis"]["recommended"]["choice"], "move 1, move 2")
        self.assertEqual((view["analysis"]["model"], view["analysis"]["engine"]), ("fake", "fake"))
        game = self.model.games[0]
        self.assertEqual(game.positions[0].new_lines[0], "|player|p1|Alice|1|")
        self.assertNotIn("|c|Alice|gl", game.positions[0].new_lines)  # chat never reaches the model
        # a later packet: only the new lines arrive, the game keeps its history
        self.c.call("POST", f"/v1/helper/sessions/{sid}/events", {"from": 5, "lines": ["|turn|1"], "request": {"active": [{}], "side": {"id": "p1"}}})
        view = wait_for(self.c, sid, lambda v: v["analysis"] and v["analysis"]["phase"] == "turn")
        self.assertEqual(game.positions[-1].new_lines, ["|turn|1"])
        self.assertEqual(len(self.model.games), 1)

    def test_resync_on_mismatch(self):
        self.sign_in()
        sid = self.create()[1]["id"]
        self.c.call("POST", f"/v1/helper/sessions/{sid}/events", {"from": 0, "lines": ["|turn|1"]})
        status, body, _ = self.c.call("POST", f"/v1/helper/sessions/{sid}/events", {"from": 0, "lines": ["|turn|1"]})
        self.assertEqual((status, body["have"]), (409, 1))

    def test_spectator_gets_a_note_not_advice(self):
        self.sign_in()
        sid = self.create()[1]["id"]
        self.c.call("POST", f"/v1/helper/sessions/{sid}/events", {"from": 0, "lines": ["|turn|1"]})
        view = wait_for(self.c, sid, lambda v: v["analysis"] is not None)
        self.assertIsNone(view["analysis"]["recommended"])
        self.assertIn("Join the battle as a player", view["analysis"]["notes"][0])
        self.assertEqual(self.model.games, [])

    def test_unsupported_format_is_noted(self):
        self.sign_in()
        sid = self.create(format="gen9ou")[1]["id"]
        self.c.call("POST", f"/v1/helper/sessions/{sid}/events", {"from": 0, "lines": ["|turn|1"], "side": "p1"})
        view = wait_for(self.c, sid, lambda v: v["analysis"] is not None)
        self.assertIn("not trained for gen9ou", view["analysis"]["notes"][0])

    def test_ended_battle(self):
        self.sign_in()
        sid = self.create()[1]["id"]
        self.c.call("POST", f"/v1/helper/sessions/{sid}/events", {"from": 0, "lines": ["|turn|3", "|win|Alice"], "side": "p1"})
        view = wait_for(self.c, sid, lambda v: v["analysis"] is not None)
        self.assertEqual(view["analysis"]["phase"], "ended")

    def test_model_error_is_reported_and_recovers(self):
        self.sign_in()
        self.model.fail = True
        sid = self.create()[1]["id"]
        self.c.call("POST", f"/v1/helper/sessions/{sid}/events", {"from": 0, "lines": ["|turn|1"], "side": "p1"})
        view = wait_for(self.c, sid, lambda v: v["status"] == "error")
        self.assertIn("boom", view["error"])

    def test_create_validation(self):
        self.sign_in()
        self.assertEqual(self.create(room="lobby")[0], 400)
        self.assertEqual(self.create(analysis_mode="slow")[0], 400)
        self.assertEqual(self.create(model="nope")[0], 422)
        self.assertEqual(self.create(engine="down")[0], 422)

    def test_limit_and_close(self):
        self.sign_in()
        ids = [self.create()[1]["id"] for _ in range(4)]
        self.assertEqual(self.create()[0], 429)
        self.assertEqual(self.c.call("DELETE", f"/v1/helper/sessions/{ids[0]}")[0], 204)
        self.assertEqual(self.c.call("GET", f"/v1/helper/sessions/{ids[0]}")[0], 404)
        self.assertEqual(self.create()[0], 201)

    def test_sessions_are_private_to_their_owner(self):
        self.sign_in("a@example.com")
        sid = self.create()[1]["id"]
        self.sign_in("b@example.com")
        self.assertEqual(self.c.call("GET", f"/v1/helper/sessions/{sid}")[0], 404)
        self.assertEqual(self.c.call("POST", f"/v1/helper/sessions/{sid}/events", {"from": 0, "lines": []})[0], 404)

    def test_closing_releases_the_model_game(self):
        self.sign_in()
        sid = self.create()[1]["id"]
        self.c.call("POST", f"/v1/helper/sessions/{sid}/events", {"from": 0, "lines": ["|turn|1"], "side": "p1"})
        wait_for(self.c, sid, lambda v: v["analysis"] is not None)
        self.c.call("DELETE", f"/v1/helper/sessions/{sid}")
        self.assertTrue(self.model.games[0].closed)

    def test_cors(self):
        ok = {"Origin": "https://play.pokemonshowdown.com", "Access-Control-Request-Private-Network": "true"}
        _, _, h = self.c.call("OPTIONS", "/v1/me", headers=ok)
        self.assertEqual(h["Access-Control-Allow-Origin"], "https://play.pokemonshowdown.com")
        self.assertEqual(h["Access-Control-Allow-Private-Network"], "true")
        _, _, h = self.c.call("OPTIONS", "/v1/me", headers={"Origin": "https://evil.example"})
        self.assertIsNone(h["Access-Control-Allow-Origin"])

    def test_long_poll_wakes_on_new_revision(self):
        self.sign_in()
        sid = self.create()[1]["id"]
        threading.Timer(0.3, lambda: self.c.call("POST", f"/v1/helper/sessions/{sid}/events", {"from": 0, "lines": ["|turn|1"], "side": "p1"})).start()
        start = time.time()
        _, view, _ = self.c.call("GET", f"/v1/helper/sessions/{sid}?after=0&wait=5")
        self.assertGreater(view["revision"], 0)
        self.assertLess(time.time() - start, 4)


if __name__ == "__main__":
    unittest.main()
