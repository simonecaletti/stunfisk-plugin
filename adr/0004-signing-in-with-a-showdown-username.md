# 0004. Signing in with a Showdown username on a local service

- **Status:** proposed
- **Date:** 2026-10-15

## Context

ADR 0001 asked for sign-in with an email. In use, the user expected to enter their Showdown username, not an email:
the account they care about is the Showdown one, and ADR 0003 already asks them to link it. Showdown has no sign-in a
third party can use, and Coach must not take the password.

## Decision

**A service that only this computer can reach offers sign-in by Showdown username.** On the landing page the user enters
their name. The service opens a short request, valid for five minutes. The extension, running in a browser logged in to
Showdown as that name, sees the page ask and approves it. Both the page and the extension then hold a token for the
account, and the account is already linked and confirmed. There is no code and no password. In the panel the extension
offers a one-click sign-in as the name it sees, with the email form as an alternative.

**The account is the name.** A name account has no email. Its link cannot be changed or removed, because the link is the
identity. Showdown guest names are refused.

**Only for a local service.** The approving call is an ordinary HTTP request, so it proves nothing against someone who
can reach the service. The option is on only when the service listens on this computer (`--username-login auto`, the
default) and the service refuses to turn it on for any other address. A service that others can reach keeps the email
sign-in, which proves control of an inbox.

**What the extension may do.** Ask whether the service offers it, start a request for the name it sees, and approve for
that name. The token from an approval is kept by the background script and never shown to the page. The page cannot
collect another person's pending sign-in.

## Consequences

- Someone who can run commands on this computer can sign in as any name by making both calls. That is the same reach they
  already have over the service's files and log, so nothing is lost on a computer used by one person. On a shared
  computer, leave `--username-login off`.
- The extension answers any sign-in request for its own name without asking again, while signed out. This is the point
  (no code to type), and the request must come from something that can already reach the service.
- Email sign-in stays for every service, and is the only one for a remote service.
- A name account's token and an email account's token are different accounts. Someone who signs in both ways has two
  separate sets of sessions and links.
- Emails that start with `showdown:` are refused, so an email cannot pose as a name account.

## Alternatives considered

- **Username with no proof at all.** Simplest, but a typo or another local user could open someone else's account page.
- **Prove ownership by a message from the account to a Coach bot.** Strong enough for a remote service, but it needs a
  Showdown account run by the service. Left for a remote design.
- **Replace the email sign-in altogether.** Rejected: a remote service has nothing to check a name against.
