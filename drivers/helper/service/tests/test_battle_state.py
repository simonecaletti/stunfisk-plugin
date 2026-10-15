import unittest

from stunfisk_plugin_helper.battle_state import BattleState

PREVIEW = ["|player|p1|Alice|1|", "|player|p2|Bob|2|", "|tier|[Gen 9] VGC 2026 Reg M-C", "|poke|p1|Garchomp, L50, M|",
           "|poke|p1|Incineroar, L50, F|", "|poke|p2|Dragonite, L50|", "|teampreview|4"]


class BattleStateTest(unittest.TestCase):
    def test_reads_format_players_teams(self):
        s = BattleState()
        s.append(PREVIEW)
        self.assertEqual(s.format, "[Gen 9] VGC 2026 Reg M-C")
        self.assertEqual(s.players, {"p1": "Alice", "p2": "Bob"})
        self.assertEqual(s.teams["p1"], ["Garchomp", "Incineroar"])
        self.assertTrue(s.preview)

    def test_chat_is_dropped_but_still_counted(self):
        s = BattleState()
        s.append(["|c|Alice|hi", "|j|Bob", "|turn|1"])
        self.assertEqual(s.received, 3)
        self.assertEqual(s.lines, ["|turn|1"])

    def test_triggers(self):
        s = BattleState()
        self.assertFalse(s.append(["|player|p1|Alice|1|"]))
        self.assertTrue(s.append(["|teampreview|4"]))
        self.assertTrue(s.append(["|turn|1"]))
        self.assertFalse(s.append(["|move|p1a: Garchomp|Earthquake|p2a: Dragonite"]))
        self.assertTrue(s.append(["|move|p1a: Incineroar|U-turn|p2a: Dragonite"]))
        self.assertTrue(s.append(["|-enditem|p1a: X|Eject Button"]))
        self.assertTrue(s.append(["|faint|p2a: Dragonite"]))

    def test_phase(self):
        s = BattleState()
        self.assertEqual(s.phase(None), "waiting")
        s.append(PREVIEW)
        self.assertEqual(s.phase({"teamPreview": True, "side": {"id": "p1"}}), "preview")
        s.append(["|turn|1"])
        self.assertEqual(s.phase({"active": [{}, {}]}), "turn")
        self.assertEqual(s.phase({"wait": True}), "waiting")
        self.assertEqual(s.phase({"forceSwitch": [True, False]}), "switch")
        self.assertEqual(s.phase({"forceSwitch": [False, False]}), "turn")
        s.append(["|win|Alice"])
        self.assertEqual(s.phase({"active": [{}]}), "ended")
        self.assertEqual(s.winner, "Alice")

    def test_tie_ends(self):
        s = BattleState()
        s.append(["|tie"])
        self.assertTrue(s.ended)

    def test_side(self):
        s = BattleState()
        self.assertEqual(s.side_for("p2", None), "p2")
        self.assertEqual(s.side_for(None, {"side": {"id": "p1"}}), "p1")
        self.assertIsNone(s.side_for(None, None))
        self.assertIsNone(s.side_for("bogus", {"side": {"id": "p9"}}))


if __name__ == "__main__":
    unittest.main()
