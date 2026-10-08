# Pinto Evidence Record

**Status.** This record tracks the planned service checks. The current Playbook has Charter, Roadmap and How It Works tabs. The existing-app audit is recorded separately in docs/audit-report.md; these service-check rows are not its results.

## 1. Requirements and checks

The rows below identify planned service checks and remain Pending until their own evidence is recorded. Existing-app audit results do not close planned service checks.

- **P1 Audit first** Check: The repo has no service-dependent change before the audit report exists, and the audit results receive an independent review before any service implementation starts. Fail: Any such change earlier, or implementation starting before that review. Result: Pending.
- **P2 Zero cost** Check: A list of enabled plans and features at each milestone, and a simulation of each free limit. Fail: Any billable item, or a limit that bills. Result: Pending.
- **P3 Privileged pages off Pages** Check: A route inventory of the public page host. Fail: Any sign-in, code entry, host console or invite route there. Result: Pending.
- **P4 Headers** Check: Real requests to each response type, saved, plus a CI check. Fail: Any generated response lacks the required headers. Result: Pending.
- **P5 Link authority** Check: Tests for each race listed in the Specification, section 3. Fail: Any old or late token works. Result: Pending.
- **P6 End revokes every token** Check: Tests including never-joined identities and provider failure. Fail: A revoked token works. Provider removal limits are unproven. Result: Pending.
- **P7 Recovery fails closed** Check: A rehearsed restore. Fail: A disabled link, ended generation or revoked session works afterwards. Result: Pending.
- **P8 Host sign-in** Check: Tests of the allowlist, limits and budget. Fail: A stranger receives a code or uses up the quota. Result: Pending.
- **P9 Diagnostics** Check: Field and size tests and a read-access test. Fail: A forbidden field is stored, or someone other than the authorized owner can read reports. Result: Pending.
- **P10 Quota messages** Check: A simulated cap for each limit. Fail: A cap bills or fails without a message. Result: Pending.
- **P11 Release rules** Check: CI scan of the public artifact and history for secrets, keys, source maps, private URLs and third-party scripts. Fail: Any hit. Result: Pending.
- **P12 Camera and microphone teardown** Check: Measured on real devices for each case in the Specification, section 9. Fail: An indicator stays on, or the time to off is not recorded. Result: Pending.
- **P13 Device matrix** Check: A recorded table of devices, browsers and versions, including separate networks and relay-forced runs. Fail: A missing cell. Simulated Safari does not count. Result: Pending.
- **P14 Clean public repo** Check: Scans plus a manual read of the first pull request. Fail: Any secret or personal detail. Result: Pending.

## 2. Unproven checks

- **TURN accounting** Pending.
- **WebSocket request counting** Pending.
- **Never-joined token revocation** Pending.
- **Recovery on the free plan** Pending.
- **CPU budget and porting effort** Pending.
- **Mail deliverability and quota abuse** Pending.
- **Pages terms fit** A judgment, not a test. Pending.

## 3. Existing app audit

The written existing-app audit is in docs/audit-report.md. It records its scope, source snapshot, local results and limits. Owner acceptance is pending; real-device behavior remains unproven. The audit records the commit, the live deploy, pinned packages, setting names (never values), a test baseline, a device and browser list, and the camera teardown cases.


## 4. Reviews

Playbook parts have received review comments and revisions. This record does not establish a review verdict for its own exact current bytes. Audit-report review does not certify these planned service checks.

## 5. Later phases

Each phase after the audit needs its own authorization from the owner and its own evidence. Local results never count as proof of provider or platform behavior.


## Platform facts the behavior relies on

Verified by the research coordinator on 7 October 2026 from public pages. Not independently re-read for this document.

