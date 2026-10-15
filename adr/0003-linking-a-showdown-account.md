# 0003. Linking a Showdown account to a Coach account

- **Status:** proposed
- **Date:** 2026-10-15

## Context

The service's landing page is where a user signs in with an email. The user wants to link their Showdown account there,
so that the Live Match Helper assists automatically with the game they are playing and the page can show it.

Showdown has no sign-in that a third party can use. The only credential it accepts is the user's password, and Coach
must not ask for it. VGC Lab did take the password so that its server could join private rooms. That is the main reason
ADR 0002 moved the reading into the user's own logged-in browser.

## Decision

**A link is a name plus a confirmation from the browser.** On the landing page the user enters their Showdown name. The
service stores it against their email. It is unconfirmed until the extension, running in a Showdown page where the user
is logged in, reports the name it sees and that name matches (compared by Showdown's own id rules, lowercase letters and
digits). Then the link is confirmed. A guest name cannot be linked.

**Only the website creates or changes a link.** The extension may report the name it sees and nothing else. The
background script's allow-list has the report path and no way to set or clear a link, so a script on the Showdown page
cannot change who the account is linked to.

**The helper follows the game the user plays.** Among open battles the extension prefers one where the user is a player
(the client gives them a private request or a side) over one they watch. The front battle wins if they play in it, then
the one already followed, then any other of their own. A room seen as theirs stays theirs while the client drops the
request between decisions.

**The website shows the game.** The service exposes the session that last received battle lines for the signed-in user.
The landing page polls it and shows the battle, who is playing, the position and the suggested play. It says whether the
player is the linked account.

**Storage.** Links are kept in a small file in the service's state folder, readable only by its owner.

## Consequences

- Nothing about the Showdown account is trusted for security. The helper only reads battles and never acts as the
  account. A wrong or false link costs a user nothing worse than seeing their own advice labelled wrongly.
- Confirmation shows that the browser using this Coach account is logged in as that name. It does not prove the person
  owns the Showdown account, and a second Coach account can claim the same name without being confirmed by someone
  else's browser. Showdown offers nothing stronger without a password.
- The service does not watch Showdown on its own. The game appears on the page only while the extension is open in a
  Showdown page, because the extension is what reads the battle.
- The page shows live advice, so a remote service shows it to anyone signed in as that email. That is the same exposure
  as sending the battle to a remote service, which the panel already warns about.
- The page keeps its sign-in token in its own storage. The token is stateless, so signing out on the page forgets it
  there but does not revoke it on the service.
- Without the Stunfisk packages installed, no model is available, so the page shows no advice yet. The link and the
  game-following work regardless.

## Alternatives considered

- **Ask for the Showdown password and log in from the service.** It would allow server-side watching and private rooms.
  Rejected: Coach must never hold that credential.
- **Prove ownership with a message from the account to a Coach bot account.** Stronger, but it needs a Showdown account
  run by the service and a chat round trip. Left for later if confirmation by the browser proves too weak.
- **Link only inside the extension.** Simpler, but the user asked for it on the website, and the website needs the name
  to label the game it shows.
