# Audit readiness

This is a proposed checklist for a future audit of Pinto, kept as a record. It is not an active audit or a freeze rule. Nothing here sets audit scope, phases or dates, and nothing here changes how the repo is used today. An authorized audit would decide which items apply. Code facts come from reading the repo on October 7, 2026. They have not been tested.

## What an audit would hold still and record

1. **Code version.** The commit ID of `main` and the date, and whether feature work was merged during the audit.
2. **Live site.** Which deploy is live on Render. The Blueprint uses the free plan, which sleeps after 15 idle minutes and can take about a minute to wake ([Render free plan](https://render.com/docs/free)).
3. **Packages.** The versions pinned by `package-lock.json`, and whether any updates landed during the audit.
4. **Settings.** The names of the environment variables in use (`PORT`, `KEY`, and whether the Twilio variables are set), never their values.
5. **Test baseline.** The result of the type check, lint and tests, run the way CI runs them.
6. **Test devices.** The devices and browsers used, with exact versions, kept the same throughout.
7. **Repo name.** The source repo is `soliskit/pinto`. `package.json` still has `pinto-pinto/pinto` in its `repository` field. That is stale metadata to reconcile later, not a change this page makes. The audit records the stale `repository` field and does not change it.

## What an audit would record about calls, connections and camera shutdown

For each test: date and time, commit ID, device and browser versions, network, direct or relayed, result, pass or fail, and a screenshot or recording.

- **Calls.** From the code: `join-room` starts a call, the server sends `user-connected`, and the others call the new peer. Record the order, and what happens when two people join at once. The server accepts any non-empty room name and id, so record what a stranger who guesses a room name can do. The server logs room names and ids.
- **Connections.** Record direct or relayed for each call, and whether Twilio TURN is set. Test across separate networks. Cut the network mid-call and time the recovery. The code has one specific attempt: when the PeerJS connection reports `disconnected`, the page calls `peer.reconnect()` after 5 seconds. Whether calls recover is untested. Time the first join after the free host has slept.
- **Camera and microphone shutdown.** From reading `public/room.js` (untested): the page requests camera and microphone on load, before anyone joins. Camera off swaps the sent video to a photo with `replaceTrack`, and no `.stop()` call was found, so the camera may stay on. Mute sets `track.enabled = false`, so the microphone may stay captured. End calls `socket.disconnect().connect()` and stops no track that was found. The audit should check, after Camera off, Mute and End, whether the indicator is still on, what the other person sees and hears, and the seconds until it goes off.

## Untested acceptance cases

These have no code finding either way and are listed only so an audit covers them: closing the tab, navigating away, refreshing, locking the phone and coming back, refusing camera permission at the start, and taking permission away mid-call. For each, record the same three things.

## Audit limits

- The audit is read-only on the repo and the live site.
- It costs $0: no accounts are created and nothing is spent.
- It changes no code, tests, workflows or settings.
- Pinto fixes, including the microphone bug, wait until the audit is complete.
