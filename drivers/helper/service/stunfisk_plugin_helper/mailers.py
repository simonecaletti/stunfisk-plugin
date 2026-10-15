"""How a sign-in code reaches the user's inbox."""

from __future__ import annotations

import smtplib
import ssl
import sys
from abc import ABC, abstractmethod
from email.message import EmailMessage


class Mailer(ABC):
    @abstractmethod
    def send_code(self, email: str, code: str, minutes: int) -> None: ...


class ConsoleMailer(Mailer):
    """Prints the code on the service's own terminal. Right for a service you run on your own computer."""

    def __init__(self, stream=None):
        self.stream = stream or sys.stderr

    def send_code(self, email: str, code: str, minutes: int) -> None:
        print(f"[stunfisk-plugin] sign-in code for {email}: {code} (valid {minutes} minutes)", file=self.stream, flush=True)


class SmtpMailer(Mailer):
    def __init__(self, host: str, port: int, sender: str, user: str | None = None, password: str | None = None,
                 starttls: bool = True):
        self.host, self.port, self.sender = host, port, sender
        self.user, self.password, self.starttls = user, password, starttls

    def send_code(self, email: str, code: str, minutes: int) -> None:
        message = EmailMessage()
        message["From"], message["To"], message["Subject"] = self.sender, email, "Your Stunfisk sign-in code"
        message.set_content(f"Your sign-in code is {code}. It is valid for {minutes} minutes.\n"
                            "If you did not ask for it, ignore this message.")
        with smtplib.SMTP(self.host, self.port, timeout=15) as smtp:
            if self.starttls:
                smtp.starttls(context=ssl.create_default_context())
            if self.user:
                smtp.login(self.user, self.password or "")
            smtp.send_message(message)
