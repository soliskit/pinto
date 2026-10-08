# Audit report: Phase A, existing app

This is the written report for Phase A of the Pinto audit: an audit of the app as it exists today. It follows the held-still list and limits in [audit-readiness.md](audit-readiness.md). It is read-only. It fixes nothing, changes no code, tests, workflows or settings, and costs nothing. Fixes and new features wait until this report is accepted.

Every numbered finding below is labeled **Tested**, **Code reading only** or **Not established**. The "What was recorded" table lists plain facts read from the repository, the live site or a run. They are records, not findings. "Tested" means a check run on a local copy of this commit, in one of two ways: (a) the page in headless Chromium with a fake camera and microphone on Linux, which shows what the page's code does with the camera and microphone tracks; or (b) the server alone, driven by plain Socket.IO test clients, which shows what the server does with room and id messages and nothing about the page. It does not show what a phone or browser indicator light does, and it does not measure whether sound is audible. All physical-indicator checks and all real-device checks are **Not established**.

## What was recorded

| Item | Record |
| --- | --- |
| Code version | `main` at `7255398b7c3ae50c7955acd969f02021e5787d1e`, October 8, 2026, 00:37 PDT. |
| Live site | `https://pinto-zd0c.onrender.com` answered HTTP 200. Its `room.js` and `home.js` have the same SHA-256 as `public/room.js` and `public/home.js` on `main` (`f5f1e09a...2d882e9e` and `0dde875c...098323d0`). Whether the deployed server code matches this commit is **Not established**; the server side is not visible. Render's free plan sleeps after 15 idle minutes; the wake-up time was not measured. |
| Packages | From `package-lock.json`: express 5.2.1, peer 1.0.2, peerjs 1.5.5, socket.io 4.8.4, ws 8.22.0, playwright 1.63.0 (dev). |
| Settings (names only) | `PORT`, `KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`. Whether the Twilio names are set on Render is **Not established**. |
| Test baseline | **Tested**, on Node 22.23.3 with Chromium headless shell 153, from a clean clone of the commit above: `npm run typecheck` exit 0; `npm run lint` exit 0; `PORT=0 npm test` exit 0 with 47 tests, 8 suites, 47 pass, 0 fail, 0 cancelled, 0 skipped. |
| Test devices | Headless Chromium 153 on Linux only. No phone, tablet or other browser has been tested. |

## Method for the checks below

- A script (`phase-a-headless-checks`) started the app's server from the clone on a free local port and opened pages in headless Chromium with a fake camera and microphone. It never touched the live site's rooms; the live site got plain page loads for the file comparison only.
- Camera and microphone state was read from the page's own tracks (`readyState` and `enabled`) after each action.
- Waits between actions were fixed sleeps (0.3 to 12 seconds). A result such as "the other side saw the leave" means it was observed after the stated wait, not that it was timed.
- A second script drove only the Socket.IO server with plain test clients, to check room membership and id handling. It does not run the page's code, so what it shows about the page is limited as stated below.
- The results were saved as raw output from the run.

## Findings

### 1. Camera and microphone tracks stay live after Stop Video, Mute and End

- **Tested** (track state in the test browser, headless with fake devices): the page requests camera and microphone as it loads, before anyone chooses Join Now. After load, both tracks were live. After Start Video then Stop Video, the camera track was still live. After Mute, the microphone track was live with `enabled` set to false. After End, both tracks were still live.
- **Code reading only**: a search of `public/` and `src/` for `stop(` found no match, so nothing in the app's own files ends either track. This is about the app's files, not the vendored libraries. Stop Video sets the outgoing video to the photo track locally and calls `replaceTrack` on a found video sender without checking the result (`sendVideo` in `public/room.js`). Mute sets `enabled` on the audio tracks. End closes calls and reconnects the signal socket.
- **Not established**: whether another participant actually receives the photo after Stop Video; what the browser does with the tracks when a tab closes; whether a camera or microphone indicator is on, on any device; whether the page behaves the same on phones.
- The owner's product rule, stated in the owner's project decisions and not in this repo, is that Stop Video stops camera capture and Mute stops microphone capture. Against that rule, the local test shows the tracks were not ended by those actions. Decisions about Stop Video, Mute and End are separate; see the end of this report.

### 2. Incoming calls are answered with no check of who is calling

- **Code reading only**: `peer.on('call')` in `public/room.js` answers with the outgoing stream whenever the page is in the joined state. It does not check that the caller is in the same room or is an expected participant.
- **Tested**: a caller page that never joined any room placed a call to a joined person's id and was answered with a stream that had one audio track and no video track. The id came from a separate test client in the room (finding 3).
- A received audio track is not measured audible audio. This report makes no claim that anyone heard anything. Hearing would need a joined, unmuted, captured person and measured delivery, which was not tested.

### 3. Room joining accepts any room name and any id

