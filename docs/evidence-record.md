# Pinto Evidence Record

Status of the planned service checks and the platform facts they rely on.

Every service check below is Pending. The [existing-app audit](audit-report.md) is a separate result and does not close them, and real-device behavior is still unproven. No review verdict covers this exact version of the planned checks, and the audit report's review does not certify them. The private Playbook holds the Check and Fail text for B1 to B16 under How It Works, and the pass rule for each unproven check under What's next in the Charter.

## Service checks

| Check                              | Result  |
| ---------------------------------- | ------- |
| B1 Audit first                     | Pending |
| B2 Zero cost                       | Pending |
| B3 Privileged pages stay off Pages | Pending |
| B4 Headers                         | Pending |
| B5 Link authority                  | Pending |
| B6 End revokes every token         | Pending |
| B7 Recovery fails closed           | Pending |
| B8 Host sign-in                    | Pending |
| B9 Diagnostics                     | Pending |
| B10 Quota messages                 | Pending |
| B11 Release rules                  | Pending |
| B12 Camera and microphone teardown | Pending |
| B13 Device matrix                  | Pending |
| B14 Clean public repo              | Pending |
| B15 Two-person limit               | Pending |
| B16 Direct-call admission          | Pending |

## Unproven checks

Each is Pending. Items 1 to 8 are the unproven checks and gates under What's next in the Playbook Charter.

1. TURN accounting
2. WebSocket request counting
3. Never-joined token revocation
4. Recovery on the free plan
5. CPU budget and porting effort
6. Mail deliverability and quota abuse
7. Pages terms fit, a judgment and not a test
8. Physical capture shutdown

## Later phases

Each phase after the audit needs its own authorization and its own evidence. Local results never count as proof of provider or platform behavior.

## Platform facts

E1 and E3 to E7 were checked against their linked pages on October 12, 2026. E2 and E8 were not rechecked. Keep each fact's date and limits when using it.

- **E1 Pages limits and terms.** On GitHub Free, Pages requires a public repo. Published sites are limited to 1 GB, with a soft 100 GB a month, and a soft 10 builds an hour (not applied to custom Actions workflows). The terms say Pages must not run a business, e-commerce, or commercial software as a service, and should not carry sensitive transactions such as passwords or credit card numbers. No legal judgment is made. Sources: [limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), [creating a site](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site).
- **E2 Pages headers observed.** Not rechecked. Unproven. No source, date, or response is recorded for the earlier sample of missing frame, content security, and HSTS headers, so it cannot be reproduced. It is not a platform claim.
- **E3 Worker static-file headers.** The `_headers` file applies to static asset responses only, not to responses a Worker generates. Source: [Cloudflare headers](https://developers.cloudflare.com/workers/static-assets/headers/).
- **E4 Render free plan.** A free web service spins down after 15 minutes without inbound traffic, and spinning up takes about a minute. Source: [Render free plan](https://render.com/docs/free).
- **E5 Cloudflare free plan.** Request caps only: Workers allow 100,000 requests a day, and Durable Objects allow 100,000 requests a day, both resetting at 00:00 UTC. CPU and duration limits are on the linked limits page. Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
- **E6 LiveKit free plan.** Monthly allowances on the free Build plan: 5,000 WebRTC participant minutes and 50 GB of downstream data transfer. They are hard caps, reset on the first day of each calendar month, and are shared across all of a user's free projects. Source: [LiveKit quotas](https://docs.livekit.io/home/cloud/quotas-and-limits/).
- **E7 Resend free plan.** 100 emails a day, with 30-day data retention. Source: [Resend pricing](https://resend.com/pricing).
- **E8 Earlier source observations.** Reported on October 7, 2026 and unverified. They are not the audit results. A research coordinator read the public repo `soliskit/pinto` with no pinned commit or path, so the observations cannot be reproduced. Camera and microphone are requested on page load. Camera off swaps the sent video. Mute disables the track. End reconnects the socket. No step that stops the tracks was found. The server accepts any non-empty room name and id. Read, not tested.
