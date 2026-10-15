# Pinto Decision Log

The project choices, their limits, and the decisions still open.

Later entries preserve each decision's original scope and record changes. The [Evidence Record](evidence-record.md) tracks the checks. The private Playbook holds the current plan.

## Settled decisions

- **P1 Group Call Reliability is the plan.** It is the name and goal of the plan. Settled.
- **P2 Two-person calls come first, and groups stay possible.** The design must not block groups. About 20 people is a future target. Settled.
- **P3 Free, with a single solution.** Free is required, and one hosting solution is preferred. Settled.
- **P4 Hosting order.** GitHub first, then Cloudflare, then Vercel, for every project. Settled.
- **P5 Original service plan.** Use services first and research replacements alongside them. P8 later required the audit before any service-dependent feature.
- **P6 The public page lives on GitHub Pages.** If the app ever sells, advertises, or becomes paid, the Pages terms need rechecking. Settled.
- **P7 The open questions wait.** Research continues, and the five open decisions stay on hold. Settled.
- **P8 Audit first.** No service-dependent feature before the audit. Planning only meanwhile. Settled.
- **P9 Review the audit before building.** Pinto's audit results get an independent review before any implementation starts. The rule lives once on Principles, with no copy in any Roadmap. Settled.
- **P10 A one-page readiness note.** It lists the audit inputs to record. It lives in the repo and is not part of the Playbook. Done.
- **P11 Documentation-only pull requests may merge.** They need an independent review and passing checks. This does not cover code, permanent tests, CI changes, or releases. A document that changes a goal, requirement, decision, or safeguard still needs explicit approval. Settled.
- **P12 Original Playbook structure.** The original tabs were Charter, Roadmap, and How It Works. The private Playbook holds the current structure. Old documents are deleted once their content is committed to git. Settled.

## Service and audit decisions

- **P13 Host sign-in uses emailed codes, and passkeys wait.** P17 sets the sign-in service and sender. Settled.
- **P14 Diagnostics reports.** The app shows exactly what it would send, and sends only when the user taps Send. Reports hold error information only, and only the owner can read them. Retention is set in P19. Settled.

- **P15 The hosting is split.** The public page stays on GitHub Pages. The app and its sign-in service are planned to run on Cloudflare. The existing app uses Render, and a move is not established. Settled.
- **P16 Each part gets its own soliskit.com subdomain.** That covers the public page, the app, and the sign-in service. Cookies are host-only, so no cookie is shared across them. Settled.
- **P17 The sign-in service is planned to run on Cloudflare.** It is planned to send codes through Resend from a soliskit.com mail subdomain. Only addresses on a private allowlist can sign in. The allowlist holds only the owner's email until the owner-only trial works. Settled. Opening sign-in to others is a separate decision.
- **P18 The plan assumes a LiveKit ceiling of 4,000 person-minutes per month.** New call links stop at the ceiling. The ceiling is tested first. If the test fails, the fallback plan applies. Settled.
- **P19 Privacy wording and retention.** The privacy wording is in How It Works, under Diagnostics (B9), and appears only after B8 and B9 pass. Its code-expiry wording must match the sign-in service contract, where the code lifetime is 30 minutes. Codes are single-use. Bug reports are kept 30 days and then deleted, and only the owner reads them. No video or audio is recorded or stored. Deleted data can stay in backups for up to 30 more days. Settled.

- **P20 The Phase A audit is accepted.** The written report (`docs/audit-report.md`) and its stated limits are the basis for choosing fixes. Acceptance covers the findings and their limits only. It authorizes no app changes, no service features, and no live-site testing. Settled, October 9, 2026.
- **P21 Privacy and call-access fixes come before real-device checks.** The settled plan: Stop Video, Mute, and End each stop their camera or microphone capture. Capture starts only when joining. Callers who are not in the room are blocked. Pretending to be another person can no longer end a call. This settles the plan, not code changes. Implementation needs its own authorization. Reconnection and room-lifecycle fixes (audit findings 6 and 7) remain a later decision. Settled, October 9, 2026.
- **P22 The real-device test plan.** Checks wait until the planned fixes are built and pass local checks. They then run on the chosen iPhone and iPad (exact models kept in the private record), in Safari, with a throwaway call. They cover camera and microphone shutoff, sound, picture, and recovery after a network change. This settles the plan only, not a go-ahead to run the checks. Settled, October 9, 2026.

