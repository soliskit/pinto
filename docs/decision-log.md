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
- **P9 Review the audit before implementation** Effect: Pinto's audit results get an independent review before any implementation starts. The rule itself lives once on Soliskit Principles, with no copy in any Roadmap. Status: Settled.
- **P10 Readiness note** Effect: a one-page note on what to freeze before the audit exists in the repo and is not part of the Playbook. Status: Done.
- **P11 Documentation-only merges** Effect: documentation-only pull requests may merge after independent review and passing checks. This does not cover code, permanent tests, CI changes or releases. A document that changes a goal, requirement, decision or safeguard still needs the owner's approval. Status: Settled.
- **P12 The Playbook** Effect: Pinto gets the Playbook of three tabs: Charter, Roadmap and How It Works. Old documents are deleted once their content is committed to git. Status: Settled.

## Also settled by the owner

- **P13 Email codes now, passkeys deferred** Effect: host sign-in uses emailed codes; passkeys are deferred. The sign-in service and sender are set by P17. Status: Settled.
- **P14 Diagnostics reports** Effect: the app shows exactly what it would send and sends only when the user taps Send; error information only; only the owner can read reports; reports are kept 30 days and then deleted; deleted data can remain in backups for up to 30 more days (P19). Status: Settled.

- **P15 Hosting split** Effect: the public page stays on GitHub Pages; the app and its sign-in service are planned to run on Cloudflare. The existing app uses Render; migration is not established. Status: Settled.
- **P16 Domain layout** Effect: the public page, the app and the sign-in service each get their own soliskit.com subdomain, with host-only cookies so no cookie is shared across them. Status: Settled.
- **P17 Sign-in service** Effect: The sign-in service is planned to run on Cloudflare and send codes through Resend from a soliskit.com mail subdomain. Only addresses on a private allowlist can sign in. The allowlist holds only the owner's email until the owner-only trial works. Status: Settled; opening to others remains separate.
- **P18 LiveKit ceiling** Effect: the plan assumes a ceiling of 4,000 person-minutes per month on LiveKit; new call links stop at the ceiling. It is tested first; if the test fails, the fallback plan applies. Status: Settled.
- **P19 Privacy wording and retention** Effect: the privacy wording is in How It Works, under Diagnostics (B9), and is shown only after B8 and B9 pass. Its code-expiry wording must match the sign-in service contract, where the code lifetime is 30 minutes. Codes are single-use. Bug reports are kept 30 days and then deleted, and only the owner reads them. No video or audio is recorded or stored. Deleted data can remain in backups for up to 30 more days. Status: Settled.

- **P20 Phase A audit accepted** Effect: the written Phase A audit report (`docs/audit-report.md`) and its stated limits are accepted as the basis for choosing fixes. Acceptance covers the findings and their limits only; it authorizes no app changes, no service features and no live-site testing. Status: Settled, October 9, 2026.
- **P21 Privacy and call-access fixes before real-device checks** Effect: the fix plan is approved: Stop Video, Mute and End each stop their camera or microphone capture; capture starts only when joining; callers who are not in the room are blocked; and pretending to be another person can no longer end a call. This approves the plan, not code changes; implementation needs its own authorization. Reconnection and room-lifecycle fixes (audit findings 6 and 7) remain a later decision. Status: Settled, October 9, 2026.
- **P22 Real-device test plan** Effect: real-device checks wait until the approved fixes are built and pass local checks. They then run on the owner's chosen iPhone and iPad (exact models kept in the private record), in Safari, with a throwaway call, checking camera and microphone shutoff, sound, picture and recovery after a network change. This approves the plan only, not a go-ahead to run the checks. Status: Settled, October 9, 2026.

- **P23 Sign-in email safeguard** Effect: sign-in emails go only to approved hosts; repeated requests are limited; new sign-ins stop before the free daily email allowance is used up; existing sessions keep working; a warning shows before the limit. This settles the safeguard rule; the exact limits are not set. Status: Settled, October 9, 2026.
- **P24 Host list stays owner-only** Effect: host sign-in stays limited to the owner until the owner-only test works; other hosts are added only when the owner chooses who; guests join calls without an account. No invitation or host addition is authorized. Status: Settled, October 9, 2026.

## Open decisions

- **Mail-quota limits** The safeguard rule is settled (P23); the exact limits are not set.
- **Reconnection and room-lifecycle fixes** Whether audit findings 6 and 7 need fixing, and when, remains a later decision.
- **Fix implementation and test go-aheads** Building the approved fixes needs its own authorization, and running the planned real-device checks needs its own go-ahead.
