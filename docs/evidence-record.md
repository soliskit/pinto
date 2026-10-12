# Pinto Evidence Record

The planned service checks and the evidence still needed.

Every service check below is Pending. The [existing-app audit](audit-report.md) is a separate result and does not close these checks. The private Playbook holds the current plan.

## 1. Requirements and checks

Every row below is a planned service check, and each stays Pending until its own evidence is recorded. Existing-app audit results do not close planned service checks.

- **B1 Audit first.** Check: the repo has no service-dependent change before the audit report exists, and the audit results receive an independent review before any service implementation starts. Fail: any such change earlier, or implementation starting before that review. Result: Pending.
- **B2 Zero cost.** Check: a list of enabled plans and features at each milestone, and a simulation of each free limit. Fail: any billable item, or a limit that bills. Result: Pending.
- **B3 Privileged pages stay off Pages.** Check: a route inventory of the public page host. Fail: any sign-in, code entry, host console, or invite route there. Result: Pending.
- **B4 Headers.** Check: real requests to each response type, saved, plus a CI check. Fail: any generated response lacks the required headers. Result: Pending.
- **B5 Link authority.** Check: tests for each race listed in How It Works, B5 Link authority and fencing. Fail: any old or late token works. Result: Pending.
- **B6 End revokes every token.** Check: tests that include never-joined identities and provider failure. Fail: a revoked token works. Provider removal limits are unproven. Result: Pending.
- **B7 Recovery fails closed.** Check: a rehearsed restore. Fail: a disabled link, ended generation, or revoked session works afterward. Result: Pending.
- **B8 Host sign-in.** Check: tests of the allowlist, limits, and budget. Fail: a stranger receives a code or uses up the quota. Result: Pending.
- **B9 Diagnostics.** Check: field and size tests, and a read-access test. Fail: a forbidden field is stored, or anyone other than the authorized owner can read reports. Result: Pending.
- **B10 Quota messages.** Check: a simulated cap for each limit. Fail: a cap bills or fails without a message. Result: Pending.
- **B11 Release rules.** Check: a CI scan of the public artifact and history for secrets, keys, source maps, private URLs, and third-party scripts. Fail: any hit. Result: Pending.
- **B12 Camera and microphone teardown.** Check: measured on real devices for each control and case in How It Works, B12 Camera and microphone teardown. Fail: an indicator stays on, or the time to off is not recorded. Result: Pending.
- **B13 Device matrix.** Check: a recorded table of devices, browsers, and versions, including separate networks and relay-forced runs. Fail: a missing cell. Simulated Safari does not count. Result: Pending.
- **B14 Clean public repo.** Check: scans plus a manual read of the first pull request. Fail: any secret or personal detail. Result: Pending.

## 2. Unproven checks

- **TURN accounting.** Pending.
- **WebSocket request counting.** Pending.
- **Never-joined token revocation.** Pending.
- **Recovery on the free plan.** Pending.
- **CPU budget and porting effort.** Pending.
- **Mail deliverability and quota abuse.** Pending.
- **Pages terms fit.** A judgment, not a test. Pending.

## 3. Existing app audit

The existing-app audit is recorded in [audit-report.md](audit-report.md), and its status is in decision log P20. Real-device behavior remains unproven.

## 4. Reviews

Reviewers have commented on the Playbook, and it has been revised. This record gives no review verdict for its exact current version, and the audit-report review does not certify these planned service checks.

## 5. Later phases

Each phase after the audit needs its own authorization and its own evidence. Local results never count as proof of provider or platform behavior.

## Platform facts the behavior relies on

These platform notes were reported from public pages checked on October 7, 2026. They have not been independently rechecked for this record. Keep their dates and limits when using them.

- **E1 Pages limits and terms.** Pages is free, and a public repo is required on GitHub Free. The limits are a 1 GB site, a soft 100 GB a month, and a soft 10 builds an hour. The terms say Pages must not be used for a business, e-commerce, or commercial software as a service, and should not be used for sensitive transactions such as sending passwords or credit card numbers. https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits . No legal judgment is made.
- **E2 Pages headers observed.** Unproven in this record. No exact source, date, or response is recorded for the earlier sample of missing frame, content security, and HSTS headers, so it cannot be reproduced. It is not a platform claim.
- **E3 Worker static-file headers.** The _headers file applies to static asset responses only, not Worker-generated responses. https://developers.cloudflare.com/workers/static-assets/headers/
- **E8 Earlier source observations.** Reported, unverified in this record. These are not the later audit results. Public repo soliskit/pinto, read 7 October 2026 by the research coordinator. No pinned commit or path is recorded, so these observations cannot be reproduced from this record. Camera and microphone are requested on page load. Camera off swaps the sent video. Mute disables the track. End reconnects the socket. No step that stops the tracks was found. The server accepts any non-empty room name and id. Read, not tested.
