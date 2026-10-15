import unittest

from stunfisk_plugin_helper.usernames import UsernameError, UsernameLogin, check_name, is_username_subject, subject_for


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class UsernameLoginTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.u = UsernameLogin(clock=self.clock)

    def test_page_asks_browser_approves_page_collects_once(self):
        rid = self.u.start("Ash Ketchum")
        self.assertEqual(self.u.poll(rid), {"status": "pending", "name": "Ash Ketchum"})
        self.assertEqual(self.u.approve("ash ketchum"), "ash ketchum")  # Showdown ignores case and spaces
        self.assertEqual(self.u.poll(rid), {"status": "approved", "name": "ash ketchum"})
        self.assertEqual(self.u.poll(rid), {"status": "expired"})  # one use

    def test_approval_needs_a_request_for_that_name(self):
        self.assertIsNone(self.u.approve("Ash"))
        self.u.start("Misty")
        self.assertIsNone(self.u.approve("Ash"))

    def test_requests_expire(self):
        rid = self.u.start("Ash")
        self.clock.t += 301
        self.assertEqual(self.u.poll(rid), {"status": "expired"})
        self.assertIsNone(self.u.approve("Ash"))

    def test_limits(self):
        for _ in range(5):
            self.u.start("Ash")
        with self.assertRaises(UsernameError) as ctx:
            self.u.start("Ash")
        self.assertEqual(ctx.exception.status, 429)
        small = UsernameLogin(clock=self.clock, max_pending=2)
        small.start("A1")
        small.start("B2")
        with self.assertRaises(UsernameError):
            small.start("C3")

    def test_names_are_checked(self):
        for bad in ("", "x" * 19, "bad|name", "<b>", "Guest 12", "guest"):
            with self.assertRaises(UsernameError, msg=bad):
                check_name(bad)
            with self.assertRaises(UsernameError, msg=bad):
                self.u.start(bad)
        self.assertEqual(check_name("  Ash  "), "Ash")

    def test_subjects_cannot_be_confused_with_emails(self):
        self.assertEqual(subject_for("Ash Ketchum"), "showdown:ashketchum")
        self.assertTrue(is_username_subject("showdown:ashketchum"))
        self.assertFalse(is_username_subject("me@example.com"))


if __name__ == "__main__":
    unittest.main()
