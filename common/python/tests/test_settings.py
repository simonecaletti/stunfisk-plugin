import json
import unittest
from pathlib import Path

from stunfisk_plugin_common import Settings

SCHEMA = json.loads((Path(__file__).parents[2] / "schema" / "settings.schema.json").read_text())


class SettingsTest(unittest.TestCase):
    def test_defaults_are_valid_and_local(self):
        s = Settings()
        self.assertEqual(s.problems(), [])
        self.assertEqual(s.service_url(), "http://127.0.0.1:8787")

    def test_defaults_match_the_schema(self):
        self.assertEqual(set(Settings().to_dict()), set(SCHEMA["properties"]))
        for key, value in Settings().to_dict().items():
            default = SCHEMA["properties"][key].get("default")
            if default is not None:
                self.assertEqual(value, default, key)

    def test_local_must_stay_on_this_computer(self):
        self.assertTrue(Settings(local_url="http://example.com:8787").problems())
        self.assertEqual(Settings(local_url="http://localhost:9000/").service_url(), "http://localhost:9000")

    def test_remote_needs_https(self):
        self.assertTrue(Settings(run_mode="remote", remote_url="").problems())
        self.assertTrue(Settings(run_mode="remote", remote_url="http://svc.example.com").problems())
        ok = Settings(run_mode="remote", remote_url="https://svc.example.com/")
        self.assertEqual(ok.service_url(), "https://svc.example.com")

    def test_credentials_in_a_url_are_refused(self):
        self.assertTrue(Settings(run_mode="remote", remote_url="https://a:b@svc.example.com").problems())

    def test_bad_values(self):
        for bad in (Settings(email="nope"), Settings(model="Bad Name"), Settings(engine=""),
                    Settings(run_mode="cloud"), Settings(analysis_mode="slow")):
            self.assertTrue(bad.problems(), bad)
        with self.assertRaises(ValueError):
            Settings(run_mode="cloud").service_url()

    def test_from_dict_ignores_unknown_and_non_string(self):
        s = Settings.from_dict({"model": "x", "evil": "y", "engine": 3})
        self.assertEqual((s.model, s.engine), ("x", "pscpp"))


if __name__ == "__main__":
    unittest.main()