- **Code reading only**: the `join-room` handler in `src/index.ts` accepts any non-empty room name and any non-empty id. It does not check that the id belongs to the sender or matches a real PeerJS identity. It sends the supplied id to the clients already in that room as `user-connected`. It does not send the existing list to the newcomer.
- **Tested** (server only, with plain test clients): a client already in a room received the id of a later joiner. A client that claimed the id `not-my-peer-id` caused the room's other client to receive that id unchanged.
- **Tested**: the PeerJS peer list address `/pinto/peers` and `/peerjs/peers` answered 401. This covers those two requests only. It does not show that no other way to learn ids exists, and finding 3 itself is such a way.
- **Not established**: what the page does when it is told to call an id that is not a real peer.

### 4. Who can do what, kept separate

| Step | What this audit shows |
| --- | --- |
| Knowing a room name | Anyone can try any name. No sign-in exists. (Code reading) |
| Entering the room's signaling | `join-room` has no check beyond non-empty text. (Code reading, tested for the server) |
| Learning a peer id | Clients already in a room receive later joiners' ids. (Tested) |
| Calling a peer id | A caller that never joined was answered. (Tested) |
| Hearing or seeing anything | Not established. |

The roadmap records open links as a product choice. The exposure in the table is a security fact. Whether to accept it is the owner's policy decision, and neither depends on the other.

### 5. Room lifecycle on the server

- **Tested** (server only): one client joined the same room twice; when it disconnected, the room's other client received two leave events for that id. One client joined two rooms; when it disconnected, each room received one leave event.
- **Code reading only**: the `disconnect` handler is registered inside `join-room`, so each join adds one. A socket stays in every room it has joined. The page's own flow joins once per connection, because End reconnects the socket; whether the page can reach a repeated join is **Not established**.
- Impact on real calls is **Not established**.

### 6. Reconnection and room membership

- **Code reading only**: after End, the page reconnects its socket and does not rejoin, which is intended. After an unexpected socket drop, nothing in `public/room.js` handles reconnection (the only socket handlers are `user-connected` and `user-disconnected`), so the room is not rejoined and the page's `joined` state stays true. The only recovery code is `peer.reconnect()` five seconds after PeerJS reports `disconnected`, which covers the PeerJS connection, not the room.
- **Tested** (server only, with a test client that uses the same default socket settings as the page): after an abrupt transport drop the client reconnected automatically and then received no later join events for its room.
- **Not established**: whether this happens in the page on real networks, and what a person would see.
- **Code reading only**: the page sets `joined` immediately after emitting `join-room`, with no acknowledgement from the server. If the join fails, the page can show a joined state that the server does not share. The tests exercised only successful joins.

### 7. Joining, leaving and rejoining. Tested, narrow

- What was checked: the count of remote video tiles on the page (a tile is added when the page receives a stream) and the state of the browser's WebRTC connection objects. It was not checked that audio or video was delivered or was correct.
- Two people joining at the same time each showed one remote tile. Each side had two connection objects, one `connected` and one `closed`.
- After End on one side, the other side showed zero tiles when checked 1.5 seconds later. Rejoining showed one tile on each side.
- After a refresh, and after closing a tab, the other side showed zero tiles when checked 1.5 and 2 seconds later. After the refresh the page showed "Choose Join Now", and rejoining showed one tile on each side.
- These are checks after fixed waits, not timings, on one machine.

### 8. Camera and microphone permission refusal. Tested in part

- **Tested**: the check replaced `getUserMedia` with an injected rejection of the combined camera-and-microphone request. It was not a real browser permission decision. The page then showed "Camera and microphone are unavailable: Permission denied", and the Join Now button was enabled.
- **Not established**: that someone can then join, deliver a photo, or hold a call. Join Now was not clicked.
- **Not established**: a real permission prompt, a camera-only refusal, a microphone-only refusal, and a missing individual device.

### 9. Recovery after a network cut. Not established

- A 10-second offline switch in the test browser produced no detected call interruption during the checks. Why, and what a real network failure does, are not established.

### 10. Not established

- Physical camera and microphone indicators on any device.
- Whether another participant receives the photo after Stop Video.
- Revoking camera permission in the middle of a call. The page has no handler for a track ending (code reading only).
- Locking a phone and returning, switching apps, and navigating away on a phone.
- Direct versus relayed calls across separate networks, and whether Twilio relay is configured.
- Wake-up time after the free host sleeps.
- Behavior in Safari, Firefox, and on phones.
- Whether the deployed server code matches this commit.

### 11. Metadata. Code reading only

- `package.json` still names `pinto-pinto/pinto` in its `repository` field. The source repo is `soliskit/pinto`. This is recorded, not changed.

## What this means

Findings 1 to 6 are the work to decide on after this report is accepted. None is fixed here. The real-device checks in finding 10 need a list of devices and browsers from the owner. Until they run, the audit cannot claim "works every time".

## Decisions for the owner

1. Read and accept this report, or send it back.
2. Decide separately whether Stop Video, Mute and End should each end their track. Each is its own decision.
3. Decide whether the exposure in finding 4 is acceptable for open links.
4. Decide whether the reconnection and room-lifecycle risks in findings 5 and 6 need fixing before real-device checks.
5. Provide the devices and browsers for the real-device checks.
6. The independent review of this audit, which the roadmap calls for, comes before any implementation.
