# Row 51 kill/observation proxy - tooling design note

Authored test tooling under the reviewed row 51 verification plan (sha1
9cf07f0514cece342e8bb6515f772240bb78dfc1, "the kill/observation proxy
named below (including its /config interception) is planned test
tooling: separately subject to the project's existing code and test
rules (its own review, PR, and approval)"). Tooling preparation approved
by the owner's option 1: ask phonemsg-01M6D4JJQG5Q2NJSJXDFBF0QQ2
(7:24:17 PM) -> "1" phonemsg-01M6D4KZFKK76M9FNPJBSSFRTR (7:25:02 PM).
Preparation only: ANY run needs its own fresh owner yes. No pinto code
changes; the proxy never touches pinto's bytes.

## Files

- `ws-frame-parser.mjs` - incremental websocket frame parser +
  serializer. Parse-only tee; `MessageReassembler` folds fragmentation.
  No dependencies.
- `row51-proxy.mjs` - the proxy itself. Pure Node (`node:net`,
  `node:http`, `node:fs`, `node:crypto`); NO new package dependencies,
  so the PR carries no lockfile change.
- `row51-proxy.test.mjs` - `node --test` suite. Synthetic loopback
  upstreams and clients only: no pinto, no browser, no non-loopback
  traffic.

## Plan requirement -> implementation -> test

| Plan (section) | Implementation | Test |
| --- | --- | --- |
| Peer ws identifiable by upgrade path `/peerjs` + key/id/token query, distinct from socket.io's `/socket.io/` (SCENARIO A; grounded: peerjs@1.5.5 builds `<path>peerjs?key=...`, pinto passes path `/`, room.js:70-79; peer@1.0.2 serves `WS_PATH='peerjs'`) | `classifyUpgrade` on the parsed request line | classification test (peer/socketio/other) |
| Kill: detach server leg BEFORE closing client leg; no data/FIN/RST/close server-ward until tidy; mode fin vs close-frame logged (SCENARIO A) | `/kill` control: sets both forward flags false, then ends the client leg (bare FIN or one unmasked 1001 close frame); server leg kept open, drained+counted | kill-fin and kill-close-frame tests assert upstream receives NOTHING (no bytes, no FIN, no close frame) until `/tidy` |
| The ordinary-piping close leak is the named risk | forwarding only ever passes raw bytes while attached; the kill detaches first | same tests |
| Server-SEEN drop for scenario B (close delivered) | `/deliver` control: masked 1001 close frame server-ward (mode close-frame) or bare FIN (mode fin), logged | both deliver tests |
| Tidy after the decision point, logged | `/tidy` closes the detached server leg, logged | kill-fin test's second half |
| Frame log from CONNECTION START, both directions; the OPEN can share one read with the end of the 101 header (CAPTURE COMPLETENESS) | the 101 head is parsed first on the server leg; leftover bytes go straight to the frame parser AND the client (this was a real bug the suite caught in the first draft: leftovers were neither logged nor forwarded) | coalesced 101+OPEN test; parser split-at-every-byte test |
| Negotiated compression recorded (line 65) | `ws-101` event carries `sec-websocket-extensions` | asserted in the coalesced test (null here) |
| /config interception: exactly one route, exactly one field, re-serialized; everything else byte-identical; surprises fail closed (MEDIA CONTAINMENT) | GET `/config` responses buffered, `iceServers` replaced with `[]`, re-serialized with corrected content-length; any anomaly (non-JSON, missing field, bad framing) logs `config-intercept-fail` and closes both legs | interception test (key preserved, list emptied, keep-alive second request byte-identical), fail-closed test, chunked pass-through test |
| Per-page proxy ports; socket.io handshake tied to its page (lines 47/52) | one listen port per `--page label:port`; every connection event carries the page label | suite uses two page ports |
| Heartbeat forward timestamps; the server's last received heartbeat (SETUP VALIDATION 1) | `heartbeat-forwarded` events per peer conn + `lastHeartbeatForwarded` in `/conns` | decision-point test |
| Bounded no-OPEN decision point (~first post-resume heartbeat with no preceding OPEN) | DERIVED events `open-frame` and `decision-point` (labeled derived; raw frames stay primary) | both decision-point tests |
| The timed-action entity is NAMED (line 44) | the human tester, driving the browser by hand per the ACTION PROTOCOL, operating the proxy through the control endpoint, reading R (the replacement's 101 completion) from the live log stream; NOTHING scripted - so no scripted driver is authored or needed | n/a |
| DOM checkpoint method (EVIDENCE CHANNELS) | the tester's DevTools console read of `document.getElementById('call').disabled` and `.textContent`, evidenced by screenshot | n/a |
| Plain HTTP/1.1 both legs (stated, not assumed); local-only | loopback-only listen and target (non-loopback targets refused at startup) | refusal covered by construction |

## Run context (NOT part of this tooling; restated for the PR reviewer)

The run is pinned to grounding commit f542ff5 with `npm ci` from its
lockfile; the server runs plain HTTP locally; the packet capture is an
EXISTING tool (tcpdump/tshark), not authored code; pages use fresh
profiles, fake media, one window each, one proxy port each. The proxy's
own build hash and the served client hash are recorded at setup (plan
line 17).

## Hygiene (ARTIFACTS AND DATA HYGIENE)

Logs stay local. Handshake URLs carry the peer id and token; frame-log
text and `/conns` carry ids; all redaction happens at report time, not
in the proxy (raw records are the evidence). Screen/log exports redact
ids, tokens and machine addresses before leaving the run machine.

## Verification performed (preparation scope)

`node --test row51-proxy.test.mjs`: 16/16 PASS (Node v22.23.4; the code
uses no version-specific APIs beyond what the project's Node 26 also
has). The suite caught and now covers one real first-draft bug
(coalesced post-101 bytes neither logged nor forwarded - exactly the
false-no-OPEN manufacturing shape the plan's parser-robustness section
names). The proxy has NEVER run against pinto, a browser, or any
non-loopback peer.

## Known limits (for the lenses)

- Parse errors on the tee reset the parser for that direction (logged,
  forwarding never blocked) - capture completeness then rests on the
  packet capture, per the plan's two-parser rule.
- HTTP/1.0 without content-length is treated as close-delimited; the
  run's clients are HTTP/1.1.
- The control endpoint has no auth: loopback-only, run-local, gone with
  the process.
