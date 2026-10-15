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
        self.assertEqual(self.c.call("GET", "/v1/me")[1], {"email": "me@example.com", "username": None, "showdown": None})
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


    def raw(self, path):
        req = urllib.request.Request(self.c.base + path)
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode(), r.headers

    def test_landing_page_is_public_and_locked_down(self):
        import base64, hashlib, re
        status, body, headers = self.raw("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertIn("Stunfisk Coach", body)
        policy = headers["Content-Security-Policy"]
        self.assertIn("default-src 'none'", policy)
        self.assertIn("frame-ancestors 'none'", policy)
        # the policy allows exactly the page's own inline style and script, and nothing else inline
        for tag in ("style", "script"):
            text = re.search(rf"<{tag}>(.*?)</{tag}>", body, re.S).group(1)
            digest = "'sha256-" + base64.b64encode(hashlib.sha256(text.encode()).digest()).decode() + "'"
            self.assertIn(f"{tag}-src {digest}", policy)
        self.assertEqual(body.count("<script"), 1)
        self.assertNotIn("http://", body.replace("http://www.w3.org", ""))  # no outside resources
        self.assertEqual(self.raw("/index.html")[0], 200)

    def test_status_is_public_but_brief(self):
        status, body, _ = self.raw("/v1/status")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(data["signin"], "console")
        self.assertEqual([m["id"] for m in data["models"]], ["fake"])
        self.assertEqual({e["id"]: e["available"] for e in data["engines"]}, {"fake": True, "down": False})
        for item in (*data["models"], *data["engines"]):
            self.assertEqual(set(item), {"id", "name", "available"})  # no reasons, no formats
        self.assertNotIn("not built", body)

    def test_everything_else_still_needs_sign_in(self):
        for path in ("/v1/me", "/v1/capabilities", "/anything-else"):
            self.assertEqual(self.c.call("GET", path)[0], 401, path)


    def test_link_a_showdown_name_and_let_the_browser_confirm_it(self):
        self.sign_in()
        self.assertEqual(self.c.call("PUT", "/v1/me/showdown", {"name": "Ash Ketchum"})[1], {"name": "Ash Ketchum", "confirmed": False})
        self.assertEqual(self.c.call("GET", "/v1/me")[1]["showdown"], {"name": "Ash Ketchum", "confirmed": False})
        self.assertEqual(self.c.call("POST", "/v1/me/showdown/seen", {"name": "Gary"})[1]["match"], False)
        self.assertEqual(self.c.call("POST", "/v1/me/showdown/seen", {"name": "ashketchum"})[1]["confirmed"], True)
        self.assertEqual(self.c.call("GET", "/v1/me")[1]["showdown"]["confirmed"], True)
        self.assertEqual(self.c.call("DELETE", "/v1/me/showdown")[0], 204)
        self.assertIsNone(self.c.call("GET", "/v1/me")[1]["showdown"])

    def test_link_validation_and_sign_in_requirement(self):
        self.assertEqual(self.c.call("PUT", "/v1/me/showdown", {"name": "Ash"})[0], 401)
        self.sign_in()
        self.assertEqual(self.c.call("PUT", "/v1/me/showdown", {"name": "bad|name"})[0], 400)
        self.assertEqual(self.c.call("PUT", "/v1/me/showdown", {})[0], 400)

    def test_links_belong_to_their_account(self):
        self.sign_in("a@example.com")
        self.c.call("PUT", "/v1/me/showdown", {"name": "Ash"})
        self.sign_in("b@example.com")
        self.assertIsNone(self.c.call("GET", "/v1/me")[1]["showdown"])

    def test_current_game_is_the_one_last_fed_and_knows_whether_it_is_the_linked_account(self):
        self.sign_in()
        self.assertEqual(self.c.call("GET", "/v1/helper/current")[1], {"session": None, "showdown": None})
        self.c.call("PUT", "/v1/me/showdown", {"name": "Alice"})
        first = self.create(room="battle-gen9vgc-1", user="Alice")[1]["id"]
        second = self.create(room="battle-gen9vgc-2", user="Alice")[1]["id"]
        self.c.call("POST", f"/v1/helper/sessions/{first}/events", {"from": 0, "lines": ["|turn|1"], "side": "p1"})
        wait_for(self.c, first, lambda v: v["analysis"] is not None)
        self.assertEqual(self.c.call("GET", "/v1/helper/current")[1]["session"]["room"], "battle-gen9vgc-1")
        time.sleep(0.02)
        self.c.call("POST", f"/v1/helper/sessions/{second}/events", {"from": 0, "lines": ["|turn|1"], "side": "p2"})
        view = wait_for(self.c, second, lambda v: v["analysis"] is not None)
        current = self.c.call("GET", "/v1/helper/current")[1]
        self.assertEqual(current["session"]["room"], "battle-gen9vgc-2")
        self.assertEqual((current["session"]["side"], current["session"]["player"], current["session"]["linked"]), ("p2", "Alice", True))
        self.assertEqual(current["session"]["analysis"]["recommended"]["choice"], "move 1, move 2")
        self.assertEqual(current["showdown"], {"name": "Alice", "confirmed": False})

    def test_someone_elses_game_is_not_the_linked_account(self):
        self.sign_in()
        self.c.call("PUT", "/v1/me/showdown", {"name": "Alice"})
        sid = self.create(user="Bob")[1]["id"]
        self.c.call("POST", f"/v1/helper/sessions/{sid}/events", {"from": 0, "lines": ["|turn|1"], "side": "p1"})
        wait_for(self.c, sid, lambda v: v["analysis"] is not None)
        self.assertFalse(self.c.call("GET", "/v1/helper/current")[1]["session"]["linked"])

    def test_watching_the_current_game_does_not_keep_it_alive_but_closing_ends_it(self):
        self.sign_in()
        sid = self.create()[1]["id"]
        self.assertEqual(self.c.call("GET", "/v1/helper/current")[1]["session"]["id"], sid)
        self.c.call("DELETE", f"/v1/helper/sessions/{sid}")
        self.assertIsNone(self.c.call("GET", "/v1/helper/current")[1]["session"])


class UsernameServerTest(unittest.TestCase):
    """Signing in with a Showdown name, proved by the browser. Only on a service that turns it on."""

    def make(self, enabled):
        registry = Registry()
        registry.add_model(FakeModel())
        registry.add_engine(FakeEngine())
        self.mail = Capture()
        server = make_server("127.0.0.1", 0, AuthService(self.mail, b"s" * 32, min_interval=0, max_per_hour=100), registry,
                             username_login=enabled)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (server.sessions.close_all(), server.shutdown(), server.server_close()))
        return Client(f"http://127.0.0.1:{server.server_address[1]}")

    def test_status_says_whether_it_is_on(self):
        self.assertTrue(self.make(True).call("GET", "/v1/status")[1]["username_login"])
        self.assertFalse(self.make(False).call("GET", "/v1/status")[1]["username_login"])

    def test_off_means_off(self):
        c = self.make(False)
        for method, path, body in (("POST", "/v1/auth/username/start", {"username": "Ash"}),
                                   ("POST", "/v1/auth/username/approve", {"name": "Ash"}),
                                   ("GET", "/v1/auth/username/poll?request=abcd", None)):
            self.assertEqual(c.call(method, path, body)[0], 404, path)

    def test_page_and_browser_sign_in_together_and_the_link_is_confirmed(self):
        c = self.make(True)
        status, started, _ = c.call("POST", "/v1/auth/username/start", {"username": "Ash Ketchum"})
        self.assertEqual(status, 200)
        rid = started["request"]
        self.assertEqual(c.call("GET", f"/v1/auth/username/poll?request={rid}")[1], {"status": "pending", "name": "Ash Ketchum"})
        # the extension, in a browser logged in as that name
        status, approved, _ = c.call("POST", "/v1/auth/username/approve", {"name": "Ash Ketchum"})
        self.assertEqual(status, 200)
        self.assertTrue(approved["token"])
        # the page collects its own token
        status, got, _ = c.call("GET", f"/v1/auth/username/poll?request={rid}")
        self.assertEqual((status, got["status"], got["name"]), (200, "approved", "Ash Ketchum"))
        self.assertTrue(got["token"])
        self.assertEqual(c.call("GET", f"/v1/auth/username/poll?request={rid}")[1], {"status": "expired"})
        # both tokens are the same account, signed in and already linked and confirmed
        for token in (approved["token"], got["token"]):
            c.token = token
            me = c.call("GET", "/v1/me")[1]
            self.assertEqual((me["email"], me["username"], me["showdown"]), (None, "Ash Ketchum", {"name": "Ash Ketchum", "confirmed": True}))
        self.assertEqual(c.call("GET", "/v1/capabilities")[0], 200)

    def test_approving_with_nobody_asking_gives_nothing(self):
        c = self.make(True)
        status, body, _ = c.call("POST", "/v1/auth/username/approve", {"name": "Ash"})
        self.assertEqual(status, 404)
        self.assertNotIn("token", body)

    def test_a_different_name_cannot_approve(self):
        c = self.make(True)
        c.call("POST", "/v1/auth/username/start", {"username": "Ash"})
        self.assertEqual(c.call("POST", "/v1/auth/username/approve", {"name": "Gary"})[0], 404)

    def test_bad_and_guest_names_are_refused(self):
        c = self.make(True)
        for bad in ("", "bad|name", "Guest 123"):
            self.assertEqual(c.call("POST", "/v1/auth/username/start", {"username": bad})[0], 400, bad)
            self.assertEqual(c.call("POST", "/v1/auth/username/approve", {"name": bad})[0], 400, bad)

    def test_a_name_account_cannot_relink_or_unlink_itself(self):
        c = self.make(True)
        rid = c.call("POST", "/v1/auth/username/start", {"username": "Ash"})[1]["request"]
        c.token = c.call("POST", "/v1/auth/username/approve", {"name": "Ash"})[1]["token"]
        self.assertEqual(c.call("PUT", "/v1/me/showdown", {"name": "Gary"})[0], 400)
        self.assertEqual(c.call("DELETE", "/v1/me/showdown")[0], 400)
        self.assertEqual(c.call("GET", "/v1/me")[1]["showdown"]["name"], "Ash")
        self.assertEqual(c.call("POST", "/v1/me/showdown/seen", {"name": "Ash"})[0], 200)
        del rid

    def test_a_name_account_can_use_the_helper_and_is_the_linked_player(self):
        c = self.make(True)
        c.call("POST", "/v1/auth/username/start", {"username": "Alice"})
        c.token = c.call("POST", "/v1/auth/username/approve", {"name": "Alice"})[1]["token"]
        body = {"room": "battle-gen9vgc-1", "format": "gen9vgc", "model": "fake", "engine": "fake", "analysis_mode": "fast", "user": "Alice"}
        sid = c.call("POST", "/v1/helper/sessions", body)[1]["id"]
        c.call("POST", f"/v1/helper/sessions/{sid}/events", {"from": 0, "lines": ["|turn|1"], "side": "p1"})
        wait_for(c, sid, lambda v: v["analysis"] is not None)
        session = c.call("GET", "/v1/helper/current")[1]["session"]
        self.assertEqual((session["player"], session["linked"]), ("Alice", True))

    def test_an_email_cannot_pose_as_a_name_account(self):
        c = self.make(True)
        status, _, _ = c.call("POST", "/v1/auth/request", {"email": "showdown:ash@example.com"})
        self.assertEqual(status, 400)
        self.assertEqual(self.mail.sent, [])


if __name__ == "__main__":
    unittest.main()
