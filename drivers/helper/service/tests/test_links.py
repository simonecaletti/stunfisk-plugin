import tempfile
import unittest
from pathlib import Path

from stunfisk_plugin_helper.links import LinkError, LinkStore, to_id


class LinkStoreTest(unittest.TestCase):
    def test_to_id_is_showdowns(self):
        self.assertEqual(to_id("Ash Ketchum_99"), "ashketchum99")
        self.assertEqual(to_id(""), "")

    def test_link_starts_unconfirmed_and_the_browser_confirms_it(self):
        s = LinkStore()
        self.assertIsNone(s.get("a@b.co"))
        self.assertEqual(s.set("a@b.co", "Ash Ketchum"), {"name": "Ash Ketchum", "confirmed": False})
        self.assertEqual(s.seen("a@b.co", "ash ketchum")["match"], True)  # same Showdown id
        self.assertEqual(s.get("a@b.co"), {"name": "Ash Ketchum", "confirmed": True})

    def test_a_different_name_does_not_confirm(self):
        s = LinkStore()
        s.set("a@b.co", "Ash")
        r = s.seen("a@b.co", "Gary")
        self.assertEqual((r["match"], r["confirmed"]), (False, False))
        self.assertFalse(s.get("a@b.co")["confirmed"])

    def test_seen_without_a_link_links_nothing(self):
        s = LinkStore()
        self.assertEqual(s.seen("a@b.co", "Ash"), {"linked": False, "match": False, "confirmed": False})
        self.assertIsNone(s.get("a@b.co"))

    def test_relinking_resets_confirmation(self):
        s = LinkStore()
        s.set("a@b.co", "Ash")
        s.seen("a@b.co", "Ash")
        self.assertFalse(s.set("a@b.co", "Misty")["confirmed"])

    def test_accounts_are_separate(self):
        s = LinkStore()
        s.set("a@b.co", "Ash")
        s.set("c@d.co", "Ash")
        s.seen("a@b.co", "Ash")
        self.assertTrue(s.get("a@b.co")["confirmed"])
        self.assertFalse(s.get("c@d.co")["confirmed"])  # a claim by someone else is not confirmed by this browser

    def test_bad_names(self):
        s = LinkStore()
        for bad in ("", " ", "x" * 19, "bad|name", "<b>", "Guest 1234", "guest"):
            with self.assertRaises(LinkError, msg=bad):
                s.set("a@b.co", bad)

    def test_unlink(self):
        s = LinkStore()
        s.set("a@b.co", "Ash")
        s.clear("a@b.co")
        s.clear("a@b.co")  # harmless twice
        self.assertIsNone(s.get("a@b.co"))

    def test_persists_with_owner_only_permissions(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "state" / "links.json"
            LinkStore(path).set("a@b.co", "Ash")
            self.assertEqual(LinkStore(path).get("a@b.co"), {"name": "Ash", "confirmed": False})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_a_damaged_file_starts_empty(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "links.json"
            path.write_text("{not json")
            self.assertIsNone(LinkStore(path).get("a@b.co"))


if __name__ == "__main__":
    unittest.main()
