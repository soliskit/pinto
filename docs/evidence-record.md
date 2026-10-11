# Pinto Evidence Record

**Status.** This record tracks the planned service checks. The current Playbook has Charter, Roadmap, and How It Works tabs. The existing-app audit is recorded separately in docs/audit-report.md; these service-check rows are not its results.

## 1. Requirements and checks

The rows below identify planned service checks and remain Pending until their own evidence is recorded. Existing-app audit results do not close planned service checks.

- **B1 Audit first** Check: The repo has no service-dependent change before the audit report exists, and the audit results receive an independent review before any service implementation starts. Fail: Any such change earlier, or implementation starting before that review. Result: Pending.
- **B2 Zero cost** Check: A list of enabled plans and features at each milestone, and a simulation of each free limit. Fail: Any billable item, or a limit that bills. Result: Pending.
- **B3 Privileged pages off Pages** Check: A route inventory of the public page host. Fail: Any sign-in, code entry, host console, or invite route there. Result: Pending.
- **B4 Headers** Check: Real requests to each response type, saved, plus a CI check. Fail: Any generated response lacks the required headers. Result: Pending.
- **B5 Link authority** Check: Tests for each race listed in How It Works, B5 Link authority and fencing. Fail: Any old or late token works. Result: Pending.
- **B6 End revokes every token** Check: Tests including never-joined identities and provider failure. Fail: A revoked token works. Provider removal limits are unproven. Result: Pending.
- **B7 Recovery fails closed** Check: A rehearsed restore. Fail: A disabled link, ended generation, or revoked session works afterwards. Result: Pending.
- **B8 Host sign-in** Check: Tests of the allowlist, limits, and budget. Fail: A stranger receives a code or uses up the quota. Result: Pending.
- **B9 Diagnostics** Check: Field and size tests and a read-access test. Fail: A forbidden field is stored, or someone other than the authorized owner can read reports. Result: Pending.
- **B10 Quota messages** Check: A simulated cap for each limit. Fail: A cap bills or fails without a message. Result: Pending.
- **B11 Release rules** Check: CI scan of the public artifact and history for secrets, keys, source maps, private URLs, and third-party scripts. Fail: Any hit. Result: Pending.
- **B12 Camera and microphone teardown** Check: Measured on real devices for each control and case in How It Works, B12 Camera and microphone teardown. Fail: An indicator stays on, or the time to off is not recorded. Result: Pending.
- **B13 Device matrix** Check: A recorded table of devices, browsers, and versions, including separate networks and relay-forced runs. Fail: A missing cell. Simulated Safari does not count. Result: Pending.
- **B14 Clean public repo** Check: Scans plus a manual read of the first pull request. Fail: Any secret or personal detail. Result: Pending.

## 2. Unproven checks

- **TURN accounting** Pending.
- **WebSocket request counting** Pending.
- **Never-joined token revocation** Pending.
- **Recovery on the free plan** Pending.
- **CPU budget and porting effort** Pending.
- **Mail deliverability and quota abuse** Pending.
- **Pages terms fit** A judgment, not a test. Pending.

## 3. Existing app audit

The existing-app audit is recorded in [audit-report.md](audit-report.md); its acceptance is decision log P20. Real-device behavior remains unproven.


## 4. Reviews

Playbook parts have received review comments and revisions. This record does not establish a review verdict for its own exact current bytes. Audit-report review does not certify these planned service checks.

## 5. Later phases

Each phase after the audit needs its own authorization from the owner and its own evidence. Local results never count as proof of provider or platform behavior.


## Platform facts the behavior relies on

Verified by the research coordinator on 7 October 2026 from public pages. Not independently re-read for this document.

- **E1 Pages limits and terms** Free; a public repo is required on GitHub Free; 1 GB site limit; soft 100 GB a month; soft 10 builds an hour. Terms say Pages must not be used for a business, e-commerce, or commercial software as a service, and should not be used for sensitive transactions such as sending passwords or credit card numbers. https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits . No legal judgment is made.
- **E2 Pages headers observed** Unproven in this record. No exact source, date, or response is recorded for the earlier sample of missing frame, content security, and HSTS headers, so it is not reproducible. Not a platform claim.
- **E3 Worker static-file headers** The _headers file applies to static asset responses only, not Worker-generated responses. https://developers.cloudflare.com/workers/static-assets/headers/
- **E8 Existing app** Reported, unverified in this record. Public repo soliskit/pinto, read 7 October 2026 by the research coordinator. No pinned commit or path is recorded, so these observations are not reproducible from this record. Camera and microphone are requested on page load. Camera off swaps the sent video; Mute disables the track; End reconnects the socket. No step that stops the tracks was found. The server accepts any non-empty room name and id. Read, not tested
