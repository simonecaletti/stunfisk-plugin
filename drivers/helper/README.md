# Live Match Helper

Advice for the Pokémon Showdown battle you have open. It reads the battle straight from the client in the page, with
no link or log to paste. It never submits a move. Design: [ADR 0002](../../adr/0002-helper-architecture.md).

```
play.pokemonshowdown.com                      your computer, or a server
┌────────────────────────────┐   HTTP /v1    ┌─────────────────────────────┐
│ client/  reads room.battle │ ───────────▶ │ service/  sessions          │
│ and room.request, shows    │ ◀─────────── │  └ model adapter (Stunfisk) │
│ the panel                  │   polling     │      └ engine (pscpp)       │
└────────────────────────────┘               └─────────────────────────────┘
```

## Run it

Install once from the repository root:

```bash
npm install
npm run build
```

Start the service. By default it listens on 127.0.0.1 and prints sign-in codes on its own terminal.
The Stunfisk repository's Python packages must be importable for the Stunfisk model and the engines to be available.

```bash
PYTHONPATH=common/python:drivers/helper/service python3 -m stunfisk_plugin_helper
```

Load `drivers/helper/client/extension/` as an unpacked extension in Chrome or Firefox, open Showdown, and use the panel
in the bottom right corner: enter your email, type the code the service printed, and open a battle.

## Settings

| Setting | Values | Notes |
|---------|--------|-------|
| Email | any address | Used only to sign in. |
| Model | from the service | Stunfisk. |
| Engine | from the service | `pscpp` or `showdown`. Unavailable ones show why. |
| Run | on this computer, or on a remote service | Local must be 127.0.0.1 or localhost. Remote must be https. |
| Analysis | fast, standard, deep | Passed to the model. Stunfisk ignores it for now. |

For a remote service, run the same command with `--host`, `--mailer smtp` and, if wanted, `--allow-email`. Put TLS in
front of it. In remote mode the battle you have open is sent to that service.

## Tests

```bash
npm test          # TypeScript and Python
npm run typecheck
```

The client's end-to-end test starts the real service with a fake model. Nothing here has run inside a real Showdown
client or with the real Stunfisk bot yet.
