# Pinto Audit Report

Local results for camera capture, call access, and connection handling.

Local checks found a live camera track after Stop Video, a live microphone track after Mute, and both live after End. The app also answers calls without checking room membership. The accepted findings guide the fix plan in [decisions P20 to P22](../decisions.md). They do not establish real-device behavior or the live server's behavior.

This report records Phase A at the source version below.

The button names and messages quoted here are the ones at the audited commit.

The findings distinguish **Tested**, **Code Reading Only**, and **Not Established**. Finding 5 summarizes the other findings. The source and run records below are evidence context, not additional findings.

"Tested" means a check run on a local copy of this commit, in one of two ways:

- (a) The page in headless Chromium with a fake camera and microphone on Linux. This shows what the page's code does with the camera and microphone tracks.
- (b) The server alone, driven by plain Socket.IO test clients. This shows what the server does with room and id messages, and nothing about the page.

Some checks combine both and say so. Tested results do not show what a phone or browser indicator light does, and they do not measure whether sound is audible. All physical-indicator checks and all real-device checks are **Not Established**.

## What was recorded

| Item                  | Record                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code version          | `main` at `7255398b7c3ae50c7955acd969f02021e5787d1e`, October 8, 2026, 00:37 PDT.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Recheck               | On October 11, 2026, findings 1 to 11 were rechecked against `main` at `a1cb306`: unchanged. On October 12, 2026, `public/room.js` on `main` at `7008d62` (SHA-256 `a07dea2f...c90f6b8d`) still has no call that ends a camera or microphone track. That file's text has changed since the audit, so its hash differs from the October 8 hash in the Live site row, and the other findings were not rechecked against it.                                                                                                                                                                                         |
| Live site             | On October 8, 2026, `https://pinto-zd0c.onrender.com` answered HTTP 200. Its `room.js` and `home.js` have the same SHA-256 as `public/room.js` and `public/home.js` on `main` (`f5f1e09a...2d882e9e` and `0dde875c...098323d0`). Whether the deployed server code matches this commit is **Not Established**, because the server side is not visible. Render's documentation says a free web service spins down after 15 minutes without inbound traffic and takes about a minute to spin back up ([source](https://render.com/docs/free), read October 8, 2026); the wake-up time of this site was not measured. |
| Packages              | From `package-lock.json`: express 5.2.1, peer 1.0.2, peerjs 1.5.5, socket.io 4.8.4, ws 8.22.0, playwright 1.63.0 (dev).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Settings (names only) | `PORT`, `KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`. Whether the Twilio names are set on Render is **Not Established**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Test baseline         | **Tested**, on Node 22.23.3 with Chromium headless shell 153, from a clean clone of the commit above: `npm run typecheck` exited 0, `npm run lint` exited 0, and `PORT=0 npm test` exited 0 with 47 tests, 8 suites, 47 pass, 0 fail, 0 cancelled, 0 skipped.                                                                                                                                                                                                                                                                                                                                                     |
| Test devices          | Headless Chromium 153 on Linux only. No phone, tablet, or other browser has been tested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Method for the checks below

- A script (`phase-a-headless-checks`) started the app's server from the clone on a free local port. It opened pages in headless Chromium with a fake camera and microphone. It never touched the live site's rooms. The live site got plain page loads for the file comparison only.
- The page's own tracks (`readyState` and `enabled`) gave the camera and microphone state after each action.
- Waits between actions were fixed sleeps (0.3 to 12 seconds). A result such as "the other side saw the leave" means it was observed after the stated wait. It was not timed.
- A second script drove only the Socket.IO server with plain test clients, to check room membership and id handling. It does not run the page's code, so what it shows about the page is limited as stated below.
- A third script combined pages and plain test clients for the video-delivery, spoofed-leave, and repeated-join checks.
- The raw output of each run was saved.

## Findings

### 1. Camera and microphone tracks stay live after Stop Video, Mute, and End

A track is one stream of audio or video, such as the camera's or the microphone's. A track is live until it is ended.

- **Tested** (track state in the test browser, headless with fake devices): the page asks for the camera and microphone as it loads, before anyone chooses Join Now. After load, both tracks were live. After Start Video then Stop Video, the camera track was still live. After Mute, the microphone track was live with `enabled` set to false. After End, both tracks were still live.
- **Code Reading Only**: a search of `public/` and `src/` for `stop`, `getTracks`, `removeTrack`, and `close()` found no call that ends a camera or microphone track. The only matches are `removeTrack` on the outgoing stream, which takes a track out of the stream without ending it, and `call.close()`. The search covers the app's own files, not the vendored libraries. It reflects those searches and the handlers read, not a proof about every possible path. Mute sets `enabled` on the audio tracks. End calls `removeCall` for each call, which closes the call, and reconnects the signal socket.
- **Not Established**: what the browser does with the tracks when a tab closes, whether a camera or microphone indicator is on (on any device), and whether the page behaves the same on phones.
- The capture rule is recorded in [decision P21](../decisions.md). It says Stop Video stops camera capture and Mute stops microphone capture. Against that rule, the local test shows those actions did not end the tracks. Decisions about Stop Video, Mute, and End are separate, and so is the decision about starting capture at page load. See the end of this report.

