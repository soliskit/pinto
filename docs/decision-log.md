# Pinto Decision Log

**Status.** Entries record the decision, its effect and its status. The current Pinto Playbook has three tabs: Charter, Roadmap and How It Works. This log and the Evidence Record live with the code.

## Settled by the owner

- **P1 Group Call Reliability is the plan** Effect: this is the name and goal of the plan. Status: Settled.
- **P2 Two-person first, groups possible** Effect: two-person calls first, on the condition that the design does not block groups. About 20 is a future target. Status: Settled.
- **P3 Free, single solution** Effect: free is required; one hosting solution is preferred. Status: Settled.
- **P4 Hosting order** Effect: GitHub, then Cloudflare, then Vercel, for every project. Status: Settled.
- **P5 Services first, replacements in parallel** Effect: later narrowed by the audit-first decision below. Status: Superseded in scope by P8.
- **P6 Public page on GitHub Pages** Effect: the public page is on GitHub Pages. The Pages terms need rechecking if the app ever sells, advertises or becomes paid. Status: Settled.
- **P7 Table the open questions** Effect: research continues; the five open decisions wait for the owner. Status: Settled.
- **P8 Audit first** Effect: no service-dependent feature before the audit; planning only meanwhile. Status: Settled.
- **P9 Review the audit before implementation** Effect: Pinto's audit results get an independent review before any implementation starts. The rule itself lives once on Soliskit Principles, with no copy in any Build Plan. Status: Settled.
- **P10 Readiness note** Effect: a one-page note on what to freeze before the audit exists in the repo and is not part of the Playbook. Status: Done.
- **P11 Documentation-only merges** Effect: documentation-only merges everywhere. It does not cover code, tests, CI or releases. Status: Settled.
- **P12 The Playbook** Effect: Pinto gets the Playbook of three files. Old documents are deleted once their content is committed to git. Status: Settled.

## Also settled by the owner

- **P13 Email codes now, passkeys deferred** Effect: host sign-in uses emailed codes; passkeys are deferred. The sign-in service and sender are set by P17. Status: Settled.
- **P14 Diagnostics reports** Effect: the app shows exactly what it would send and sends only when the user taps Send; error information only; only the owner can read reports; reports are kept 30 days and then deleted; deleted data can remain in backups for up to 30 more days (P19). Status: Settled.

- **P15 Hosting split** Effect: the public page stays on GitHub Pages; the app and its sign-in service run on Cloudflare. Status: Settled.
- **P16 Domain layout** Effect: the public page, the app and the sign-in service each get their own soliskit.com subdomain, with host-only cookies so no cookie is shared across them. Status: Settled.
- **P17 Sign-in service** Effect: Salutant, the sign-in service, runs on Cloudflare and sends codes through Resend from a soliskit.com mail subdomain. Only addresses on a private allowlist can sign in. Who is on the allowlist is not yet set. Status: Settled; allowlist contents Open.
- **P18 LiveKit ceiling** Effect: the plan assumes a ceiling of 4,000 person-minutes per month on LiveKit; new call links stop at the ceiling. It is tested first; if the test fails, the fallback plan applies. Status: Settled.
- **P19 Privacy wording and retention** Effect: the exact privacy wording lives once in the Specification. Sign-in codes expire in 10 minutes and are deleted after use. Bug reports are kept 30 days and then deleted, and only the owner reads them. No video or audio is recorded or stored. Deleted data can remain in backups for up to 30 more days. Status: Settled.

## Open decisions

- **Allowlist contents** Not set.
- **Daily mail-quota abuse rule** Not set.
- **Audit acceptance and next scope** Owner acceptance and the scope, order and timing of fixes and real-device checks remain pending.