- **P23 A sign-in email safeguard.** Sign-in emails go only to approved hosts. Repeated requests are limited. New sign-ins stop before the free daily email allowance runs out. Existing sessions keep working. A warning shows before the limit. The rule is settled, and the exact limits are not set. Settled, October 9, 2026.
- **P24 The host list stays owner-only.** Host sign-in stays limited to the owner until the owner-only test works. Other hosts are added only when the owner chooses who. Guests join calls without an account. No invitation or host addition is authorized. Settled, October 9, 2026.

## Derivation decisions

These entries record the derivations behind numbers the owner had picked without one. The earlier entries keep their original wording; these rows carry the reasoning. Each was settled by the owner on October 15, 2026, over iMessage.

- **G1 A Pinto call is two people, one real conversation.** This derives P2's two-person pick: mesh connection math (2 people need 1 connection, 4 need 6, 20 need 190), the LiveKit 4,000 person-minute monthly ceiling (P18), and conversation dynamics past about 4 people. Settled, October 15, 2026 (owner's iMessage, phonemsg-01M50MRY99TBECAY3P4P9HWRRX).
- **G2 Two people is the starting point, not a permanent rule.** The product today is the two-person call, and the door to groups stays open. Settled, October 15, 2026 (phonemsg-01M50MSMMZ9PEWMVQQN4JBJ4XH).
- **G3 About 20 people is a design target, not a promise.** It is where the owner wants the product to go, explicitly not tested or committed. P2's future-target wording keeps this meaning. Settled, October 15, 2026 (phonemsg-01M50MT89JSD7YCTN5V9PDBABC).
- **R1 One shared retention number covers logs, bug reports, and deleted-data backup residue.** The number must be derived, not a bare pick. Settled, October 15, 2026 (phonemsg-01M50MW5CRDCGBQX3M5NM0E8S9).
- **R2 Retention is one month for all three data classes.** Long enough to catch and fix real problems, short enough to honor the delete-date creed, and talkable - one word the owner can say without thinking, his stated reason for one shared number (phonemsg-01M50MWXD8R07ZX8TWR9APBBK5). P19's 30-day retention and backup wording carries this meaning. Settled, October 15, 2026 (phonemsg-01M50MYAET8BPEWSWJTZRKRCDB).
- **R3 Logs and diagnostics never share a store.** Bug reports carry their own diagnostics (screenshots, device info, user descriptions), never raw logs. The owner chose the stronger privacy story: he would rather be wrong on debug memory than on the privacy story. Settled, October 15, 2026 (phonemsg-01M50N3T41YG44EC72FJW42Q7A).
- **T1 The sign-in code lifetime is 30 minutes, derived.** Email delivery delay and mid-sign-in device switching need breathing room, rate limiting is the real anti-guessing defense, and 30 minutes sits in the normal band and is talkable. P19's code-expiry wording keeps this meaning. Settled, October 15, 2026 (phonemsg-01M50N52BCPBZKHZ1PTW2EV0Q8).
- **T2 The test matrix covers up to 4 people.** Two is the product, so cover the pair; groups are a maybe-later, so poke past the pair to catch "assumes exactly 2" bugs; about 20 is unpromised, so no big testing; 4 is pair plus 2 and cheap to run. Settled, October 15, 2026 (phonemsg-01M50N68K7WW9H9YGX3PD057V5).
- **T3 Key collisions get 3 total generation tries.** At 128 bits a healthy random generator essentially never collides, so the fail-loudly rule stands, but one collision can have a boring cause (a database hiccup or a duplicate request); 3 tries rules out a fluke and still fails fast on a broken generator. Settled, October 15, 2026 (phonemsg-01M50N7CET3HMNGDYFAYTFCW7C).

## Open decisions

- **Mail-quota limits.** The safeguard rule is settled (P23). The exact limits are not set.
- **Reconnection and room-lifecycle fixes.** Whether audit findings 6 and 7 need fixing, and when, is a later decision.
- **Fix implementation and test go-aheads.** Building the planned fixes needs its own authorization. Running the planned real-device checks needs its own go-ahead.
