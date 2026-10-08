# Audit report: Phase A, existing app

This is the written report for Phase A of the Pinto audit: an audit of the app as it exists today. It follows the held-still list and limits in [audit-readiness.md](audit-readiness.md). It is read-only. It fixes nothing, changes no code, tests, workflows or settings, and costs nothing. Fixes and new features wait until this report is accepted.

Every finding is labeled **Tested**, **Code reading only** or **Not established**. "Tested" means a check run on a local copy of this commit, in headless Chromium with a fake camera and microphone on Linux. It shows what the page's code does with the camera and microphone tracks. It does not show what a phone or browser indicator light does, and it does not measure whether sound is audible. All physical-indicator checks and all real-device checks are **Not established**.

## What was recorded

| Item | Record |
| --- | --- |
| Code version | `main` at `7255398b7c3ae50c7955acd969f02021e5787d1e`, October 8, 2026, 00:37 PDT. |
| Live site | `https://pinto-zd0c.onrender.com` answered HTTP 200. Its `room.js` and `home.js` have the same SHA-256 as `public/room.js` and `public/home.js` on `main` (`f5f1e09a...2d882e9e` and `0dde875c...098323d0`). The server side of the deploy is not visible, so it is **Not established**. Render's free plan sleeps after 15 idle minutes; the wake-up time was not measured. |
| Packages | From `package-lock.json`: express 5.2.1, peer 1.0.2, peerjs 1.5.5, socket.io 4.8.4, ws 8.22.0, playwright 1.63.0 (dev). |
| Settings (names only) | `PORT`, `KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`. Whether the Twilio names are set on Render is **Not established**. |
| Test baseline | **Tested**, on Node 22.23.3 with Chromium headless shell 153, from a clean clone of the commit above: `npm run typecheck` exit 0; `npm run lint` exit 0; `PORT=0 npm test` exit 0 with 47 tests, 8 suites, 47 pass, 0 fail, 0 cancelled, 0 skipped. |
| Test devices | Headless Chromium 153 on Linux only. No phone, tablet or other browser has been tested. |

## Method for the checks below

- A script (`phase-a-headless-checks`) started the app's server from the clone on a free local port and opened pages in headless Chromium with a fake camera and microphone. It never touched the live site's rooms; the live site got plain page loads for the file comparison only.
- Camera and microphone state was read from the page's own tracks (`readyState` and `enabled`) after each action.
- Waits between actions were fixed sleeps (0.3 to 12 seconds). A result such as "the other side saw the leave" means it was observed after the stated wait, not that it was timed.
- The results were saved as raw output from the run. The same run was made twice with the same results.

## Findings

### 1. No track-stop call is observed for the camera or microphone. Tested, with limits

- The page requests camera and microphone as it loads, before anyone chooses Join Now. After load, the camera track and the microphone track were both live.
- After Start Video then Stop Video, the camera track was still live. Stop Video swaps which video is sent to others.
- After End, both tracks were still live.
- The code has no call that stops either track (**code reading**: the `getUserMedia` call at load, `cameraButton` and `callButton` in `public/room.js`). What the browser does with the tracks when the tab closes is **Not established**. Whether a phone or browser indicator is on is **Not established**.
- The product rule that Stop Video stops camera capture is not met by this code, on this evidence.

### 2. Mute leaves the microphone track live. Tested

- After Mute, the microphone track was live with `enabled` set to false. Whether others hear silence was not measured.
- Source: `muteButton` in `public/room.js`.

### 3. A room member learns later joiners' IDs, and an unsolicited call was answered with an audio track. Tested, narrow

- **Code reading**: when someone joins a room, `src/index.ts` (the `join-room` handler) sends the new joiner's supplied id to the clients already in that room. It does not send the existing list to the newcomer. Any non-empty room name is accepted.
- **Tested**: a test client with no page and no camera joined a room by name. When a second person later joined, the test client received that person's id. A separate test client then called that id with an audio stream and received a stream back with one audio track and no video track.
- A received audio track is not measured audible audio. This test does not show that a stranger can hear anyone in general. It shows that an unauthenticated room member learns a later joiner's id and that an unsolicited call was answered with an audio track. Any claim of hearing needs a joined, unmuted, captured person and measured delivery, which was not tested.
- The list of connected peers is not exposed: the PeerJS peer list address answered 401 (not allowed).
- This is the area the earlier security review called "P1". The room name is the only barrier, and the roadmap records that open links are a product choice. Whether guessable names matter is a decision for the owner.

### 4. Joining, leaving and rejoining. Tested

- Two people joining at the same time each saw one other person and a connected call.
- After End on one side, the other side showed no one in the room by the time of the check, 1.5 seconds later. Rejoining reconnected both.
- After a refresh, and after closing a tab, the other side showed the leave when checked 1.5 and 2 seconds later. After the refresh the page showed "Choose Join Now", and rejoining reconnected both.
- These are observed-after-a-wait checks, not timings. They ran on one machine, so they show the room logic, not real network behavior.

### 5. Refusing camera permission. Tested in part

- **Tested**: the check replaced `getUserMedia` with a rejection. It is an injected failure, not a real browser permission decision. The page then showed "Camera and microphone are unavailable: Permission denied", and the Join Now button was enabled.
- **Code reading only**: that someone can then join with a photo and no audio. The check did not click Join Now.

### 6. Recovery after a network cut. Not established

- A 10-second offline switch in the test browser did not break the call, because both sides were on one machine. This says nothing about real networks. The code's only recovery step is `peer.reconnect()` 5 seconds after the signal connection reports `disconnected`. A rejoin to the room after a drop was not found in the code (code reading only).

### 7. Not established

- Physical camera and microphone indicators on any device.
- Revoking camera permission in the middle of a call. The code has no handler for a track ending (code reading only).
- Locking a phone and returning, switching apps, and navigating away on a phone.
- Direct versus relayed calls across separate networks, and whether Twilio relay is configured.
- Wake-up time after the free host sleeps.
- Behavior in Safari, Firefox, and on phones.
- The server side of the live deploy.

### 8. Metadata. Recorded, not changed

- `package.json` still names `pinto-pinto/pinto` in its `repository` field. The source repo is `soliskit/pinto`.

## What this means

Findings 1 to 3 are the work to decide on after this report is accepted. None is fixed here. The real-device checks in section 7 need a list of devices and browsers from the owner. Until they run, the audit cannot claim "works every time".

## Next steps for the owner

1. Read and accept this report, or send it back.
2. Choose whether to fix findings 1 and 2 (stop the camera and microphone) and decide finding 3.
3. Provide the devices and browsers for the real-device checks in section 7.
4. The independent review of this audit, which the roadmap calls for, comes before any implementation.
