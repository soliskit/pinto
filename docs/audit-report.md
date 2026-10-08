# Audit report: Phase A, existing app

This is the written report for Phase A of the Pinto audit: an audit of the app's repository at the commit named below, tested on a local copy. The live deployment's server behavior was not verified. It follows the held-still list and limits in [audit-readiness.md](audit-readiness.md). It is read-only. It fixes nothing, changes no code, tests, workflows or settings, and costs nothing. Fixes and new features wait until this report is accepted.

Every numbered finding below is labeled **Tested**, **Code reading only** or **Not established**, except finding 5, which is a summary table of evidence labeled in other findings. The "What was recorded" table lists plain facts read from the repository, the live site or a run. They are records, not findings. "Tested" means a check run on a local copy of this commit, in one of two ways: (a) the page in headless Chromium with a fake camera and microphone on Linux, which shows what the page's code does with the camera and microphone tracks; or (b) the server alone, driven by plain Socket.IO test clients, which shows what the server does with room and id messages and nothing about the page. Some checks combine both and say so. It does not show what a phone or browser indicator light does, and it does not measure whether sound is audible. All physical-indicator checks and all real-device checks are **Not established**.

## What was recorded

| Item | Record |
| --- | --- |
| Code version | `main` at `7255398b7c3ae50c7955acd969f02021e5787d1e`, October 8, 2026, 00:37 PDT. |
| Live site | `https://pinto-zd0c.onrender.com` answered HTTP 200. Its `room.js` and `home.js` have the same SHA-256 as `public/room.js` and `public/home.js` on `main` (`f5f1e09a...2d882e9e` and `0dde875c...098323d0`). Whether the deployed server code matches this commit is **Not established**; the server side is not visible. Render's documentation says a free web service spins down after 15 minutes without inbound traffic and takes about a minute to spin back up ([source](https://render.com/docs/free), read October 8, 2026); the wake-up time of this site was not measured. |
| Packages | From `package-lock.json`: express 5.2.1, peer 1.0.2, peerjs 1.5.5, socket.io 4.8.4, ws 8.22.0, playwright 1.63.0 (dev). |
| Settings (names only) | `PORT`, `KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`. Whether the Twilio names are set on Render is **Not established**. |
| Test baseline | **Tested**, on Node 22.23.3 with Chromium headless shell 153, from a clean clone of the commit above: `npm run typecheck` exit 0; `npm run lint` exit 0; `PORT=0 npm test` exit 0 with 47 tests, 8 suites, 47 pass, 0 fail, 0 cancelled, 0 skipped. |
| Test devices | Headless Chromium 153 on Linux only. No phone, tablet or other browser has been tested. |

## Method for the checks below

- A script (`phase-a-headless-checks`) started the app's server from the clone on a free local port and opened pages in headless Chromium with a fake camera and microphone. It never touched the live site's rooms; the live site got plain page loads for the file comparison only.
- Camera and microphone state was read from the page's own tracks (`readyState` and `enabled`) after each action.
- Waits between actions were fixed sleeps (0.3 to 12 seconds). A result such as "the other side saw the leave" means it was observed after the stated wait, not that it was timed.
- A second script drove only the Socket.IO server with plain test clients, to check room membership and id handling. It does not run the page's code, so what it shows about the page is limited as stated below.
- A third script combined pages and plain test clients for the video-delivery, spoofed-leave and repeated-join checks.
- The results were saved as raw output from the run.

## Findings

### 1. Camera and microphone tracks stay live after Stop Video, Mute and End

- **Tested** (track state in the test browser, headless with fake devices): the page requests camera and microphone as it loads, before anyone chooses Join Now. After load, both tracks were live. After Start Video then Stop Video, the camera track was still live. After Mute, the microphone track was live with `enabled` set to false. After End, both tracks were still live.
- **Code reading only**: a search of `public/` and `src/` for `stop`, `getTracks`, `removeTrack` and `close()` found no call that ends a camera or microphone track. The only matches are `removeTrack` on the outgoing stream (it takes a track out of the stream without ending it) and `call.close()`. This is about the app's own files, not the vendored libraries, and it reflects those searches and the handlers read, not a proof about every possible path. Mute sets `enabled` on the audio tracks. End calls `removeCall` for each call, which closes the call, and reconnects the signal socket.
- **Not established**: what the browser does with the tracks when a tab closes; whether a camera or microphone indicator is on, on any device; whether the page behaves the same on phones.
- The owner's product rule, stated in the owner's project decisions and not in this repo, is that Stop Video stops camera capture and Mute stops microphone capture. Against that rule, the local test shows the tracks were not ended by those actions. Decisions about Stop Video, Mute and End are separate, and so is the decision about starting capture at page load; see the end of this report.

### 2. Start Video and Stop Video change what the other side receives. Tested in one case

