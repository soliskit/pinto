# Pinto Decision Log

The project choices, their limits, and the decisions still open. A settled design choice is not a claim that its feature is built.

Later entries preserve each decision's original scope and record changes. The [Evidence Record](evidence-record.md) tracks the checks. The private Playbook holds the current plan.

## Settled decisions

- **P1 Group Call Reliability is the plan.** It is the name and goal of the plan.
  Status: Settled.
- **P2 Two-person calls come first, and groups stay possible.** The design must not block groups. About 20 people is a future target.
  Status: Settled.
- **P3 Free, with a single solution.** Free is required, and one hosting solution is preferred.
  Status: Settled.
- **P4 Hosting order.** GitHub first, then Cloudflare, then Vercel, for every project.
  Status: Settled.
- **P5 Original service plan.** Use services first and research replacements alongside them. P8 later required the audit before any service-dependent feature. Status: Settled.
- **P6 The public page lives on GitHub Pages.** If the app ever sells, advertises, or becomes paid, the Pages terms need rechecking.
  Status: Settled.
- **P7 The open questions wait.** Research continues, and the open decisions stay on hold.
  Status: Settled.
- **P8 Audit first.** No service-dependent feature before the audit. Planning only meanwhile.
  Status: Settled.
- **P9 Review the audit before building.** Pinto's audit results get an independent review before any implementation starts. The rule lives once on Principles, with no copy in any Roadmap.
  Status: Settled.
- **P10 A one-page readiness note.** It lists the audit inputs to record. It lives in the repo and is not part of the Playbook.
  Status: Settled.
- **P11 Documentation-only pull requests may merge.** They need an independent review and passing checks. This does not cover code, permanent tests, CI changes, or releases. A document that changes a goal, requirement, decision, or safeguard still needs explicit approval.
  Status: Settled.
- **P12 Original Playbook structure.** The original tabs were Charter, Roadmap, and How It Works. The private Playbook holds the current structure. Old documents are deleted once their content is committed to git.
  Status: Settled.

## Service and audit decisions

- **P13 Planned host sign-in uses emailed codes, and passkeys wait.** P17 sets the sign-in service and sender.
  Status: Settled.
- **P14 Planned diagnostics reports.** The planned app shows exactly what it would send, and sends only when the user taps Send. Reports hold error information only, and only the owner can read them. Retention is set in P19.
  Status: Settled.

- **P15 The hosting is split.** The public page stays on GitHub Pages. The app and its sign-in service are planned to run on Cloudflare. The existing app uses Render, and a move is not established.
  Status: Settled.
- **P16 Each part gets its own soliskit.com subdomain.** That covers the public page, the app, and the sign-in service. Cookies are host-only, so no cookie is shared across them.
  Status: Settled.
- **P17 The sign-in service is planned to run on Cloudflare.** It is planned to send codes through Resend from a soliskit.com mail subdomain. Only addresses on a private allowlist can sign in. The allowlist holds only the owner's email until the owner-only trial works. Opening sign-in to others is a separate decision.
  Status: Pending work.
- **P18 The plan assumes a LiveKit ceiling of 4,000 person-minutes per month.** New call links stop at the ceiling. The ceiling is tested first. If the test fails, the fallback plan applies.
  Status: Pending work.
- **P19 Privacy wording and retention.** The privacy wording is in How It Works, under Diagnostics (B9), and appears only after B8 and B9 pass. Its code-expiry wording must match the sign-in service contract, where the code lifetime is 30 minutes. Codes are single-use. Bug reports are kept 30 days and then deleted, and only the owner reads them. No video or audio is recorded or stored. Deleted data can stay in backups for up to 30 more days.
  Status: Settled.

- **P20 The Phase A audit is accepted.** The written report (`docs/audit/audit-report.md`) and its stated limits are the basis for choosing fixes. Acceptance covers the findings and their limits only. It authorizes no app changes, no service features, and no live-site testing. Decided October 9, 2026.
  Status: Settled.