### 2. Video controls changed the received video size in one local call

- **Code Reading Only**: the outgoing stream starts with the photo video track. `sendVideo` tries to replace the video sender's track and does not check the result of `replaceTrack`. If a call has no video sender, `sendVideo` skips the replacement, and that path was not tested.
- **Tested**: in the normal two-page call below, a video sender existed before Start Video. The unsolicited call in finding 3 showed zero video tracks at the moment of its stream event. So this report does not claim that every call has a video sender.
- **Tested** (two test pages, fake camera): after joining, the other page's tile was 400 by 300 (the photo). That is the decoded video size, read as `videoWidth` and `videoHeight`, not the size shown on screen. After Start Video, the sending side's video sender carried the fake camera track and the other page's tile was 640 by 480. After Stop Video, the sender carried the photo track again and the tile returned to 400 by 300. The decoded video dimensions changed with the controls. This does not check picture content, and it is one run on one machine.
- **Not Established**: what happens if `replaceTrack` fails. The old track could then stay attached to the sender, so an outgoing camera feed could continue after Stop Video. That failure was not tested.

### 3. Incoming calls are answered with no check of who is calling

- **Code Reading Only**: `peer.on('call')` in `public/room.js` answers with the outgoing stream whenever the page is in the joined state. It does not check that the caller is in the same room or is an expected participant.
- **Tested**: a caller page that never joined any room placed a call to a joined person's id, and the call was answered. When the caller's stream event fired, the stream had one audio track and no video track. The answering page's outgoing stream starts with a video track (finding 2), and why the count was zero at that moment was not investigated. The id came from a separate test client in the room (finding 4).
- Receiving an audio track does not prove that anyone could hear it. Hearing would need a joined, unmuted, captured person and measured delivery, and that was not tested.

### 4. Room joining accepts any non-empty room name and id, and verifies neither

- **Code Reading Only**: the `join-room` handler in `src/index.ts` accepts any non-empty string as a room name and any non-empty string as an id. It does not check that the id belongs to the sender or matches a real PeerJS identity. It shows no limit on how often a socket may join or how long the strings are. It sends the supplied id to the clients already in that room as `user-connected`, and it does not send the existing list to the newcomer. On `user-connected` the page places a call to the supplied id. On `user-disconnected` it removes the call with the supplied id (`public/room.js`).
- **Tested** (server only): a client already in a room received the id of a later joiner. A client that claimed the id `not-my-peer-id` caused the room's other client to receive that id unchanged.
- **Tested** (pages plus a plain test client, one step at a time): a test client in a room learned the ids of two people who then joined and connected (one remote tile each). The client then sent one false `join-room` using one person's id. One page then showed a second remote tile, because the page placed a second call to that id. The other page still showed one. The client then disconnected, which sent one false leave notice. Both pages then showed zero remote tiles, and all their connection objects were `closed`. This check separates the observations after the false join and after the later false leave. It does not test a false leave without that earlier false join. One run, after fixed waits.
- **Tested**: the PeerJS peer list addresses `/pinto/peers` and `/peerjs/peers` answered 401. That covers those two requests only. It does not show that no other way to learn ids exists, and the room notice above is such a way.
- **Tested** (page plus a plain test client): a joined page told to call an id that is not a real peer showed no error and no tile, and its button stayed "End". One run.
- **Code Reading Only**: `GET /config` returns the PeerJS key and ICE server list to any requester. This is a code fact. Whether it matters is an open decision.

### 5. Call access: summary of the evidence

| Step                             | What this audit shows                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knowing a room name              | Anyone can try any name. `src/index.ts`, read in full, has no sign-in or other check besides the static files and the PeerJS server. (Code Reading Only)                                                                                                                                                                                                        |
| Entering the room's signaling    | `join-room` has no check beyond non-empty text. (Code reading only; tested for the server)                                                                                                                                                                                                                                                                      |
| Learning a peer id               | Clients already in a room receive later joiners' ids. (Tested)                                                                                                                                                                                                                                                                                                  |
| Calling a peer id                | A caller that never joined was answered. (Tested) Separately, a client that had not joined as a person announced its own peer id through a false join notice. Two joined pages called it and it answered. At the stream event, each of the 4 calls showed one audio and one video track. This does not show audible audio or picture content. (Tested, one run) |
| Ending someone else's call       | A client claiming another person's id and disconnecting ended that call on both sides. (Tested)                                                                                                                                                                                                                                                                 |
| Audible audio or picture content | Not Established.                                                                                                                                                                                                                                                                                                                                                |

The roadmap records open links as a product choice. The exposure in the table is a security fact. Whether to accept it is a policy decision, and neither depends on the other.

### 6. Room lifecycle on the server