- **Code reading only**: the outgoing stream starts with the photo video track, and `sendVideo` attempts to replace the video sender's track and does not check the result of `replaceTrack`. If a call has no video sender, sendVideo skips replacement; that path was not tested. **Tested**: in the normal two-page call below, a video sender existed before Start Video. The unsolicited call in finding 3 showed zero video tracks at the moment of its stream event, so this report does not claim that every call has a video sender.
- **Tested** (two test pages, fake camera): after joining, the other page's tile was 400 by 300 (decoded video size, read as `videoWidth` and `videoHeight`, not the size shown on screen) (the photo). After Start Video the sending side's video sender carried the fake camera track and the other page's tile was 640 by 480. After Stop Video the sender carried the photo track again and the tile returned to 400 by 300. This shows the delivered picture size changing in step with the controls. It does not check picture content, and it is one run on one machine.
- **Not established**: what happens if `replaceTrack` fails. In that case the old track could remain attached to the sender, so an outgoing camera feed continuing after Stop Video is a possible failure that was not tested.

### 3. Incoming calls are answered with no check of who is calling

- **Code reading only**: `peer.on('call')` in `public/room.js` answers with the outgoing stream whenever the page is in the joined state. It does not check that the caller is in the same room or is an expected participant.
- **Tested**: a caller page that never joined any room placed a call to a joined person's id and was answered. At the moment the caller's stream event fired, the stream had one audio track and no video track. The answering page's outgoing stream starts with a video track (finding 2), so why the count was zero at that moment was not investigated. The id came from a separate test client in the room (finding 4).
- A received audio track is not measured audible audio. This report makes no claim that anyone heard anything. Hearing would need a joined, unmuted, captured person and measured delivery, which was not tested.

### 4. Room joining accepts any non-empty room name and id, and verifies neither

- **Code reading only**: the `join-room` handler in `src/index.ts` accepts any non-empty string as a room name and any non-empty string as an id. It does not check that the id belongs to the sender or matches a real PeerJS identity, and it shows no limit on how often a socket may join or how long the strings are. It sends the supplied id to the clients already in that room as `user-connected`; it does not send the existing list to the newcomer. On `user-connected` the page places a call to the supplied id, and on `user-disconnected` it removes the call with the supplied id (`public/room.js`).
- **Tested** (server only): a client already in a room received the id of a later joiner. A client that claimed the id `not-my-peer-id` caused the room's other client to receive that id unchanged.
- **Tested** (pages plus a plain test client, one step at a time): a test client in a room learned the ids of two people who then joined and connected (one remote tile each). The client then sent one false `join-room` using one person's id. One page then showed a second remote tile, because the page placed a second call to that id; the other still showed one. The client then disconnected, sending one false leave notice. Both pages then showed zero remote tiles and all their connection objects were `closed`. This check separates the observations after the false join and after the later false leave; it does not test a false leave without that preceding false join. One run, after fixed waits.
- **Tested**: the PeerJS peer list address `/pinto/peers` and `/peerjs/peers` answered 401. This covers those two requests only. It does not show that no other way to learn ids exists, and the room notice above is such a way.
- **Tested** (page plus a plain test client): a joined page told to call an id that is not a real peer showed no error and no tile, and its button stayed "End". One run.
- **Code reading only**: `GET /config` returns the PeerJS key and ICE server list to any requester. This is a code fact; whether it matters is the owner's decision.

### 5. Who can do what, kept separate (summary of evidence from other findings)

| Step | What this audit shows |
| --- | --- |
| Knowing a room name | Anyone can try any name. `src/index.ts`, read in full, has no sign-in or other check besides the static files and the PeerJS server. (Code reading only) |
| Entering the room's signaling | `join-room` has no check beyond non-empty text. (Code reading only; tested for the server) |
| Learning a peer id | Clients already in a room receive later joiners' ids. (Tested) |
| Calling a peer id | A caller that never joined was answered. (Tested) Separately, a client that had not joined as a person, using its own peer id announced through a false join notice, was called by two joined pages and answered; at the stream event each of 4 calls showed one audio and one video track. This does not show audible audio or picture content. (Tested, one run) |
| Ending someone else's call | A client claiming another person's id and disconnecting ended that call on both sides. (Tested) |
| Audible audio or picture content | Not established. |

The roadmap records open links as a product choice. The exposure in the table is a security fact. Whether to accept it is the owner's policy decision, and neither depends on the other.

### 6. Room lifecycle on the server

- **Tested** (server only): one client joined the same room twice; when it disconnected, the room's other client received two leave events for that id. One client joined two rooms; when it disconnected, each room received one leave event.
- **Tested** (server only): one client sent 5,000 `join-room` messages for one room in a loop, and the server accepted all of them. When that client disconnected, the room's other client received 5,000 leave events. Memory use, processing time and crash behavior were not measured.
- **Code reading only**: the `disconnect` handler is registered inside `join-room`, so each join adds one, and each join also broadcasts `user-connected`. A socket stays in every room it has joined. The page's own flow joins once per connection, because End reconnects the socket; whether the page can reach a repeated join is **Not established**.
- **Not established**: the effect of repeated joins on server memory, speed or stability, and any denial-of-service impact.