- **P21 Privacy and call-access fixes come before real-device checks.** The decided plan: Stop Video, Mute, and End each stop their camera or microphone capture. Capture starts only when joining. Callers who are not in the room are blocked. Pretending to be another person can no longer end a call. This records the plan, not approval for code changes. Implementation needs its own authorization. Further reconnection and room-lifecycle fixes remain a later decision. Decided October 9, 2026.
  Later implementation: on October 25, 2026, the owner authorized merging these six capture and call-access fixes after their tests and independent reviews passed. That approval covered these six fixes, not other changes. [PR #88](https://github.com/soliskit/pinto/pull/88) added call-membership checks and rejected reused room identities. [PR #89](https://github.com/soliskit/pinto/pull/89) changed capture to start on Join and stop when turned off or left. Both merged October 26, 2026. Their local and CI checks do not establish real-device behavior or every production call path.
  Status: Settled.
- **P22 The real-device test plan.** Checks wait until the planned fixes are built and pass local checks. They then run on the chosen iPhone and iPad (exact models kept in the private record), in Safari, with a throwaway call. They cover camera and microphone shutoff, sound, picture, and recovery after a network change. This records the plan only, not a go-ahead to run the checks. Decided October 9, 2026.
  Status: Pending work.

- **P23 A sign-in email safeguard.** Sign-in emails go only to approved hosts. Repeated requests are limited. New sign-ins stop before the free daily email allowance runs out. Existing sessions keep working. A warning shows before the limit. The rule is decided; its mail-quota and rate limits are set in the sign-in service's decision log, entries S34 to S36. Decided October 9, 2026.
  Status: Settled.

- **P24 The host list stays owner-only.** Host sign-in stays limited to the owner until the owner-only test works. Other hosts are added only when the owner chooses who. Guests join calls without an account. No invitation or host addition is authorized. Decided October 9, 2026.
  Status: Settled.

- **P25 Known-defect checks run as non-gating diagnostics, with a slow-test split.** Three checks (camera or microphone still live after the capture controls; a caller who never joined was answered; a false join or leave under someone else's id) run marked TODO on covered CI runs and report current behavior without gating. The slow group runs when app or test code changes; the existing fast job is unchanged; closing a phase still runs every test. Each diagnostic becomes the gating regression test in its fix's pull request. This records the shape only, not approval to build. Decided October 22, 2026.
  Status: Settled.
- **P26 The peer-list refusal is the expected behavior.** The two peer-list addresses (/pinto/peers and /peerjs/peers) answer 401 to requests without the key. Scope: those two addresses only; the /config question stays open. This records the expected behavior; the asserting test lands with the test plan's go. Decided October 22, 2026.
  Status: Settled.
- **P27 A host link does not expire, and the host can disable it at any time.** Building host links needs its own authorization, with a test that an exposed link can be disabled. Decided October 23, 2026.
  Status: Settled.
- **P28 A host session lasts 30 days from sign-in.** Activity does not extend it. The host can sign out with a sign-out button. Building host sign-in needs its own authorization, with tests that sign-out works, that the session ends at 30 days from sign-in, and that activity does not extend it. Decided October 23, 2026.
  Status: Settled.
- **P29 The readiness note is cut.** The audit report holds the record of the audit. The one-page readiness note (P10) is deleted, so P10's note no longer lives in the repo, and the audit's real-device steps and limits are no longer written there. Decided October 24, 2026.
  Status: Settled.

## Derivation decisions

These entries record the derivations behind numbers the owner had picked without one. The earlier entries keep their original wording; these rows carry the reasoning. Each was settled by the owner on October 15, 2026.

- **G1 A Pinto call is two people, one real conversation.** This derives P2's two-person pick: mesh connection math (2 people need 1 connection, 4 need 6, 20 need 190), the LiveKit 4,000 person-minute monthly ceiling (P18), and conversation dynamics past about 4 people. Decided October 15, 2026.
  Status: Settled.
- **G2 Two people is the starting point, not a permanent rule.** The product today is the two-person call, and the door to groups stays open. Decided October 15, 2026.
  Status: Settled.
- **G3 About 20 people is a design target, not a promise.** It is where the owner wants the product to go, explicitly not tested or committed. P2's future-target wording keeps this meaning. Decided October 15, 2026.
  Status: Settled.
- **R1 One shared retention number covers logs, bug reports, and deleted-data backup residue.** The number must be derived, not a bare pick. Decided October 15, 2026.
  Status: Settled.
- **R2 Retention is one month for all three data classes.** Long enough to catch and fix real problems, short enough to honor the delete-date creed, and talkable - one word the owner can say without thinking, his stated reason for one shared number. P19's 30-day retention and backup wording carries this meaning. Decided October 15, 2026.
  Status: Settled.
- **R3 Logs and diagnostics never share a store.** Bug reports carry their own diagnostics (screenshots, device info, user descriptions), never raw logs. The owner chose the stronger privacy story: he would rather be wrong on debug memory than on the privacy story. Decided October 15, 2026.
  Status: Settled.
- **T1 The sign-in code lifetime is 30 minutes, derived.** Email delivery delay and mid-sign-in device switching need breathing room, rate limiting is the real anti-guessing defense, and 30 minutes sits in the normal band and is talkable. P19's code-expiry wording keeps this meaning. Decided October 15, 2026.
  Status: Settled.
- **T2 The test matrix covers up to 4 people.** Two is the product, so cover the pair; groups are a maybe-later, so poke past the pair to catch "assumes exactly 2" bugs; about 20 is unpromised, so no big testing; 4 is pair plus 2 and cheap to run. Decided October 15, 2026.
  Status: Settled.
- **T3 Key collisions get 3 total generation tries.** At 128 bits a healthy random generator essentially never collides, so the fail-loudly rule stands, but one collision can have a boring cause (a database hiccup or a duplicate request); 3 tries rules out a fluke and still fails fast on a broken generator. Decided October 15, 2026.
  Status: Settled.

## Open decisions

- **Mail-quota alert thresholds.** The mail-quota and rate limits are set (P23, sign-in service decision log S34 to S36). The plan proposes owner alerts at half and 80 percent of the daily budget; no decision sets them.
  Status: Open.
- **Reconnection and room-lifecycle fixes.** Whether audit findings 6 and 7 need fixing, and when, is a later decision.
  Status: Open.
- **Further implementation and real-device checks.** The six P21 fixes have merged under their separate authorization. Changes outside that scope and the planned real-device checks still need their own go-ahead.
  Status: Open.

## Template rollout

- **P30 PR description completion. Use the Tetris-format PR description with this repository's code boundary and native P-number records. A structural helper checks completion on main-target PRs, rejects unsupported Markdown and shared-head PRs, and uses trusted main code. It does not establish truth or remove SHA-status races. Required-check activation waits for a real later PR result with verified GitHub Actions source; fresh live body, head, record, checks and shared-head review is required before merge. Existing review, test and cost gates remain.** Process choice selected October 27, 2026. The helper was installed by bootstrap PR #93. Required-status activation is a separate settings step requiring a real exact-head success and verified GitHub Actions source. This row records the decision, not an activation receipt.
  Status: Settled process decision only; this status does not certify installation, required-check activation or per-clone setup.
- **P31 Commit guide and issue-template cleanup. New commits use clean subjects and required Why, How and Tags in the body. Use any applicable allowed project tags, including both Bug and Enhancement when both apply; use None only alone when none fits. The tracked editor guide is optional per-clone setup, not a commit-message gate. Remove only the two empty issue-template assignees lines. History and existing assignments stay unchanged.** Process choice selected October 27, 2026. This guide PR adds the tracked guide and removes the two empty issue-template defaults. Per-clone setup remains optional and is not performed by this rollout. This row records the decision, not a claim that any clone was configured.
  Status: Settled process decision only; this status does not certify installation, required-check activation or per-clone setup.
