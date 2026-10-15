"""``python -m stunfisk_plugin_helper`` starts the helper service."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from .auth import AuthService, load_secret
from .builtin import default_registry
from .links import LinkStore
from .mailers import ConsoleMailer, SmtpMailer
from .server import DEFAULT_ORIGINS, make_server


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="stunfisk_plugin_helper", description="Live Match Helper service")
    p.add_argument("--host", default="127.0.0.1", help="bind address; keep 127.0.0.1 unless TLS is in front")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--state-dir", type=Path, default=Path.home() / ".local/state/stunfisk-plugin")
    p.add_argument("--mailer", choices=("console", "smtp"), default="console",
                   help="console prints the sign-in code here (fine for a local service); smtp emails it")
    p.add_argument("--smtp-host")
    p.add_argument("--smtp-port", type=int, default=587)
    p.add_argument("--smtp-from")
    p.add_argument("--smtp-user")
    p.add_argument("--username-login", choices=("auto", "on", "off"), default="auto",
                   help="sign in with a Showdown name proved by your browser. auto: only when listening on this computer")
    p.add_argument("--allow-email", action="append", default=None, help="only these addresses may sign in (repeatable)")
    p.add_argument("--allow-origin", action="append", default=[], help="extra browser origin allowed to call the API")
    args = p.parse_args(argv)

    if args.mailer == "smtp":
        if not (args.smtp_host and args.smtp_from):
            p.error("--mailer smtp needs --smtp-host and --smtp-from")
        mailer = SmtpMailer(args.smtp_host, args.smtp_port, args.smtp_from, args.smtp_user, os.environ.get("STUNFISK_SMTP_PASSWORD"))
    else:
        mailer = ConsoleMailer()
    allowed = {e.strip().lower() for e in args.allow_email} if args.allow_email else None
    loopback = args.host in ("127.0.0.1", "::1", "localhost")
    if args.username_login == "on" and not loopback:
        p.error("--username-login on needs --host 127.0.0.1: a name proved only by a browser is safe only for a service no one else can reach")
    username_login = args.username_login == "on" or (args.username_login == "auto" and loopback)
    auth = AuthService(mailer, load_secret(args.state_dir / "secret"), allowed=allowed)
    server = make_server(args.host, args.port, auth, default_registry(), origins=(*DEFAULT_ORIGINS, *args.allow_origin),
                         signin="email" if args.mailer == "smtp" else "console",
                         links=LinkStore(args.state_dir / "links.json"), username_login=username_login)
    print(f"[stunfisk-plugin] helper service on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.sessions.close_all()  # type: ignore[attr-defined]
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
