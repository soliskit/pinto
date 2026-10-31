# Pinto Requirements

Each rule is quoted with its source. Scope marks: TODAY (a rule for the app as it stands), TARGET (a settled decision the app is planned to meet; findings are judged against it), PLANNED (a service feature not yet built; outside certification, listed as Not Certified, never dropped), PARTLY TODAY (a decision with one part already true and the rest planned).

The requirements below are numbered REQ 1 and up; the earlier decision-log numbering (P1 to P29) remains in git history.

## Rules for the app as it stands

| ID | Requirement |
| --- | --- |
| REQ 1 | "Browser video calls, with camera and photo controls." "Share a room link and talk with friends." [read: `README.md` lines 3 and 5] TODAY. |
| REQ 2 | "Pinto is a free video call app that runs in a browser. A host shares a link, and a guest joins without an account." [read: the Pinto Playbook, Charter tab, Purpose; "free" is P3, "guests join calls without an account" is P24] TODAY. |
| REQ 3 | "With your camera off, others see a placeholder. Click your own preview to show a photo instead." [read: `README.md` line 41] TODAY. |
| REQ 4 | "Video and audio then usually flow directly between browsers, or through a TURN server when a direct link is blocked. Leave or closing the tab sends `user-disconnected` to the room." [read: `README.md` line 39] TODAY. |
| REQ 5 | "Two-person calls come first, and groups stay possible. The design must not block groups. About 20 people is a future target." That is a design target, not a promise. The test matrix covers up to 4 people. TODAY. |
| REQ 6 | "No video or audio is recorded or stored." Nothing in the source records or stores media. Proposed as a rule for the app as it stands; not yet confirmed. |
| REQ 7 | "Stop Video, Mute, and End each stop their camera or microphone capture. Capture starts only when joining." TARGET. The buttons now read Turn Off Camera, Mute, and Leave, so the rule reads: Turn Off Camera stops camera capture, Mute stops microphone capture, Leave stops both, and capture starts only at Join. |
| REQ 8 | "Callers who are not in the room are blocked. Pretending to be another person can no longer end a call." TARGET. |
| REQ 9 | Server behavior the README promises: it "serves plain HTML, CSS, and JavaScript, with no build step," "gives browsers connection settings, including Twilio relays when configured," and without Twilio credentials "browsers get a public STUN server only" [read: `README.md` lines 9, 12 and 70]. TODAY. |

## Planned services, scoped line by line

Nothing below is built at `8e9d006` (a commit from before the history rewrite; GitHub still shows it by its hash): the source has no sign-in, no diagnostics, no LiveKit (the planned video provider service), no Cloudflare state [read: `src/index.ts`, `package.json`, file lists]. Each line is PLANNED and stays Not Certified.

| ID | Requirement |
| --- | --- |
| P13 | sign-in with emailed codes; passkeys (sign-ins that use the device's own lock instead of a password) wait. PLANNED. |
| P14 | diagnostics reports: exact preview, explicit Send, error information only, owner reads them. PLANNED. |
| P15 | hosting split: public page on GitHub Pages, app and sign-in planned for Cloudflare, existing app on Render. PARTLY TODAY: the existing app on Render is today's state [read: `render.yaml`]; the split is PLANNED. |
| P16 | one soliskit.com subdomain per part, host-only cookies. PLANNED. |
| P17 | sign-in service on Cloudflare, codes through Resend, private allowlist, owner-only until the trial works. PLANNED. |
| P18 | LiveKit ceiling of 4,000 person-minutes a month, tested first, fallback if the test fails. PLANNED. |
| P19 | privacy wording and retention, except its "No video or audio is recorded or stored" line, which is REQ 6 above. PLANNED. |
| P23 | sign-in email safeguard; exact limits unset. PLANNED. |
| P24 | host list owner-only; its "guests join calls without an account" line is REQ 2 above. PLANNED. |

- The Playbook's How It Works rows (Terms, link authority and tokens, host sign-in, recovery, responses and headers, diagnostics, limits and messages, release, and B1 to B16, the named checks each planned service must pass) restate these planned services with their checks. PLANNED. Its camera, microphone, and release "Teardown" row restates REQ 7 as a target. The derivation entries G1, G2, R1 to R3, T1 and T3 (`d7cb35f`) record reasoning behind planned-service numbers. PLANNED.

## Audit constraints on record

These bind the audit, not the app: no live-site testing; fix-verification device checks run after the planned fixes; the owner allows quick read-only device checks inside the audit. No service-dependent feature before the audit, and an independent review of the audit results before any building.

## Open items

No open items recorded.
