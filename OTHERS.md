# Other Pokémon Showdown plugins

A living list of plugins, extensions and tools for [Pokémon Showdown](https://github.com/smogon/pokemon-showdown).
We track them to learn from their design, avoid duplicated work and spot gaps this project can fill.

Design decisions that come out of this research go in [`adr/`](adr/).

## How to add an entry

1. Add a row to the table below and keep it sorted by name.
2. Fill in every column. Write `unknown` instead of guessing.
3. Put longer notes in the entry's section further down.
4. If an entry changes our design, record it as an ADR and link it in the Notes column.

Status values: `active` (commits in the last 6 months), `stale` (no recent commits), `archived`, `unknown`.

## Overview

| Name | Repository | Type | Status | Last checked | Notes |
|------|------------|------|--------|--------------|-------|
| Showdex | [doshidak/showdex](https://github.com/doshidak/showdex) | Browser extension | active | 2026-10-15 | Damage calculator and team tools for the Showdown client. Last commit 2026-09-14. See details. |
| stunfisk-plugin | [simonecaletti/stunfisk-plugin](https://github.com/simonecaletti/stunfisk-plugin) | Plugin | active | 2026-10-15 | This project. Listed as the reference entry. |

## Entry template

Copy this block under "Details" for each new plugin.

```markdown
### <Name>

- **Repository:** <url>
- **Maintainer:** <name or org>
- **Type:** server plugin | client extension | bot | tool | library
- **License:** <license>
- **Status:** active | stale | archived | unknown
- **Last checked:** YYYY-MM-DD

**What it does:** one or two sentences.

**How it integrates with Pokémon Showdown:** chat commands, config hooks, forked server, client patch, and so on.

**Worth borrowing:** ideas, APIs or structure we may reuse.

**Weaknesses or gaps:** what it misses that we could cover.

**Related ADRs:** links, if any.
```

## Details

### Showdex

- **Repository:** https://github.com/doshidak/showdex
- **Maintainer:** Keith Choison
- **Type:** client extension (Chrome, Firefox and standalone builds)
- **License:** AGPL-3.0
- **Status:** active
- **Last checked:** 2026-10-15 (version 1.4.2)

**What it does:** adds a damage calculator (Calcdex), team tools and notes to the Pokémon Showdown client.

**How it integrates with Pokémon Showdown:** a content script loaded into the page. It supports both the classic client (`window.app`) and the rewritten Preact client (`window.PS`) through separate bootstrapper classes. It reads battles from `room.battle.stepQueue` and `room.request`.

**Worth borrowing:** the two-host approach, and the way it reads live battle state without a second connection. [ADR 0002](adr/0002-helper-architecture.md) uses the same fields.

**Weaknesses or gaps:** no move recommendations and no model. It is a calculator, not a player.

**Related ADRs:** [0002](adr/0002-helper-architecture.md).
