import json
import unittest

from stunfisk_plugin_common import Position
from stunfisk_plugin_helper.builtin import StunfiskEngine, StunfiskGame, StunfiskModel, default_registry


class FakePlayer:
    """Stands in for stunfisk_common.player.BattlePlayer: records lines, decides on a request."""

    def __init__(self, send, on_decision):
        self.send, self.on_decision, self.lines = send, on_decision, []

    def line(self, raw):
        self.lines.append(raw)
        if raw.startswith("|request|"):
            self.send("move 1 1, move 2 1", 7)
            self.on_decision({"choice": "move 1 1, move 2 1", "searched": False, "reason": "no sheet", "assumed": ["spread"]})


def position(**over):
    base = dict(room="battle-x-1", format="gen9vgc", side="p1", phase="turn", turn=1, new_lines=["|turn|1"],
                request={"active": [{}], "rqid": 7}, request_changed=True)
    return Position(**{**base, **over})


class StunfiskGameTest(unittest.TestCase):
    def game(self):
        return StunfiskGame(object(), "battle-x-1", "gen9vgc", "me", player_factory=FakePlayer)

    def test_lines_then_request_and_choice_is_recorded_not_sent(self):
        g = self.game()
        analysis = g.analyse(position())
        self.assertEqual(g.player.lines[0], "|turn|1")
        self.assertEqual(json.loads(g.player.lines[1][len("|request|"):]), {"active": [{}], "rqid": 7})
        self.assertEqual(analysis.recommended.choice, "move 1 1, move 2 1")
        self.assertIn("Assumed: spread", analysis.notes)
        self.assertTrue(any("fell back" in n for n in analysis.notes))

    def test_no_request_means_a_waiting_note(self):
        analysis = self.game().analyse(position(request=None, request_changed=False))
        self.assertIsNone(analysis.recommended)
        self.assertTrue(analysis.notes)

    def test_a_stale_choice_is_not_repeated(self):
        g = self.game()
        g.analyse(position())
        again = g.analyse(position(new_lines=[], request_changed=False))
        self.assertIsNone(again.recommended)


class RegistryTest(unittest.TestCase):
    def test_default_registry_names_and_unavailable_reasons(self):
        caps = default_registry().capabilities()
        self.assertEqual([m["id"] for m in caps["models"]], ["stunfisk"])
        self.assertEqual({e["id"] for e in caps["engines"]}, {"pscpp", "showdown"})
        for item in (*caps["models"], *caps["engines"]):
            self.assertTrue(item["available"] or item["reason"], item)

    def test_model_refuses_a_foreign_engine(self):
        from stunfisk_plugin_common import AdapterError, AdapterInfo, EngineAdapter

        class Other(EngineAdapter):
            def info(self):
                return AdapterInfo("o", "o")

        with self.assertRaises(AdapterError):
            StunfiskModel().open_game(Other(), "battle-x-1", "gen9vgc", "me")

    def test_supports(self):
        info = StunfiskModel().info()
        self.assertTrue(info.supports("[Gen 9] VGC 2026 Reg M-C"))
        self.assertFalse(info.supports("gen9ou"))


if __name__ == "__main__":
    unittest.main()
