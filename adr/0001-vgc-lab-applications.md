# 0001. Applications to import from VGC Lab

- **Status:** proposed
- **Date:** 2026-10-15

## Context

VGC Lab (`VGC_Lab_sharable/sharable`) is a local Python app with a bundled Showdown server.
Its web pages talk to one HTTP/JSON backend (`app/review/server.py`).
We want every one of its applications to be available from a single Pokémon Showdown plugin named **Stunfisk Coach**.
Coach is its own extension. It is not part of Showdex and does not build on its code.
Showdex is only a reference for how a client extension reads the page ([OTHERS.md](../OTHERS.md)).

The plugin has these requirements:

- **Sign-in:** the user signs in to the plugin service with an email address.
- **Model:** chosen in settings, for example Stunfisk. VGC Lab ships one neural checkpoint (`ladder_net.pt`) plus a calibration file.
- **Engine:** chosen in settings, for example pscpp. VGC Lab uses a proprietary engine (vgcsim) and has an experimental pscpp adapter.
- **Where it runs:** local or remote, a separate setting. Every application must work in both modes.

VGC Lab's apps are tied to vgcsim and its checkpoint format (see its `BACKENDS.md`).
The plugin therefore needs a model adapter and an engine adapter in front of them.

Applications differ in what they need from the model and the engine:

| Level | Needs from model | Needs from engine |
|-------|------------------|-------------------|
| A | Move choice only | Legal choices, turn execution |
| B | Move choice plus opponent prediction and value estimates | Cloneable positions, batch stepping |
| C | None | None (data and report tooling) |

## Decision

We will import the applications listed below into the plugin, in the order given under "Priority".
Each one is reached through a model adapter and an engine adapter, so that model, engine and local or remote mode are settings and not code paths.
Level A and C applications must work with any model.
Level B applications are offered only when the selected model and engine supply the extra capabilities.

### Applications

#### 1. Matchup Lab (`/matchup`) — level B

Paste two teams, run many simulated games, and get matchup matrices, game win rates, equilibrium mixes and critical leads.
Also offers practice play from a chosen position.
Source: `app/matchup.py`, `app/review/web/matchup.html`.

#### 2. Matchup Lab v2 (`/matchup-v2`) — level B

Studies one fixed pairing. Compares preview plans, saves expected plans on both sides, advances a chosen line, steps back,
and exports a preparation sheet with notes and metrics. Embeds the v1 simulation section.
Source: `app/review/web/matchup-v2.html`, shared backend with Matchup Lab.
Plan to merge with application 1 rather than ship two pages.

#### 3. Matchup Explorer (`/explorer`) — level B

Paste both teams, pick leads and backs, choose moves for either side or use the model's choices, then explore or
resimulate turns. Practice can start at turn 1 or replay the studied choices before the user takes over.
Source: `app/explorer.py`, `app/review/web/explorer.html`, `app/test_explorer*.py`.

#### 4. Live Match Helper (`/live`) — level B

Observes a Showdown battle (including private rooms and best-of-three sets) and shows suggested plays, expected opponent moves
and likelihoods. It never submits moves. Can analyse a finished game afterwards.
Source: `app/live_analysis.py`, `app/review/live_service.py`, `app/review/web/live.html`.
This is the best fit for a plugin: the client already holds the live battle state, so the observer can read it directly.

#### 5. Game Review (`/`) — level B

Reviews a finished game decision by decision with win-chance estimates and labels for each choice.
Inputs: a replay URL, a pasted log, or a game captured by the browser extension.
Source: `app/review/core.py`, `replay.py`, `from_replay.py`, `calibrate.py`, `calibration.json`, `web/index.html`, `web/review.html`.
Win chances depend on a per-model calibration, so each model needs its own calibration file.

#### 6. "Review game" button (browser extension) — level A

Adds a Review button to finished battles on play.pokemonshowdown.com and captures the battle stream.
Source: `app/review/extension/`.
Inside Coach this becomes a native button and the separate VGC Lab extension goes away.

#### 7. Practice games — level A