- **Tested** (server only): one client joined the same room twice. When it disconnected, the room's other client received two leave events for that id. One client joined two rooms. When it disconnected, each room received one leave event.
- **Tested** (server only): one client sent 5,000 `join-room` messages for one room in a loop, and the server accepted all of them. When that client disconnected, the room's other client received 5,000 leave events. Memory use, processing time, and crash behavior were not measured.
- **Code Reading Only**: the `disconnect` handler is registered inside `join-room`, so each join adds one, and each join also broadcasts `user-connected`. A socket stays in every room it has joined. The page's own flow joins once per connection, because End reconnects the socket. Whether the page can reach a repeated join is **Not Established**.
- **Not Established**: the effect of repeated joins on server memory, speed, or stability, and any denial-of-service impact.

### 7. Reconnection and room membership

- **Code Reading Only**: after End, the page reconnects its socket and does not rejoin, which is intended. After an unexpected socket drop, nothing in `public/room.js` handles reconnection. The room is not rejoined, and the page's `joined` state stays true. In that file the only socket calls are creating the socket, emitting `join-room`, `disconnect().connect()` in End, and the two handlers `user-connected` and `user-disconnected`. The only recovery code is `peer.reconnect()` five seconds after PeerJS reports `disconnected`. It covers the PeerJS connection, not the room.
- **Tested** (server only, with a test client that uses the same default socket settings as the page): after an abrupt transport drop, the client reconnected automatically and then received no later join events for its room.
- **Not Established**: whether this happens in the page on real networks, and what a person would see.
- **Code Reading Only**: the page sets `joined` right after emitting `join-room`, with no acknowledgement from the server. If the join fails, the page can show a joined state that the server does not share. The tests exercised only successful joins.

### 8. Joining, leaving, and rejoining in local tests

- What was checked: the count of remote video tiles on the page (a tile is added when the page receives a stream) and the state of the browser's WebRTC connection objects. Audio delivery and picture content were not checked.
- Two test pages joining at the same time each showed one remote tile. Each side had two connection objects, one `connected` and one `closed`.
- After End on one side, the other side showed zero tiles when checked 1.5 seconds later. Rejoining showed one tile on each side.
- After a refresh, the other side showed zero tiles when checked 1.5 seconds later. After closing a tab, the other side showed zero tiles when checked 2 seconds later. After the refresh the page showed "Choose Join Now", and rejoining showed one tile on each side.
- These are checks after fixed waits, not timings, on one machine.
- **Code Reading Only**: a call's tile is added when its stream arrives, without checking that the call is still the current one for that person. A stale tile after a replaced or closed call is possible, but it is not established in practice. The call's `error` handler only logs to the console, and cleanup runs on the call's `close` event. Whether PeerJS fires `close` after an error was not tested.

### 9. Simulated camera and microphone refusal

- **Tested**: the check replaced `getUserMedia` with an injected rejection of the combined camera-and-microphone request. It was not a real browser permission decision. The page then showed "Camera and microphone are unavailable: Permission denied", and the Join Now button was enabled.
- **Code Reading Only**: the page asks for camera and microphone in one request. If it fails, the page still enables Join Now, because it marks capture finished either way. So someone can join without captured camera or microphone tracks, and the outgoing stream still holds the canvas photo video track. There is no fallback to camera only or microphone only. While capture is pending, Join Now stays disabled (**Tested**, with capture delayed 4 seconds), and a call arriving before joining is closed (code reading only).
- **Not Established**: that someone can then join, deliver a photo, or hold a call. Join Now was not clicked.
- **Not Established**: a real permission prompt, a camera-only refusal, a microphone-only refusal, and a missing individual device.

### 10. Network-cut recovery: Not Established

- A 10-second offline switch in the test browser produced no confirmed call interruption, so it did not exercise recovery. What a real network failure does is not established.

### 11. Checks still open

- Physical camera and microphone indicators on any device.
- What happens when `replaceTrack` fails.
- Revoking camera permission in the middle of a call. The page has no handler for a track ending (code reading only).
- Locking a phone and returning, switching apps, and navigating away on a phone.
- Direct versus relayed calls across separate networks, and whether Twilio relay is configured.
- Wake-up time after the free host sleeps.
- Behavior in Safari, Firefox, and on phones.
- Whether the deployed server code matches this commit.
- Server memory, speed, and stability under repeated joins.
- Stale tiles after a replaced call, and PeerJS behavior after a call error.

### 12. Repository metadata: Code Reading Only

- `package.json` named `pinto-pinto/pinto` in its `repository` field. The source repo is `soliskit/pinto`. Fixed in PR #54.

## What this means

Findings 1 to 7 are tracked in the decision log (P20 to P22), and none is fixed here. The real-device checks in finding 11 follow the test plan (P22). Until they run, the audit cannot claim "works every time".

Whether findings 6 and 7 (room lifecycle and reconnection) need fixing before the real-device checks is an open decision in the [decision log](../decisions.md).