- **E1 Pages limits and terms** Free; a public repo is required on GitHub Free; 1 GB site limit; soft 100 GB a month; soft 10 builds an hour. Terms say Pages must not be used for a business, e-commerce or commercial software as a service, and should not be used for sensitive transactions such as sending passwords or credit card numbers. https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits . No legal judgment is made.
- **E2 Pages headers observed** Unproven in this record. No exact source, date or response is recorded for the earlier sample of missing frame, content security and HSTS headers, so it is not reproducible. Not a platform claim.
- **E3 Worker static-file headers** The _headers file applies to static asset responses only, not Worker-generated responses. https://developers.cloudflare.com/workers/static-assets/headers/
- **E8 Existing app** Reported, unverified in this record. Public repo soliskit/pinto, read 7 October 2026 by the research coordinator. No pinned commit or path is recorded, so these observations are not reproducible from this record. Camera and microphone are requested on page load. Camera off swaps the sent video; Mute disables the track; End reconnects the socket. No step that stops the tracks was found. The server accepts any non-empty room name and id. Read, not tested

## Free-tier research, 7 October 2026

Findings from public documentation, read on 7 October 2026. Verified from documentation means the documentation says so; nobody has tried it on Pinto. Unproven means only a test can settle it. Nothing here approves a test, a plan or a spend. Items marked Reported, unverified in this record were relayed and not re-read by its author.

- **1 LiveKit Build (free)** Status: verified from documentation. The free allowance is a hard cap with no overage: when it runs out, new requests fail. 5,000 participant minutes a month and up to 100 connected participants (read). 50 GB downstream a month (Reported, unverified in this record). A two-person 30-minute call uses 60 participant minutes, so about 80 such calls a month. Unproven: whether relayed (TURN) traffic counts toward the 50 GB. Sources: https://docs.livekit.io/deploy/admin/quotas-and-limits.md and https://livekit.com/pricing
- **2 Cloudflare Durable Objects, Free plan** Status: verified from documentation. Only SQLite-backed objects are available. Limits: 100,000 requests a day and 13,000 GB-seconds a day; past either, that kind of operation fails until 00:00 UTC. A WebSocket connection counts as one request, incoming WebSocket messages are billed at 20 to 1, outgoing messages are free. Unproven: that the 20 to 1 ratio behaves the same on Free; a small load test would show it. Source: https://developers.cloudflare.com/durable-objects/platform/pricing/
- **3 Unused invite or room tokens** Status: partly verified from documentation. Verified from documentation: a LiveKit token has an expiry (exp) that applies to the first connection, and a participant's token is revoked when they are removed from a room. Unproven: whether removing a participant who never joined revokes their token; it needs one try. Tokens govern connecting and refresh, not whether a live call ends. Source: https://docs.livekit.io/frontends/authentication/tokens/
- **4 Backups** Status: verified from documentation. Durable Objects with SQLite can restore to any point in the last 30 days (whether the Free plan includes it is not stated in that page): https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ . D1 Time Travel restores to any minute in the last 30 days and overwrites the database in place; older copies need an export to R2: https://developers.cloudflare.com/d1/reference/time-travel/ (free tier: https://developers.cloudflare.com/d1/platform/pricing/ , not re-read).
- **5 Workers Free CPU and porting** Status: limit verified from documentation, fit unproven. 100,000 requests a day and 10 ms of CPU per request on Workers Free; waiting on the network does not count. Typical page or sign-in work is at 10 to 20 ms (Reported, unverified in this record), so fit needs a measured prototype. Porting: Pinto's current Node server (Express, PeerJS server, Socket.IO) does not run on Workers as it is. If LiveKit carries the calls, PeerJS and join signaling go away and what is left (room page, /config, token minting) is small. If calls stay peer to peer, signaling would need rewriting as a Durable Object. Source: https://developers.cloudflare.com/workers/platform/limits/
- **6 Resend Free (mail)** Status: limits verified from documentation, delivery unproven. 100 emails a day and 3,000 a month, counting sent and received (read). Up to 3 verified domains on Free (Reported, unverified in this record). Resend keeps email data for 30 days (read). Resend advises sending from a subdomain and setting up DMARC (read). Unproven: real inbox placement; only a real send settles it. Sources: https://resend.com/docs/knowledge-base/account-quotas-and-limits and https://resend.com/docs/dashboard/domains/introduction
- **Small tests that would settle the unproven items** A TURN count check, a token-revoke check, a Durable Object load check, a CPU timing prototype and a real-mail test. None is approved.
