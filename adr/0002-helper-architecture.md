# 0002. Live Match Helper: read the open battle, ask a local or remote service

- **Status:** proposed
- **Date:** 2026-10-15

## Context

[ADR 0001](0001-vgc-lab-applications.md) puts the Live Match Helper first. In VGC Lab it is a Python server that opens
its own websocket to Showdown, logs in with the user's password if the battle is private, follows best-of-three series
by parsing chat HTML, and serves a separate web page. The user asked for something different: the helper should read
the current battle directly, not be given a link or a log.

A Showdown client already holds everything the helper needs. Both generations of the client keep, per battle room, the
list of every protocol line received (`room.battle.stepQueue`) and the private request (`room.request`). The classic
client keeps rooms in `window.app`, the rewritten client in `window.PS`. Showdex (`doshidak/showdex`, AGPL-3.0) reads the
same fields in both clients, which shows the approach works. The plugin is named **Stunfisk Coach**. It is its own
extension, not a Showdex page, and does not use Showdex code.

The plugin also has the settings from ADR 0001: sign in with an email, choose the model, choose the engine, and run
locally or remotely.

## Decision

**Identity.** Stunfisk Coach is a standalone browser extension. It has its own manifest, panel and service. It works
with or without Showdex installed, and the two do not interact. The Live Match Helper is its first application.

**Layout.** Shared interfaces live in `common/`. Each application lives in its own folder under `drivers/`. The helper is
`drivers/helper/`, with a `client/` (TypeScript, runs in the page) and a `service/` (Python, runs on the user's computer
or a server). `common/` holds the settings record, the helper wire format and the adapter interfaces, in JSON Schema,
TypeScript and Python. The three are kept in step by tests.

**Extension.** Stunfisk Coach is a Manifest V3 browser extension for Chrome and Firefox, in three parts. A page script
runs in the Showdown page, reads the battle and draws the panel. A relay (a content script in the extension's own world)
passes the page's requests on. A background script holds the settings and the sign-in token and is the only code that
calls the service. The page script asks for a service path such as `/v1/me`, never for a URL or a token. The background
script accepts a fixed list of paths and methods, builds the URL from the stored settings, and attaches the token.
A token is sent only to the service that issued it. The sign-in reply reaches the page without its token. Without the
extension, the page script falls back to its own `fetch` and storage, which is how a development build runs.

**Reading the battle.** The client follows the battle in front of the user. Every half second it reads the line list and
the request from the host. It sends the service only the lines the service has not seen, numbered by position, and the
current request when it changes. The service answers with the same position if it is out of step (HTTP 409) and the client
resends from there. A different front battle, such as the next game of a best-of-three, starts a new session.
The helper never submits a choice to Showdown. It has no Showdown login and needs none, because it runs inside the
user's own signed-in client.

**Service.** A small HTTP API (`/v1`). The client polls for the result, and the service can hold a poll open for up to
25 seconds so updates arrive at once. Each session has a worker that waits a moment for a packet to settle, then asks the
model. A session keeps its model game between positions, so the model sees the battle once, in order.

**Sign-in.** The user types an email. The service sends a six-digit code. The code lasts ten minutes, works once and
dies after five wrong guesses. A correct code returns a signed token valid for 30 days, which the service does not store.
No password exists. In local mode the code is printed on the service's terminal. In remote mode it is emailed, and a
service owner can restrict sign-in to a list of addresses.

**Settings.** The client stores them. The model, engine, analysis mode and run mode travel with each new session, so
changing one restarts the session and nothing else. A local service must be on this computer. A remote service must use
https.

**Adapters.** A model adapter and an engine adapter sit between the session and the bot. They use Stunfisk's own words:
the model is the bot, the engine is the oracle backend (`pscpp`, `showdown`). The Stunfisk model feeds the battle's lines
and request to Stunfisk's live battle player and records the choice it would have submitted. Adapters that cannot run
are still listed, with the reason, so the settings screen can show it.

## Consequences

- The helper works in both Showdown clients and needs no link, paste, password or second connection.
- It sends the open battle to whichever service the user chose. In remote mode that means a third party sees the
  battle. The panel says so.
- The sign-in token and the settings live in the extension's own storage, and the page never sees the token. A script on
  the Showdown page can still ask the background to call the service, within the fixed list of paths and the saved
  address, so it could act as the signed-in user. It can already read the battle, so this adds little.
- Calls from the background avoid mixed-content blocking and, I believe, Chrome's local network permission prompt for a
  page calling `127.0.0.1`. The prompt behaviour is not verified.
- Stunfisk gives one recommended play, not a ranked table with win chances. The panel shows the extra fields when a
  model supplies them. VGC Lab's own bot supplied them, so its helper showed more. That is the level A and level B
  split from ADR 0001.
- The panel is a docked element that Coach owns. It does not become a Showdown room, so it cannot use Showdown's tab
  system. That is accepted for now.
- No Showdex code is used, so its license does not apply here. Stunfisk is AGPL-3.0, which may govern what Coach can reuse
  from it. That is a question for the maintainer.
- Not yet checked: a run inside a real Showdown client, loaded in both browsers, and a run with the real Stunfisk bot installed. The tests use a
  stand-in host and a stand-in player for these. Win-chance calibration, best-of-three series memory and "analyse the
  finished game" from VGC Lab are not ported.

## Alternatives considered

- **Port VGC Lab's design: the service opens its own websocket to Showdown.** It works for spectated links but needs the
  user's password for private rooms, duplicates what the client already has, and breaks on every client change to the
  chat HTML it parses.
- **Fork Showdex and add the helper as a page.** It would give native rooms and its Redux store, at the price of tracking a
  large upstream and taking its license. Rejected: Coach is meant to be its own plugin.
- **Password accounts.** More to store and secure than a code sent to an email address, with no benefit here.
