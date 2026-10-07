# Audit readiness

What to hold still before an audit of Pinto, and what the audit should record about calls, connections and camera shutdown. This page sets no audit scope, phases or dates. Code facts come from reading the repo on October 7, 2026. They are untested.

## What to freeze

1. **Code version.** Record the commit ID of `main` and the date. Merge no feature work until the audit ends. Fixes the audit finds go in separately.
2. **Live site.** Record which deploy is live on Render. The Blueprint uses the free plan, which sleeps after 15 idle minutes and can take about a minute to wake ([Render free plan](https://render.com/docs/free)). Change no settings.
3. **Packages.** `package-lock.json` pins versions. Make no dependency updates during the audit.
4. **Settings.** List the names of the environment variables in use (`PORT`, `KEY`, and whether the Twilio variables are set), never their values. Rotate nothing.
5. **Test baseline.** Run the type check, lint and tests once, as CI does, and save the result.
6. **Test devices.** Fix a list of devices and browsers with exact versions. Keep it the same throughout.
7. **Repo name.** `package.json` points `repository` at `pinto-pinto/pinto`, but the repo is `soliskit/pinto`. Pick one.

## What the audit should record

For each test: date and time, commit ID, device and browser versions, network, direct or relayed, result, pass or fail, and a screenshot or recording.

- **Calls.** `join-room` starts a call, the server sends `user-connected`, and the others call the new peer. Record the order, and what happens when two people join at once. The server accepts any non-empty room name and id, so record what a stranger who guesses a room name can do. The server logs room names and ids.
- **Connections.** Record direct or relayed for each call, and whether Twilio TURN is set. Test across separate networks. Cut the network mid-call and time the recovery (the client retries after 5 seconds). Time the first join after the free host has slept.
- **Camera shutdown.** From reading `public/room.js` (untested): the page requests camera and microphone on load, before anyone joins. Camera off swaps the sent video to a photo with `replaceTrack` and finds no `.stop()`, so the camera may stay on. Mute sets `track.enabled = false`, so the microphone stays captured. End does `socket.disconnect().connect()` and stops no track. The camera light may stay on after End or closing the page.

For each moment, record whether the indicator is on, what the other person sees and hears, and the seconds until it goes off: after Camera off, Mute, End, closing the tab, refresh, locking the phone, permission refused at the start, and permission revoked mid-call.