### 7. Reconnection and room membership

- **Code reading only**: after End, the page reconnects its socket and does not rejoin, which is intended. After an unexpected socket drop, nothing in `public/room.js` handles reconnection, so the room is not rejoined and the page's `joined` state stays true. In that file the only socket calls are creating the socket, emitting `join-room`, `disconnect().connect()` in End, and the two handlers `user-connected` and `user-disconnected`. The only recovery code is `peer.reconnect()` five seconds after PeerJS reports `disconnected`, which covers the PeerJS connection, not the room.
- **Tested** (server only, with a test client that uses the same default socket settings as the page): after an abrupt transport drop the client reconnected automatically and then received no later join events for its room.
- **Not established**: whether this happens in the page on real networks, and what a person would see.
- **Code reading only**: the page sets `joined` immediately after emitting `join-room`, with no acknowledgement from the server. If the join fails, the page can show a joined state that the server does not share. The tests exercised only successful joins.

### 8. Joining, leaving and rejoining. Tested, narrow

- What was checked: the count of remote video tiles on the page (a tile is added when the page receives a stream) and the state of the browser's WebRTC connection objects. Audio delivery and picture content were not checked.
- Two test pages joining at the same time each showed one remote tile. Each side had two connection objects, one `connected` and one `closed`.
- After End on one side, the other side showed zero tiles when checked 1.5 seconds later. Rejoining showed one tile on each side.
- After a refresh, the other side showed zero tiles when checked 1.5 seconds later. After closing a tab, the other side showed zero tiles when checked 2 seconds later. After the refresh the page showed "Choose Join Now", and rejoining showed one tile on each side.
- These are checks after fixed waits, not timings, on one machine.
- **Code reading only**: a call's tile is added when its stream arrives, without checking the call is still the current one for that person, so a stale tile after a replaced or closed call is possible. Not established in practice. The call's `error` handler only logs to the console; cleanup runs on the call's `close` event. Whether PeerJS fires `close` after an error was not tested.

### 9. Camera and microphone permission refusal. Tested in part

- **Tested**: the check replaced `getUserMedia` with an injected rejection of the combined camera-and-microphone request. It was not a real browser permission decision. The page then showed "Camera and microphone are unavailable: Permission denied", and the Join Now button was enabled.
- **Code reading only**: the page asks for camera and microphone in one request. If it fails, the page still enables Join Now (it marks capture finished either way), so someone can join without captured camera or microphone tracks; the outgoing stream still contains the canvas photo video track. There is no fallback to camera only or microphone only. While capture is pending, Join Now stays disabled (**Tested**, with capture delayed 4 seconds) and a call arriving before joining is closed (code reading only).
- **Not established**: that someone can then join, deliver a photo or hold a call. Join Now was not clicked.
- **Not established**: a real permission prompt, a camera-only refusal, a microphone-only refusal, and a missing individual device.

### 10. Recovery after a network cut. Not established

- A 10-second offline switch in the test browser produced no confirmed call interruption, so it did not exercise recovery. What a real network failure does is not established.

### 11. Not established

- Physical camera and microphone indicators on any device.
- What happens when `replaceTrack` fails.
- Revoking camera permission in the middle of a call. The page has no handler for a track ending (code reading only).
- Locking a phone and returning, switching apps, and navigating away on a phone.
- Direct versus relayed calls across separate networks, and whether Twilio relay is configured.
- Wake-up time after the free host sleeps.
- Behavior in Safari, Firefox, and on phones.
- Whether the deployed server code matches this commit.
- Server memory, speed and stability under repeated joins.
- Stale tiles after a replaced call, and PeerJS behavior after a call error.

### 12. Metadata. Code reading only

- `package.json` still names `pinto-pinto/pinto` in its `repository` field. The source repo is `soliskit/pinto`. This is recorded, not changed.

## What this means

Findings 1 to 7 are the work to decide on after this report is accepted. None is fixed here. The real-device checks in finding 11 need a list of devices and browsers from the owner. Until they run, the audit cannot claim "works every time".

## Decisions for the owner

1. Read and accept this report, or send it back.
2. Decide separately whether Stop Video, Mute and End should each end their track. Each is its own decision.
3. Decide whether camera and microphone capture should start only after Join Now. It starts at page load today (finding 1). Nothing is inferred here about indicator lights.
4. Decide whether the exposure in finding 5 is acceptable for open links, including that the tested false-join-then-false-leave sequence can end a call.
5. Decide whether the reconnection and room-lifecycle risks in findings 6 and 7 need fixing before real-device checks.
6. Provide the devices and browsers for the real-device checks.
7. The independent review of this audit, which the roadmap calls for, comes before any implementation.
