# Audit readiness

The audit is complete, and its decisions are in the [decision log](decision-log.md) (P20 to P22). The results are in [audit-report.md](audit-report.md). This checklist records what the audit used and where it stopped. It creates no freeze rule and no authorization.

## Audit inputs

1. **Code version.** The commit ID of `main` and the date, and whether feature work was merged during the audit.
2. **Live site.** Which deploy is live on Render. The repository's Render configuration uses the free plan, which sleeps after 15 idle minutes and can take about a minute to wake ([Render free plan](https://render.com/docs/free)).
3. **Packages.** The versions pinned by `package-lock.json`, and whether any updates landed during the audit.
4. **Settings.** The names of the environment variables in use (`PORT`, `KEY`, and whether the Twilio variables are set). Never their values.
5. **Test baseline.** The result of the type check, lint, and tests, run the way CI runs them.
6. **Test devices.** The devices and browsers used, with exact versions, kept the same throughout.
7. **Repo name.** The source repo is `soliskit/pinto`.

## Call, connection, and capture checks

For each test, record the date and time, commit ID, device and browser versions, network, direct or relayed, result (pass or fail), and a screenshot or recording.

- **Calls.** Record call order, simultaneous joins, room admission, peer-ID handling, and unauthorized direct calls. Keep server-only results separate from page behavior.
- **Connections.** Record direct or relayed for each call, and whether Twilio TURN is set. Test across separate networks. Cut the network mid-call and time the recovery. Time the first join after the free host has slept.
- **Camera and microphone shutdown.** Check capture after Camera off, Mute, and End. Record what the other person sees and hears, and the seconds until capture stops. Local track-state results do not show physical indicator behavior or audible sound.

## Real-device acceptance cases

Real-device checks are still pending. The cases are Camera off, Mute, End, closing the tab, navigating away, refreshing, locking the phone and coming back, refusing camera permission at the start, and taking permission away mid-call. For each case, record the capture state, what the other person sees and hears, and the time until capture stops. Follow the Playbook's device matrix and teardown requirements (B12 and B13). Local simulated devices do not count.

## Audit limits

- The audit only reads the repo and the live site.
- It costs $0. No accounts are created and nothing is spent.
- It changes no code, tests, workflows, or settings.
- Pinto fixes, including the microphone bug, follow the approved fix plan (P21). Implementation needs its own authorization.
