# Pinto Decision Log

**Status.** Entries record the decision, its effect and its status. The Playbook (named Blueprint when chosen, renamed Playbook on 7 October) is three files for Pinto: Charter, Build Plan and Specification. This log and the Evidence Record live with the code.

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

- **P13 Email codes now, passkeys deferred** Effect: host sign-in uses emailed codes; passkeys are deferred. The sign-in provider decision was later reopened. Status: Settled for code sign-in; provider Open.
- **P14 Diagnostics reports** Effect: the app shows exactly what it would send and sends only when the user taps Send; error information only; only the owner can read reports; reports are kept 7 days, with a deleted report lingering up to about 14 days. Status: Settled as the diagnostics direction; the retention redesign driven by platform limits is Open (decision 5).

## Proposals that are not decisions

- **LiveKit Build, a Cloudflare control plane, a separate sign-in service** Recommendations in the plan, not decisions.

## Open decisions

- **1 Hosting split** Open.
- **2 Domain layout** Open.
- **3 Connecting Pinto to the separate sign-in service, and the host allowlist** Open.
- **4 LiveKit ceiling** Open.
- **5 Retention redesign** Open.
- **Audit scope and date** Not set.
