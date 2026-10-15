import unittest

from stunfisk_plugin_helper.auth import AuthError, AuthService
from stunfisk_plugin_helper.mailers import Mailer


class Capture(Mailer):
    def __init__(self):
        self.sent = []

    def send_code(self, email, code, minutes):
        self.sent.append((email, code))


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class AuthTest(unittest.TestCase):
    def setUp(self):
        self.mail, self.clock = Capture(), Clock()
        self.auth = AuthService(self.mail, b"k" * 32, clock=self.clock)

    def test_round_trip(self):
        self.auth.request_code("Me@Example.com ")
        email, code = self.mail.sent[0]
        self.assertEqual(email, "me@example.com")
        self.assertRegex(code, r"^\d{6}$")
        result = self.auth.verify("me@example.com", code)
        self.assertEqual(self.auth.authenticate(result["token"]), "me@example.com")

    def test_code_is_single_use(self):
        self.auth.request_code("a@b.co")
        code = self.mail.sent[0][1]
        self.auth.verify("a@b.co", code)
        with self.assertRaises(AuthError):
            self.auth.verify("a@b.co", code)

    def test_wrong_code_and_attempt_limit(self):
        self.auth.request_code("a@b.co")
        code = self.mail.sent[0][1]
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(5):
            with self.assertRaises(AuthError):
                self.auth.verify("a@b.co", wrong)
        with self.assertRaises(AuthError):  # the right code no longer works
            self.auth.verify("a@b.co", code)

    def test_code_expires(self):
        self.auth.request_code("a@b.co")
        self.clock.t += 601
        with self.assertRaises(AuthError):
            self.auth.verify("a@b.co", self.mail.sent[0][1])

    def test_token_expires_and_tampering_fails(self):
        self.auth.request_code("a@b.co")
        token = self.auth.verify("a@b.co", self.mail.sent[0][1])["token"]
        self.assertIsNone(self.auth.authenticate(token[:-1] + ("0" if token[-1] != "0" else "1")))
        self.assertIsNone(self.auth.authenticate(None))
        self.assertIsNone(self.auth.authenticate("garbage"))
        self.clock.t += 31 * 86400
        self.assertIsNone(self.auth.authenticate(token))

    def test_token_from_another_secret_fails(self):
        self.auth.request_code("a@b.co")
        token = self.auth.verify("a@b.co", self.mail.sent[0][1])["token"]
        self.assertIsNone(AuthService(Capture(), b"z" * 32, clock=self.clock).authenticate(token))

    def test_rate_limits(self):
        self.auth.request_code("a@b.co")
        with self.assertRaises(AuthError) as ctx:
            self.auth.request_code("a@b.co")
        self.assertEqual(ctx.exception.status, 429)
        for _ in range(4):
            self.clock.t += 31
            self.auth.request_code("a@b.co")
        self.clock.t += 31
        with self.assertRaises(AuthError):
            self.auth.request_code("a@b.co")

    def test_allow_list_sends_nothing_but_answers_the_same(self):
        auth = AuthService(self.mail, b"k" * 32, allowed={"ok@b.co"}, clock=self.clock)
        auth.request_code("stranger@b.co")
        self.assertEqual(self.mail.sent, [])
        auth.request_code("ok@b.co")
        self.assertEqual(len(self.mail.sent), 1)

    def test_bad_address(self):
        with self.assertRaises(AuthError):
            self.auth.request_code("not-an-email")


if __name__ == "__main__":
    unittest.main()
