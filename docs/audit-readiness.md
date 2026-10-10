# Audit readiness

The written Phase A audit and its independent review are complete. Its current scope, source snapshot, local results, and limits are in [audit-report.md](audit-report.md). The owner accepted the audit on October 9, 2026 (decision log P20) and approved the fix plan and the real-device test plan as plans (P21, P22). Building the fixes and running the checks each need their own authorization. This checklist records the audit inputs and limits; it creates no freeze rule or new authorization. The audit report owns tested findings; this checklist is not a second result record.

## Audit inputs

1. **Code version.** The commit ID of `main` and the date, and whether feature work was merged during the audit.
2. **Live site.** Which deploy is live on Render. The repository's Render configuration uses the free plan, which sleeps after 15 idle minutes and can take about a minute to wake ([Render free plan](https://render.com/docs/free)).
3. **Packages.** The versions pinned by `package-lock.json`, and whether any updates landed during the audit.
4. **Settings.** The names of the environment variables in use (`PORT`, `KEY`, and whether the Twilio variables are set), never their values.
5. **Test baseline.** The result of the type check, lint, and tests, run the way CI runs them.
6. **Test devices.** The devices and browsers used, with exact versions, kept the same throughout.
7. **Repo name.** The source repo is `soliskit/pinto`. The audit recorded a stale `pinto-pinto/pinto` value in the `package.json` `repository` field and did not change it. This change reconciles the field to `soliskit/pinto`.

## Call, connection, and capture checks

For each test: date and time, commit ID, device and browser versions, network, direct or relayed, result, pass or fail, and a screenshot or recording.

- **Calls.** Record call order, simultaneous joins, room admission, peer-ID handling, and unauthorized direct calls. Keep server-only results separate from page behavior.
- **Connections.** Record direct or relayed for each call, and whether Twilio TURN is set. Test across separate networks. Cut the network mid-call and time the recovery. Time the first join after the free host has slept.
- **Camera and microphone shutdown.** Check capture after Camera off, Mute, and End, what the other person sees and hears, and the seconds until capture stops. Local track-state results do not establish physical indicator behavior or audible sound.

## Real-device acceptance cases

Real-device checks remain pending: Camera off, Mute, End, closing the tab, navigating away, refreshing, locking the phone and coming back, refusing camera permission at the start, and taking permission away mid-call. Record capture state, what the other person sees and hears, and the time until capture stops for each case. Follow the Playbook's device matrix and teardown requirements (B12 and B13); local simulated devices do not count.

## Audit limits

- The audit is read-only on the repo and the live site.
- It costs $0: no accounts are created and nothing is spent.
- It changes no code, tests, workflows, or settings.
- Pinto fixes, including the microphone bug, follow the approved fix plan (P21); implementation needs its own authorization.
