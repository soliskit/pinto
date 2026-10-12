# Audit readiness

The inputs, checks, and limits used for the existing-app audit.

The accepted audit findings and limits are in the [audit report](audit-report.md). [Decisions P20 to P22](decision-log.md) record the next steps. Real-device checks remain pending. This checklist creates no freeze rule and grants no authorization.

## Audit inputs

1. **Code version.** Record the commit and date, and any feature changes during the audit.
2. **Live site.** Record which deploy is live on Render. The repository's Render configuration uses the free plan, which sleeps when idle (see [Evidence Record E4](evidence-record.md)).
3. **Packages.** Record the versions pinned by `package-lock.json`, and any updates during the audit.
4. **Settings.** Record the names of the environment variables in use (`PORT`, `KEY`, and whether the Twilio variables are set). Never record their values.
5. **Test baseline.** Record the results of the type check, lint, and tests, run the way CI runs them.
6. **Test devices.** Record the devices and browsers used, with exact versions. Keep them the same throughout.
7. **Repository.** Audit `soliskit/pinto`.

## Call, connection, and capture checks

For each test, record the date and time, commit ID, device and browser versions, network, direct or relayed, result (pass or fail), and a screenshot or recording.

- **Calls.** Record call order, simultaneous joins, room admission, how participant IDs are handled, including whether the server verifies that a caller's ID belongs to them, and calls from people outside the room. Keep server-only results separate from page behavior.
- **Connections.** Record direct or relayed for each call, and whether Twilio TURN is set. Test across separate networks. Cut the network mid-call and time the recovery. Time the first join after the free host has slept.
- **Camera and microphone shutdown.** Check capture after Camera off, Mute, and End. Record what the other person sees and hears, and the seconds until capture stops. Local track-state results do not show physical indicator behavior or audible sound.

## Real-device acceptance cases

Real-device checks are still pending. The cases are Camera off, Mute, End, closing the tab, navigating away, refreshing, locking the phone and coming back, refusing camera permission at the start, and taking permission away mid-call. For each case, record the capture state, what the other person sees and hears, and the time until capture stops. Use the device and capture checks in [Evidence Record B12 and B13](evidence-record.md). Local simulated devices do not count.

## Audit limits

- The audit only reads the repo and the live site.
- It costs $0. No accounts are created and nothing is spent.
- It changes no code, tests, workflows, or settings.
- Pinto fixes, including the microphone bug, follow the fix plan (P21). Implementation needs its own authorization.
