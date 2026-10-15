# Live Match Helper

The first application in Stunfisk Coach. Advice for the Pokémon Showdown battle you have open. It reads the battle straight from the client in the page, with
no link or log to paste. It never submits a move. Design: [ADR 0002](../../adr/0002-helper-architecture.md).

```
play.pokemonshowdown.com                                 your computer, or a server
┌────────────────────────────┐  ┌──────────────────┐  HTTP /v1  ┌─────────────────────────────┐
│ page script: reads         │  │ extension:       │ ─────────▶ │ service/  sessions          │
│ room.battle and            │─▶│ relay, then the  │ ◀───────── │  └ model adapter (Stunfisk) │
│ room.request, draws panel  │  │ background script│  polling   │      └ engine (pscpp)       │
└────────────────────────────┘  └──────────────────┘            └─────────────────────────────┘
   asks for /v1/... paths         holds settings and the token,
                                  and makes every call
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

Load `drivers/helper/client/extension/` as an unpacked extension, then open Showdown:

- **Chrome:** `chrome://extensions`, switch on Developer mode, **Load unpacked**.
- **Firefox:** `about:debugging`, **This Firefox**, **Load Temporary Add-on**, pick `manifest.json`. Firefox asks for
  site access separately. In `about:addons`, open Stunfisk Coach, then Permissions, and allow access to
  `play.pokemonshowdown.com`. Without it the panel never appears.

After `npm run build`, reload the extension in the browser. Then use the panel
in the bottom right corner (titled "Stunfisk Coach"): enter your email, type the code the service printed, and open a battle.

## A locally hosted Showdown

The extension also runs on `http://localhost/*` and `http://127.0.0.1/*`, on any port. It docks its panel only where the
page is a Showdown client, so other local pages are left alone. In Firefox, allow site access for those addresses too,
as for the official site.

A client served under another name, such as `http://my-machine:8080`, needs that address added to both `matches` lists
in `drivers/helper/client/extension/manifest.json`, then a rebuild and a reload.

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
