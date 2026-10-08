# Audit report: Phase A, existing app

This is the written report for Phase A of the Pinto audit: an audit of the app as it exists today. It follows the held-still list and limits in [audit-readiness.md](audit-readiness.md). It is read-only. It fixes nothing, changes no code, tests, workflows or settings, and costs nothing. Fixes and new features wait until this report is accepted.

Every finding is labeled **Tested**, **Code reading only** or **Not established**. "Tested" means a test run on a local copy of this commit, in headless Chromium with a fake camera and microphone on Linux. That shows what the page's code does with the camera and microphone tracks. It does not show what a phone or browser indicator light does. All physical-indicator checks and all real-device checks are **Not established** until they are run on real devices.

## What was recorded

| Item | Record |
| --- | --- |
| Code version | `main` at `7255398b7c3ae50c7955acd969f02021e5787d1e`, October 8, 2026, 00:37 PDT. No other changes merged during the audit. |
| Live site | `https://pinto-zd0c.onrender.com` answered HTTP 200. Its `room.js` and `home.js` are byte-for-byte the same as `main`. The server side of the deploy is not directly visible, so it is **Not established**. Render's free plan sleeps after 15 idle minutes; the wake-up time was not measured. |
| Packages | From `package-lock.json`: express 5.2.1, peer 1.0.2, peerjs 1.5.5, socket.io 4.8.4, ws 8.22.0, playwright 1.63.0 (dev). |
| Settings (names only) | `PORT`, `KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`. Whether the Twilio names are set on Render is **Not established**. |
| Test baseline | **Tested.** On Node 22.23.3 with Chromium headless shell 153: type check passed, lint passed, `npm test` passed 47 of 47. |
| Test devices | Headless Chromium 153 on Linux only. No phone, tablet or other browser has been tested. |

## Findings

### 1. The camera is captured from page load and never released. Tested

- The page asks for camera and microphone as it loads, before anyone chooses Join Now. After load, the camera track and the microphone track were both live.
- Start Video, then Stop Video: the camera track stayed live. Stop Video only swaps which video is sent to others. It does not stop the camera.
- End: the camera track stayed live, and so did the microphone track. The page returns to "Choose Join Now", but nothing stops the tracks.
- So, in this test, the page keeps the camera and microphone captured from load until the tab closes. Whether a phone or browser indicator is on is **Not established**. The product rule that Stop Video stops camera capture is not met by this code.
- Source: `public/room.js` (the `getUserMedia` call at load, `cameraButton`, `callButton`).

### 2. Mute keeps the microphone captured. Tested

- After Mute, the microphone track was live with `enabled` set to false. Others hear silence, but the microphone is still captured.
- Source: `muteButton` in `public/room.js`.

### 3. Anyone who knows a room name can hear the room. Tested

- The server accepts any non-empty room name and sends each joiner the ids of the others. A test client that knew only a room name, with no page and no camera, received the id of a person in the room.
- A separate test client that called that id was answered with an audio stream from a person in the room.
- The list of connected peers is not exposed. The peer list address answered 401 (not allowed).
- This matches the earlier security-review finding "P1". Room names are the only barrier, and the roadmap records that links are open on purpose. Whether guessable names make this worse is a product decision for the owner.
- Source: `src/index.ts` (`join-room`), `peer.on('call')` in `public/room.js`.

### 4. Joining, leaving and rejoining. Tested

- Two people joining at the same time each saw one other person and a connected call.
- End on one side: the other side saw that person leave within 1.5 seconds. Rejoining reconnected both.
- Refresh and closing the tab: the other person saw the leave. After a refresh the page showed "Choose Join Now", and rejoining reconnected both.
- This ran on one machine, so it shows the room logic, not real network behavior.

### 5. Refusing camera permission. Tested

- With permission refused, the page showed "Camera and microphone are unavailable: Permission denied". Join Now stayed available, so someone can join with a photo and no audio.

### 6. Recovery after a network cut. Not established

- A 10-second offline switch in the test browser did not break the call, because both sides were on one machine. This test says nothing about real networks. The code's only recovery step is `peer.reconnect()` 5 seconds after the signal connection reports `disconnected`. A rejoin to the room after a drop was not found in the code (code reading only).

### 7. Not established

- Physical camera and microphone indicators on any device.
- Revoking camera permission in the middle of a call. The code has no handler for a track ending (code reading only).
- Locking a phone and returning, switching apps, and navigating away on a phone.
- Direct versus relayed calls across separate networks, and whether Twilio relay is configured.
- Wake-up time after the free host sleeps.
- Behavior in Safari, Firefox, and on phones.

### 8. Metadata. Recorded, not changed

- `package.json` still names `pinto-pinto/pinto` in its `repository` field. The source repo is `soliskit/pinto`.

## What this means

Findings 1 to 3 are the work to decide on after this report is accepted. None is fixed here. The real-device checks in section 7 need a list of devices and browsers from the owner. Until they run, the audit cannot claim "works every time".

## Next steps for the owner

1. Read and accept this report, or send it back.
2. Choose whether to fix findings 1 and 2 (stop the camera and microphone) and decide finding 3.
3. Provide the devices and browsers for the real-device checks in section 7.
4. The independent review of this audit, which the roadmap calls for, comes before any implementation.
