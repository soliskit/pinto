# Requirements

Pinto audit, commit `8e9d006fa638950c85d6f5473ce7a42a790a1f1f` (a commit from before the history rewrite; it is not on the main branch, and GitHub still shows it by its hash). Approved October 17, 2026.

Each rule is quoted with its source. What the code does is recorded separately, in Phase 2 and later. Scope marks: TODAY (a rule for the app at `8e9d006`), TARGET (a settled decision the app is planned to meet; findings are judged against it), PLANNED (a service feature not built at `8e9d006`; outside certification, listed as Not Certified, never dropped), PARTLY TODAY (a decision with one part already true at `8e9d006` and the rest planned).

Two conventions. P-numbers (P1 to P29) are entries in Pinto's decision log, [`docs/decisions.md`](decisions.md). The requirements below are numbered REQ 1 to REQ 9; the decision log's own derivation entries R1 to R3 (retention reasoning, added at `d7cb35f` - a commit from before the history rewrite; it is not on the main branch, and GitHub still shows it by its hash) are a different set and share only the letter.

## Rules for the app as it stands

- **REQ 1.** "Browser video calls, with camera and photo controls." "Share a room link and talk with friends." [read: `README.md` lines 3 and 5] TODAY.
- **REQ 2.** "Pinto is a free video call app that runs in a browser. A host shares a link, and a guest joins without an account." [read: the Pinto Playbook, Charter tab, Purpose; "free" is P3, "guests join calls without an account" is P24] TODAY.
- **REQ 3.** "With your camera off, others see a placeholder. Click your own preview to show a photo instead." [read: `README.md` line 41] TODAY.
- **REQ 4.** "Video and audio then usually flow directly between browsers, or through a TURN server when a direct link is blocked. Leave or closing the tab sends `user-disconnected` to the room." [read: `README.md` line 39] TODAY.
- **REQ 5.** "Two-person calls come first, and groups stay possible. The design must not block groups. About 20 people is a future target." [read: `docs/decisions.md`, P2, settled] TODAY. The decision-log update `d7cb35f` adds "About 20 people is a design target, not a promise" (G3) and "The test matrix covers up to 4 people" (T2) [read]. The auditor treats G3 and T2 as requirement input, as the plan instructs.
- **REQ 6.** "No video or audio is recorded or stored." [read: `docs/decisions.md`, P19, settled] The plan flags this line as possibly applying to today's app. The auditor proposes TODAY, since nothing in the source records or stores media [read: `src/`, `public/` file lists]. You confirm or scope it out.
- **REQ 7.** "Stop Video, Mute, and End each stop their camera or microphone capture. Capture starts only when joining." [read: `docs/decisions.md`, P21, settled] TARGET. P21 uses the older button names. At `8e9d006` the buttons read Turn Off Camera, Mute, and Leave [read: `public/room.js` lines 153, 154 and 161], so the rule reads: Turn Off Camera stops camera capture, Mute stops microphone capture, Leave stops both, and capture starts only at Join. P21 settles the plan, not code changes; approving REQ 7 as TARGET lets the audit judge today's app against it. Phase A already measured finding 1 against this rule [read: `docs/audit/audit-report.md`].
- **REQ 8.** "Callers who are not in the room are blocked. Pretending to be another person can no longer end a call." [read: `docs/decisions.md`, P21, settled] TARGET. Same plan-not-code note as REQ 7.
- **REQ 9.** Server behavior the README promises: it "serves plain HTML, CSS, and JavaScript, with no build step," "gives browsers connection settings, including Twilio relays when configured," and without Twilio credentials "browsers get a public STUN server only" [read: `README.md` lines 9, 12 and 70]. TODAY.

## Planned services, scoped line by line

Nothing below is built at `8e9d006`: the source has no sign-in, no diagnostics, no LiveKit (the planned video provider service), no Cloudflare state [read: `src/index.ts`, `package.json`, file lists]. Each line is PLANNED and stays Not Certified.

- **P13** sign-in with emailed codes; passkeys (sign-ins that use the device's own lock instead of a password) wait. PLANNED.
- **P14** diagnostics reports: exact preview, explicit Send, error information only, owner reads them. PLANNED.
- **P15** hosting split: public page on GitHub Pages, app and sign-in planned for Cloudflare, existing app on Render. PARTLY TODAY: the existing app on Render is today's state [read: `render.yaml`]; the split is PLANNED.
- **P16** one soliskit.com subdomain per part, host-only cookies. PLANNED.
- **P17** sign-in service on Cloudflare, codes through Resend, private allowlist, owner-only until the trial works. PLANNED.
- **P18** LiveKit ceiling of 4,000 person-minutes a month, tested first, fallback if the test fails. PLANNED.
- **P19** privacy wording and retention, except its "No video or audio is recorded or stored" line, which is REQ 6 above. PLANNED.
- **P23** sign-in email safeguard; exact limits unset. PLANNED.
- **P24** host list owner-only; its "guests join calls without an account" line is REQ 2 above. PLANNED.
- The Playbook's How It Works rows (Terms, link authority and tokens, host sign-in, recovery, responses and headers, diagnostics, limits and messages, release, and B1 to B16, the named checks each planned service must pass) restate these planned services with their checks. PLANNED. Its camera, microphone, and release "Teardown" row restates REQ 7 as a target. The derivation entries G1, G2, R1 to R3, T1 and T3 (`d7cb35f`) record reasoning behind planned-service numbers. PLANNED.

## Audit constraints on record

These bind the audit, not the app: P20 forbids live-site testing; P22 keeps fix-verification device checks after the planned fixes; your October 17 decision allows quick read-only device checks inside the audit. P8 and P9: no service-dependent feature before the audit, and an independent review of the audit results before any building.

## Change classes for Phase 6 (open question 9)

Pinto has no requirements file with sections, so the auditor proposes five classes. Each correction in Phase 6 gets exactly one primary class:

- **SERVER**: `src/`, server settings, `render.yaml`.
- **PAGE**: client logic in `public/*.js`.
- **PRESENTATION**: markup, style, and accessibility in `public/*.html`, `public/*.css`.
- **TEST**: `test/`, test tooling.
- **DOCS**: `README.md`, `docs/`, and wording.