Starts a battle on a Showdown server from a chosen position and plays the rest against the model.
Source: `app/practice.py`, `practice_bot.py`, `practice_log.js`, and the server command in `showdown/server/chat-plugins/practice.ts`.
Needs a Showdown server we control, so local mode only until a remote server option exists.

#### 8. Ladder bot — level B

Plays the official best-of-three ladder with an account, open team sheets, deep search and automatic ready confirmation.
Source: `app/ladder_bot.py`, `app/nnbot.py`, `app/pokebot.py`.
Needs the user's own Showdown account. The password is read at runtime and never stored. The plugin must keep that rule.

#### 9. Bot search engines — level B (internal service)

Not a page, but required by applications 1 to 5 and 8. Fast, Standard and Deep modes differ in candidates per side and sampled worlds.
Source: `app/nnsearch.py`, `sh_search.py`, `deep2.py`, `review/engine_service.py` (a warm shared inference worker).
This becomes the model-and-engine adapter service, not a user-facing feature.

#### 10. Opponent set inference and scouting — level A

Fills in unrevealed opponent sets from a library of real tournament sets and from what the same player showed before.
Source: `app/setlib.py`, `set_library.json`, `scout.py`, `team_sheets.py` (open team sheet parser).
Useful on its own, for example inside a damage calculator.

#### 11. Fast battle — level A

One quick logged matchup battle with JSON in and out and no Showdown login.
Source: `app/fastbattle.py`, `play_engines.py`. Good first smoke test for any engine adapter.

#### 12. Meta pool manager — level C

Imports teams from Pokepaste links, normalizes them (including Mega forms), removes near-duplicates, orders them by similarity and rebuilds the pool.
Source: `meta_pool/` (`rebuild.cjs`, `deduplicate.cjs`, `sort_similarity.cjs`, `sources.json`, `pool.json`).
Currently 42 teams. Works with Champions Reg M-C only.

#### 13. Meta study and PDF reports — level B

Runs large logged studies of candidate teams against the meta (1,000 games per pairing by default) and builds illustrated PDF reports.
Source: `meta_pool/simulate_*.py`, `build_*report*.py`, `skills/vgc-meta-study/`.
The builders contain study-specific defaults and the PDFs use Windows fonts, so they need cleanup before reuse.

#### 14. Training and self-play — level B

PPO self-play training, symmetry augmentation, and evaluation against heuristic or random opponents.
Source: `app/train.py`, `selfplay.py`, `augment.py`, `policy_network.py`.
Probably out of scope for the plugin UI. Keep it as a command-line tool run by the service.

### Priority

1. **First:** applications 4, 5 and 6 (Live Helper and Game Review). They fit the client, they never submit moves, and they cover model and engine selection end to end.
2. **Second:** applications 3, 1 and 2 (Explorer and Matchup Labs), plus 10 and 11.
3. **Third:** applications 8 and 7 (ladder bot and practice), which need accounts and a server.
4. **Later:** applications 12, 13 and 14 (meta pool, reports, training).

## Consequences

- The adapter layer between the plugin, the models and the engines becomes the first piece of real design work and needs its own ADR.
- Applications 1 and 2 are expected to merge into one page.
- Application 6 (the browser extension) disappears as a separate artifact once the plugin has a native button.
- Practice games need a Showdown server we control, so they are local only until a remote server option exists.
- The ladder bot needs the user's own account, and the plugin must keep VGC Lab's rule that the password is never stored.
- VGC Lab supports only Champions Reg M-C doubles, and its pscpp adapter requires Champions stat points. Other formats must be refused clearly.
- Redistribution rights for the custom engine and model are not established (VGC Lab's README says so).
- The pscpp portable encoder is experimental, so model quality through pscpp is not yet validated against vgcsim.
- VGC Lab is validated on Windows only. Linux is untested.

## Open questions

- Remote mode: who hosts it, and how are email sign-ins verified? This needs its own ADR before any account code is written.

## Alternatives considered

- **Keep VGC Lab as a separate local app and only link to it.** Simpler, but it gives no email sign-in, no remote mode and no in-client experience.
- **Import only the Live Helper and Game Review.** Smaller, but it leaves out the matchup tools the project wants. They are kept in the plan as later priorities instead.
