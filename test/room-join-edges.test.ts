import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import type { Browser, BrowserContext, Page } from 'playwright'
import { io } from 'socket.io-client'
import { WebSocket } from 'ws'
import {
  eventually,
  launchBrowser,
  record,
  startServer,
  type Server
} from './helpers.ts'

// Step-4 coverage tests: the join and call edge paths the baseline showed
// uncovered. Kept in their own file so the WebKit trial's fixed pair of
// files stays untouched.

function heldJoinAnswer() {
  let realIo: typeof import('socket.io-client').io
  Object.defineProperty(window, 'io', {
    configurable: true,
    get() {
      return (...args: Parameters<typeof import('socket.io-client').io>) => {
        const socket = realIo(...args)
        window.roomSocket = socket
        const realEmit = socket.emit.bind(socket)
        socket.emit = (event: string, ...rest: unknown[]) => {
          const callback = rest.at(-1) as
            ((...answer: unknown[]) => unknown) | undefined
          if (event === 'join-room' && typeof callback === 'function') {
            rest.pop()
            // Tag the attempt: the id stays harness metadata, never
            // transmitted, and its ack outcome is recorded when the
            // acknowledgement resolves in either direction
            const attempt: {
              id: number
              outcome?: { answer: unknown[] } | { error: string }
            } = { id: window.joinAttempts.length + 1 }
            window.joinAttempts.push(attempt)
            // The answer itself arrived in time: socket.io clears its ack
            // timeout on arrival. Only the page's processing is held.
            return realEmit(event, ...rest, (...answer: unknown[]) => {
              const [error] = answer as [Error | null, ...unknown[]]
              // Errors (ack timeout, disconnect flush) fire at once, the
              // way socket.io would deliver them; only answers that
              // actually arrived are held, with their raw payload
              if (error !== null) {
                attempt.outcome = { error: String(error) }
                return Reflect.apply(callback, io, answer)
              }
              attempt.outcome = { answer }
              window.heldJoinAnswers.push({
                answer,
                release: () => Reflect.apply(callback, io, answer)
              })
            })
          }
          return realEmit(event, ...rest)
        }
        return socket
      }
    },
    set(value: typeof import('socket.io-client').io) {
      realIo = value
    }
  })
  window.heldJoinAnswers = []
  window.joinAttempts = []
  window.releaseJoinAnswer = () => {
    const held = window.heldJoinAnswers.shift()
    // A release with nothing held is a test bug, not a no-op
    if (!held) throw new Error('no held join answer to release')
    held.release()
  }
}

/** Records, by caller peer id, every call the room page receives, every
 * one it closes or answers, the connections it answers on, and every
 * stream the page's outgoing calls receive with its sender's peer id */

function recordRoomCalls() {
  window.incomingCalls = []
  window.closedCalls = []
  window.answeredCalls = []
  window.answeredConns = []
  window.outgoingStreams = []
  window.outgoingConns = []
  let RealPeer: typeof Peer
  Object.defineProperty(window, 'Peer', {
    configurable: true,
    get() {
      return RealPeer
    },
    set(value: typeof Peer) {
      RealPeer = value
      type On = (
        this: InstanceType<typeof Peer>,
        event: string,
        fn: (...args: unknown[]) => unknown
      ) => unknown
      const realOn = Reflect.get(value.prototype, 'on') as On
      ;(value.prototype as { on: On }).on = function (
        this: InstanceType<typeof Peer>,
        event: string,
        fn: (...args: unknown[]) => unknown
      ) {
        window.roomPeer = this
        if (event !== 'call') return realOn.call(this, event, fn)
        return realOn.call(this, event, ((
          call: import('peerjs').MediaConnection
        ) => {
          window.incomingCalls.push(call.peer)
          const realClose = call.close.bind(call)
          call.close = () => {
            window.closedCalls.push(call.peer)
            realClose()
          }
          const realAnswer = call.answer.bind(call) as (
            ...args: unknown[]
          ) => unknown
          call.answer = (...args: unknown[]) => {
            window.answeredCalls.push(call.peer)
            // A test names callers whose answer fails, to prove one
            // failing waiting call cannot abandon the rest
            if (window.failingAnswers?.includes(call.peer))
              throw new Error('injected answer failure')
            window.answeredConns.push(call)
            return realAnswer(...args)
          }
          fn(call)
        }) as (...args: unknown[]) => unknown)
      }
      const realCall = Reflect.get(value.prototype, 'call') as (
        this: InstanceType<typeof Peer>,
        ...args: unknown[]
      ) => import('peerjs').MediaConnection
      ;(value.prototype as { call: unknown }).call = function (
        this: InstanceType<typeof Peer>,
        ...args: unknown[]
      ) {
        const conn = realCall.apply(this, args)
        window.outgoingConns.push(conn)
        conn.on('stream', (stream: MediaStream) =>
          window.outgoingStreams.push({ peer: conn.peer, stream })
        )
        return conn
      }
    }
  })
}

let server: Server | undefined
let browser: Browser | undefined
const contexts: BrowserContext[] = []

// Test bodies require successful setup; cleanup may also run after failure.
function ready<T>(resource: T | undefined, name: string): T {
  assert.ok(resource, `${name} setup did not complete`)
  return resource
}

before(async () => {
  ;[server, browser] = await Promise.all([startServer(), launchBrowser()])
})
after(async () => {
  await browser?.close()
  await server?.stop()
})
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()))
})

/** A page in its own browser context, like a separate person */
async function newPage(
  init?: (() => void) | (() => void)[],
  on: Server = ready(server, 'server')
) {
  const context = await ready(browser, 'browser').newContext({
    baseURL: on.url
  })
  context.setDefaultTimeout(10_000)
  contexts.push(context)
  await context.addInitScript(record)
  for (const fn of Array.isArray(init) ? init : init ? [init] : [])
    await context.addInitScript(fn)
  return context.newPage()
}

interface Room {
  page: Page
  name: string
  peerId: string
}

/** Opens a room page and waits until Join can be pressed */
async function openRoom(
  name: string,
  init?: (() => void) | (() => void)[],
  on?: Server
): Promise<Room> {
  const page = await newPage(init, on)
  const idResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/peerjs/id'
  )
  await page.goto(`/room/${encodeURIComponent(name)}`)
  const peerId = await (await idResponse).text()
  await page.locator('#call:enabled').waitFor()
  // PeerJS makes one while checking what the browser supports
  await page.evaluate(() => (window.recorded.peerConnections.length = 0))
  return { page, name, peerId }
}

/** Presses Join and waits until the server has put the page in the room */
async function join({ page, name, peerId }: Room) {
  const from = ready(server, 'server').output().length
  await page.click('#call')
  await ready(server, 'server').waitForOutput(
    `user: ${peerId} - joined: ${name}`,
    from
  )
}

/** Everything the room page shows, so tests can compare it whole */

function controls(page: Page) {
  return page.evaluate(() => {
    const byId = (id: string) => document.getElementById(id) as HTMLElement
    const button = (id: string) => {
      const found = byId(id) as HTMLButtonElement
      return found.textContent + (found.disabled ? ' (disabled)' : '')
    }
    return {
      title: document.title,
      heading: byId('title').textContent,
      status: byId('status').textContent,
      mute: button('mute'),
      camera: button('camera'),
      call: button('call'),
      callEnds: byId('call').classList.contains('end'),
      removePhoto: !byId('remove-photo').hidden,
      photoInput: !(byId('photo') as HTMLInputElement).disabled,
      hint: byId('self-label').title,
      error: byId('error').hidden
        ? null
        : [...byId('error').children]
            .map((entry) => {
              const [heading, message] = entry.children as unknown as [
                Element,
                Element
              ]
              return `${heading.textContent}: ${message.textContent}`
            })
            .join(' | ')
    }
  })
}

const beforeJoining = (room: string) => ({
  title: `Pinto | ${room}`,
  heading: `Join ${room}`,
  status: 'Press Join to start the call',
  mute: 'Mute',
  camera: 'Turn On Camera',
  call: 'Join',
  callEnds: false,
  removePhoto: false,
  photoInput: true,
  hint: 'Choose a photo to show instead of your video',
  error: null
})

const inCall = (room: string, status: string) => ({
  ...beforeJoining(room),
  heading: `You are in ${room}`,
  status,
  call: 'Leave',
  callEnds: true
})

function attendees(page: Page) {
  return () =>
    page.evaluate(() =>
      [...document.querySelectorAll('#attendees video')].map((node) => {
        const video = node as HTMLVideoElement
        const stream = video.srcObject as MediaStream
        const kinds = stream.getTracks().map((track) => track.kind)
        const playing = video.videoWidth > 0 ? 'playing' : 'waiting'
        return `${kinds.sort().join('+')} ${playing}`
      })
    )
}

/** The readyState of every track of every stream the page has captured */

function audioStates(page: Page) {
  return () =>
    page.evaluate(() =>
      window.recorded.mediaStreams
        .flatMap((stream) => stream.getAudioTracks())
        .map((track) => track.readyState)
    )
}

/** Whether the self view, and every open call, show the camera */

function showsCamera(page: Page) {
  return page.evaluate(() => {
    const camera = window.recorded.media?.getVideoTracks()[0]
    const self = document.getElementById('self') as HTMLVideoElement
    const selfTrack = (self.srcObject as MediaStream).getVideoTracks()[0]
    const sent = window.recorded.peerConnections
      .filter((connection) => connection.signalingState !== 'closed')
      .map(
        (connection) =>
          connection
            .getSenders()
            .find((sender) => sender.track?.kind === 'video')?.track?.id ===
          camera?.id
      )
    return { self: selfTrack.id === camera?.id, sent }
  })
}

/** Colors of the self view at each [x, y] point of its 400 by 300 frame */

async function openCaller(on?: Server) {
  const page = await newPage(undefined, on)
  await page.goto('/')
  await page.addScriptTag({ url: '/vendor/peerjs.min.js' })
  await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    })
    const peer = new Peer({
      host: location.hostname,
      port: Number(location.port),
      path: '/'
    })
    window.caller = { peer, stream, answered: new Set(), closed: new Set() }
  })
  await page.waitForFunction(() => window.caller.peer.open)
  return {
    page,
    call: (peerId: string) =>
      page.evaluate((peerId) => {
        const call = window.caller.peer.call(peerId, window.caller.stream)
        // Fires once for each track
        call.on('stream', () => window.caller.answered.add(call.connectionId))
      }, peerId),
    /** Joins a room, so it counts as a member when it calls */
    join: async (roomName: string) => {
      await page.addScriptTag({ url: '/socket.io/socket.io.min.js' })
      await page.evaluate(async (roomName) => {
        const socket = io()
        window.caller.socket = socket
        await new Promise<void>((resolve) =>
          socket.once('connect', () => {
            resolve()
          })
        )
        await socket.emitWithAck('join-room', roomName, window.caller.peer.id)
      }, roomName)
    },
    /** How many of its calls have been answered with a stream */
    answered: () => page.evaluate(() => window.caller.answered.size)
  }
}

/** Joins a room with a plain socket, like a member's own page would */

async function joinFromOutside(roomName: string, peerId: string) {
  const socket = io(ready(server, 'server').url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      resolve()
    })
    socket.once('connect_error', reject)
  })
  socket.emit('join-room', roomName, peerId)
  await ready(server, 'server').waitForOutput(
    `user: ${peerId} - joined: ${roomName}`
  )
  return socket
}

/** A member's raw PeerJS signaling socket, open and ready to send */

async function rawSignaling(memberId: string): Promise<WebSocket> {
  const socket = new WebSocket(
    `${ready(server, 'server').url.replace(/^http/, 'ws')}/peerjs?key=peerjs&id=${memberId}&token=test-token`
  )
  await new Promise<void>((resolve, reject) => {
    socket.once('message', (data: Buffer) => {
      const message = JSON.parse(data.toString()) as { type?: string }
      if (message.type === 'OPEN') resolve()
      else
        reject(
          new Error(`unexpected first signaling message: ${data.toString()}`)
        )
    })
    socket.once('error', reject)
  })
  return socket
}

/** Sends a media offer over raw signaling, like a caller's browser would */

function sendOffer(
  socket: WebSocket,
  dst: string,
  connectionId: string,
  sdp: { type: RTCSdpType; sdp: string }
) {
  socket.send(
    JSON.stringify({
      type: 'OFFER',
      dst,
      payload: { connectionId, type: 'media', sdp }
    })
  )
}

/** A real audio and video offer, made the way a member's browser would */

async function makeOffer(): Promise<{ type: RTCSdpType; sdp: string }> {
  const page = await newPage()
  await page.goto('/')
  const offer = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    })
    const connection = new RTCPeerConnection({ iceServers: [] })
    for (const track of stream.getTracks()) connection.addTrack(track, stream)
    const offer = await connection.createOffer()
    connection.close()
    for (const track of stream.getTracks()) track.stop()
    if (offer.sdp === undefined)
      throw new Error('the generated offer carries no SDP')
    return { type: offer.type, sdp: offer.sdp }
  })
  await page.close()
  return offer
}

/** Ids of callers whose calls the room page received */

const incomingCalls = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.incomingCalls)

/** Ids of callers whose incoming calls the room page closed */
const closedCalls = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.closedCalls)

/** Ids of callers whose incoming calls the room page answered */
const answeredCalls = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.answeredCalls)

/** Raw payloads of the join answers currently held, oldest first */

void test('microphone denial when joining keeps the camera and mutes the mic', async () => {
  const room = await openRoom('mic-denied', () => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices
    )
    navigator.mediaDevices.getUserMedia = (constraints) =>
      constraints?.audio
        ? Promise.reject(
            new DOMException('Permission denied', 'NotAllowedError')
          )
        : getUserMedia(constraints)
  })
  await join(room)
  // The mic request was still current, so the denial shows and mutes
  await eventually(() => controls(room.page), {
    ...inCall('mic-denied', '1st in the room'),
    mute: 'Unmute',
    error:
      "Camera and microphone: Pinto can't reach your camera or microphone: Permission denied"
  })
  // No microphone was captured
  assert.deepEqual(await audioStates(room.page)(), [])
  // The camera still works
  await room.page.click('#camera')
  await eventually(
    () => showsCamera(room.page),
    { self: true, sent: [] },
    3_000
  )
})

void test('a refused Join turns down a call that was still waiting', async (t) => {
  // The waiting-call window is pinned to the real retry cadence, so this
  // test runs its own server without the suite's shortened timings;
  // teardown is registered the moment each resource exists
  const realTiming = await startServer({ PINTO_TEST_TIMINGS: '' })
  t.after(async () => {
    await realTiming.stop()
  })
  // The socket connects on construction, so its listeners are
  // registered immediately - attaching them later could miss the event
  // and hang - and the connection is awaited before anything else, so
  // an early connect_error is never an unhandled rejection
  const squatter = io(realTiming.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false
  })
  t.after(() => {
    void squatter.disconnect()
  })
  await new Promise<void>((resolve, reject) => {
    squatter.once('connect', () => {
      resolve()
    })
    squatter.once('connect_error', reject)
  })
  const room = await openRoom(
    'refused-waiting-call',
    recordRoomCalls,
    realTiming
  )
  squatter.emit('join-room', 'refused-waiting-call', room.peerId)
  await realTiming.waitForOutput(
    `user: ${room.peerId} - joined: refused-waiting-call`
  )

  // The page's Join is refused and retried; a call that arrives meanwhile
  // waits for a roster answer that never comes
  const caller = await openCaller(realTiming)
  await room.page.click('#call')
  await realTiming.waitForOutput('join-room refused: id already in room')
  await caller.call(room.peerId)
  const callerId = await caller.page.evaluate(() => window.caller.peer.id)
  await eventually(
    () => incomingCalls(room.page).then((ids) => ids.includes(callerId)),
    true
  )
  // The call is still waiting, not yet closed or answered
  assert.deepEqual(await closedCalls(room.page), [])
  assert.deepEqual(await answeredCalls(room.page), [])

  // When the retries give up, the waiting call is closed with them
  await eventually(
    () => closedCalls(room.page).then((ids) => ids.includes(callerId)),
    true,
    20_000
  )
  assert.deepEqual(
    await controls(room.page),
    beforeJoining('refused-waiting-call')
  )
  // The room never answered it
  assert.deepEqual(await answeredCalls(room.page), [])
  assert.equal(await caller.answered(), 0)
})

void test('Leave closes a call that is still waiting for the roster answer', async () => {
  const room = await openRoom('leave-waiting-call', [
    heldJoinAnswer,
    recordRoomCalls
  ])
  const caller = await openCaller() // Never joins the room
  await join(room) // Joined at the server; its roster answer is still held
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)

  // The call arrives before the roster answer and waits for it
  await caller.call(room.peerId)
  const callerId = await caller.page.evaluate(() => window.caller.peer.id)
  await eventually(
    () => incomingCalls(room.page).then((ids) => ids.includes(callerId)),
    true
  )
  assert.deepEqual(await closedCalls(room.page), [])
  assert.deepEqual(await answeredCalls(room.page), [])

  // Leave closes the waiting call instead of leaving it queued
  await room.page.click('#call')
  await eventually(
    () => closedCalls(room.page).then((ids) => ids.includes(callerId)),
    true
  )
  // The room never answered it
  assert.deepEqual(await answeredCalls(room.page), [])
  assert.equal(await caller.answered(), 0)
  assert.deepEqual(await attendees(room.page)(), [])
})

void test('a duplicate offer cannot make joining answer a retired call', async () => {
  const room = await openRoom('replaced-waiting-call', [
    heldJoinAnswer,
    recordRoomCalls
  ])
  const errors: Error[] = []
  room.page.on('pageerror', (error) => errors.push(error))
  const offer = await makeOffer()

  // A member whose signaling is sent raw, like the runs that crashed
  const member = 'replaced-member'
  const memberRoom = await joinFromOutside(room.name, member)
  const memberSignal = await rawSignaling(member)
  await join(room)
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)

  // The member offers the same connection twice; the library silently
  // retires the first call for the second
  sendOffer(memberSignal, room.peerId, 'mc_replaced', offer)
  await eventually(
    () =>
      incomingCalls(room.page).then(
        (ids) => ids.filter((id) => id === member).length
      ),
    1
  )
  sendOffer(memberSignal, room.peerId, 'mc_replaced', offer)
  await eventually(
    () =>
      incomingCalls(room.page).then(
        (ids) => ids.filter((id) => id === member).length
      ),
    2
  )
  // The library retired the first call for the duplicate; the recorded
  // close is that retirement, not the room turning the member down
  assert.deepEqual(await closedCalls(room.page), [member])

  // A caller outside the room offers the same connection id: a
  // cross-source collision, which refuses both ownerships and drains the
  // connection - the member's waiting replacement ends with it
  const stranger = 'replaced-stranger'
  const strangerSignal = await rawSignaling(stranger)
  sendOffer(strangerSignal, room.peerId, 'mc_replaced', offer)
  await eventually(
    () => incomingCalls(room.page).then((ids) => ids.includes(stranger)),
    true
  )
  // The collision retired the live replacement before the colliding call
  // was refused, and the refusal is shown rather than hidden
  await eventually(() => closedCalls(room.page), [member, member, stranger])

  // The roster answer arrives with nothing left to answer or retire
  await room.page.evaluate(() => {
    window.releaseJoinAnswer()
  })
  await eventually(() => controls(room.page), {
    ...inCall(room.name, '1st in the room'),
    error:
      'Connection problem: A call could not be admitted because its signaling channel was contested.'
  })
  assert.deepEqual(await answeredCalls(room.page), [])
  assert.deepEqual(await attendees(room.page)(), [])
  assert.deepEqual(errors, [])

  memberSignal.close()
  strangerSignal.close()
  memberRoom.disconnect()
})

void test('one failing waiting call cannot abandon the rest', async () => {
  const failing = 'failing-member'
  const room = await openRoom('failing-waiting-call', [
    heldJoinAnswer,
    recordRoomCalls,
    () => {
      window.failingAnswers = ['failing-member']
    }
  ])
  const errors: Error[] = []
  room.page.on('pageerror', (error) => errors.push(error))
  const offer = await makeOffer()

  // Two members offer while the roster answer is held; the first one's
  // answer fails
  const waiting = 'waiting-member'
  const failingRoom = await joinFromOutside(room.name, failing)
  const waitingRoom = await joinFromOutside(room.name, waiting)
  const failingSignal = await rawSignaling(failing)
  const waitingSignal = await rawSignaling(waiting)
  await join(room)
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)
  sendOffer(failingSignal, room.peerId, 'mc_failing', offer)
  await eventually(
    () => incomingCalls(room.page).then((ids) => ids.includes(failing)),
    true
  )
  sendOffer(waitingSignal, room.peerId, 'mc_waiting', offer)
  await eventually(() => incomingCalls(room.page), [failing, waiting])

  // The roster answer arrives: the failure is shown and retired, and
  // the waiting call behind it is still answered
  await room.page.evaluate(() => {
    window.releaseJoinAnswer()
  })
  await eventually(() => answeredCalls(room.page), [failing, waiting])
  // A failed call is retired at once, not left for Leave to find
  await eventually(() => closedCalls(room.page), [failing])
  assert.equal(
    await room.page.evaluate(
      ({ peer, connectionId }) =>
        window.roomPeer.getConnection(peer, connectionId) === null,
      { peer: failing, connectionId: 'mc_failing' }
    ),
    true
  )
  assert.deepEqual(errors, [])
  await eventually(() => controls(room.page), {
    ...inCall(room.name, '2nd in the room'),
    error:
      'Connection problem: A waiting call could not be answered: injected answer failure'
  })

  // Leave closes the answered call; the failed one was already retired
  await room.page.click('#call')
  await eventually(() => closedCalls(room.page), [failing, waiting])
  assert.deepEqual(await attendees(room.page)(), [])
  assert.deepEqual(errors, [])

  failingSignal.close()
  waitingSignal.close()
  failingRoom.disconnect()
  waitingRoom.disconnect()
})

/** An ICE candidate over raw signaling, like a caller's browser would send */

function sendCandidate(
  socket: WebSocket,
  dst: string,
  connectionId: string,
  tag: number
) {
  socket.send(
    JSON.stringify({
      type: 'CANDIDATE',
      dst,
      payload: {
        connectionId,
        candidate: {
          candidate: `candidate:${String(tag)} 1 udp 2113937151 10.0.0.${String(tag % 255)} 9 typ host`,
          sdpMid: '0',
          sdpMLineIndex: 0
        }
      }
    })
  )
}

/** An OFFER message padded to an exact retained size, like a large real one */

function paddedOffer(
  dst: string,
  connectionId: string,
  sdp: { type: RTCSdpType; sdp: string },
  bytes: number
) {
  const build = (pad: number) => ({
    type: 'OFFER',
    dst,
    payload: {
      connectionId,
      type: 'media',
      sdp: { type: sdp.type, sdp: `${sdp.sdp}a=x-pad:${'p'.repeat(pad)}\r\n` }
    }
  })
  const pad = bytes - JSON.stringify(build(0)).length
  if (pad < 0) throw new Error('the offer alone is larger than the target size')
  return build(pad)
}

/** The shown error text, heading then message, or null when none is shown */

const shownError = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const box = document.getElementById('error') as HTMLElement
    if (box.hidden) return null
    return [...box.children]
      .map((entry) => {
        const [heading, message] = entry.children as unknown as [
          Element,
          Element
        ]
        return `${heading.textContent}: ${message.textContent}`
      })
      .join(' | ')
  })

/** Totals across every connection the pairing library still holds messages for */

function storeTotals(
  page: Page
): Promise<{ cids: number; messages: number; bytes: number }> {
  return page.evaluate(() => {
    const peer = window.roomPeer as unknown as {
      _lostMessages: Map<string, unknown[]>
    }
    let messages = 0
    let bytes = 0
    for (const held of peer._lostMessages.values()) {
      messages += held.length
      for (const message of held) bytes += JSON.stringify(message).length
    }
    return { cids: peer._lostMessages.size, messages, bytes }
  })
}

void test('a waiting caller whose stored messages grow past the limit is refused, with the reason shown', async () => {
  const room = await openRoom('stored-messages-limit', [
    heldJoinAnswer,
    recordRoomCalls
  ])
  const errors: Error[] = []
  room.page.on('pageerror', (error) => errors.push(error))
  const offer = await makeOffer()
  const member = await joinFromOutside(room.name, 'limited-member')
  const memberSignal = await rawSignaling('limited-member')
  await join(room)
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)

  // A waiting caller's 128 stored messages fit; nothing is refused yet
  sendOffer(memberSignal, room.peerId, 'mc_limited', offer)
  await eventually(() => incomingCalls(room.page), ['limited-member'])
  for (let index = 0; index < 128; index++)
    sendCandidate(memberSignal, room.peerId, 'mc_limited', index)
  await eventually(async () => (await storeTotals(room.page)).messages, 128)
  assert.deepEqual(await closedCalls(room.page), [])
  assert.equal(await shownError(room.page), null)

  // The 129th refuses the call: the reason is shown, never hidden, and the
  // refused connection's store is drained
  sendCandidate(memberSignal, room.peerId, 'mc_limited', 128)
  await eventually(() => closedCalls(room.page), ['limited-member'])
  await eventually(
    () => shownError(room.page),
    'Connection problem: A call was refused because its stored messages grew past the limit.'
  )
  assert.deepEqual(await storeTotals(room.page), {
    cids: 0,
    messages: 0,
    bytes: 0
  })

  // The roster answer arrives: the overflowed call was already refused
  await room.page.evaluate(() => {
    window.releaseJoinAnswer()
  })
  await eventually(() => answeredCalls(room.page), [])
  assert.deepEqual(errors, [])

  memberSignal.close()
  member.disconnect()
})

void test('waiting-call pressure refuses the oldest caller, never the new one', async () => {
  const room = await openRoom('waiting-pressure', [
    heldJoinAnswer,
    recordRoomCalls
  ])
  const errors: Error[] = []
  room.page.on('pageerror', (error) => errors.push(error))
  const offer = await makeOffer()
  await join(room)
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)

  // Forty waiting callers fit; the 41st exceeds the waiting-call limit
  const callers: { id: string; signal: WebSocket }[] = []
  for (let index = 0; index < 41; index++) {
    const id = `waiting-${String(index)}`
    const signal = await rawSignaling(id)
    sendOffer(signal, room.peerId, `mc_waiting_${String(index)}`, offer)
    callers.push({ id, signal })
  }
  await eventually(
    () => incomingCalls(room.page),
    callers.map((caller) => caller.id),
    15_000
  )

  // The oldest waiting caller is refused to make room, with the reason shown
  await eventually(() => closedCalls(room.page), ['waiting-0'], 15_000)
  await eventually(
    () => shownError(room.page),
    'Connection problem: The oldest waiting call was refused to make room for a newer one.'
  )
  assert.deepEqual(await answeredCalls(room.page), [])
  assert.deepEqual(errors, [])

  for (const caller of callers) caller.signal.close()
})

void test('waiting-byte pressure refuses the oldest caller before the count limit is reached', async () => {
  const room = await openRoom('waiting-byte-pressure', [
    heldJoinAnswer,
    recordRoomCalls
  ])
  const errors: Error[] = []
  room.page.on('pageerror', (error) => errors.push(error))
  const offer = await makeOffer()
  await join(room)
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)

  // Forty large waiting offers fit the 40-call count limit; only the
  // aggregate byte limit can refuse them
  const callers: { id: string; signal: WebSocket }[] = []
  for (let index = 0; index < 40; index++) {
    const id = `byte-waiting-${String(index)}`
    const signal = await rawSignaling(id)
    signal.send(
      JSON.stringify(
        paddedOffer(
          room.peerId,
          `mc_byte_waiting_${String(index)}`,
          offer,
          55_000
        )
      )
    )
    callers.push({ id, signal })
  }
  await eventually(
    () => incomingCalls(room.page),
    callers.map((caller) => caller.id),
    15_000
  )

  // The two offers past the byte limit each refuse the current oldest,
  // first in first out, with the reason shown
  await eventually(
    () => closedCalls(room.page),
    ['byte-waiting-0', 'byte-waiting-1'],
    15_000
  )
  await eventually(
    () => shownError(room.page),
    'Connection problem: The oldest waiting call was refused to make room for a newer one.'
  )
  assert.deepEqual(await answeredCalls(room.page), [])
  assert.deepEqual(errors, [])

  for (const caller of callers) caller.signal.close()
})

void test('the 41st caller to be answered is refused, with the reason shown', async () => {
  const room = await openRoom('live-offer-pressure', [
    heldJoinAnswer,
    recordRoomCalls
  ])
  const errors: Error[] = []
  room.page.on('pageerror', (error) => errors.push(error))
  const offer = await makeOffer()

  // Every caller joins before the page, so the page calls no one itself
  const members: {
    socket: Awaited<ReturnType<typeof joinFromOutside>>
    signal: WebSocket
  }[] = []
  for (let index = 0; index < 41; index++) {
    const id = `live-${String(index)}`
    const socket = await joinFromOutside(room.name, id)
    const signal = await rawSignaling(id)
    members.push({ socket, signal })
  }
  await join(room)
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)

  // Forty waiting callers fit the waiting limit exactly
  for (let index = 0; index < 40; index++)
    sendOffer(
      members[index].signal,
      room.peerId,
      `mc_live_${String(index)}`,
      offer
    )
  await eventually(
    () => incomingCalls(room.page).then((ids) => ids.length),
    40,
    20_000
  )

  // The roster answer admits the page; all forty waiting calls are answered
  await room.page.evaluate(() => {
    window.releaseJoinAnswer()
  })
  await eventually(
    () => answeredCalls(room.page).then((ids) => ids.length),
    40,
    20_000
  )

  // Answering the 41st would exceed forty live offers: refused, reason shown
  sendOffer(members[40].signal, room.peerId, 'mc_live_40', offer)
  await eventually(
    () => shownError(room.page),
    'Connection problem: A call was refused because too many calls are already held.',
    20_000
  )
  assert.equal((await answeredCalls(room.page)).length, 40)
  assert.deepEqual(await closedCalls(room.page), ['live-40'])
  assert.deepEqual(errors, [])

  for (const member of members) {
    member.signal.close()
    member.socket.close()
  }
})

void test('a failed accounting drain fails closed, with the reason shown', async () => {
  const room = await openRoom('accounting-failure', [
    heldJoinAnswer,
    recordRoomCalls
  ])
  const errors: Error[] = []
  room.page.on('pageerror', (error) => errors.push(error))
  const offer = await makeOffer()
  const member = await joinFromOutside(room.name, 'drain-member')
  const memberSignal = await rawSignaling('drain-member')
  await join(room)
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)

  // A waiting caller holds three stored messages when the accounting drain
  // starts failing
  sendOffer(memberSignal, room.peerId, 'mc_drain', offer)
  await eventually(() => incomingCalls(room.page), ['drain-member'])
  for (let index = 0; index < 3; index++)
    sendCandidate(memberSignal, room.peerId, 'mc_drain', index)
  await eventually(async () => (await storeTotals(room.page)).messages, 3)
  await room.page.evaluate(() => {
    const peer = window.roomPeer as unknown as {
      _getMessages: () => string[]
    }
    peer._getMessages = () => {
      throw new Error('injected accounting failure')
    }
  })

  // Filling the per-connection limit refuses the call; the refusal's drain
  // hits the broken accounting, which fails closed: the reason is shown,
  // the call is closed, and the Peer is destroyed rather than admitting
  // anyone it cannot account for
  for (let index = 3; index < 129; index++)
    sendCandidate(memberSignal, room.peerId, 'mc_drain', index)
  await eventually(
    () => shownError(room.page),
    'Connection problem: Pinto cannot account for the messages the pairing library stores, so joining and answering are disabled.',
    15_000
  )
  await eventually(() => closedCalls(room.page), ['drain-member'])
  assert.deepEqual(await answeredCalls(room.page), [])
  assert.equal(
    await room.page.evaluate(
      () => (window.roomPeer as unknown as { destroyed: boolean }).destroyed
    ),
    true
  )
  assert.deepEqual(errors, [])

  memberSignal.close()
  member.disconnect()
})

void test('an unknown-source flood stays bounded and admission keeps working', async () => {
  const room = await openRoom('unknown-flood', [recordRoomCalls])
  const errors: Error[] = []
  room.page.on('pageerror', (error) => errors.push(error))
  await join(room)

  // A stranger floods 600 connection ids with one stored message each
  const ghost = await rawSignaling('flood-stranger')
  for (let index = 0; index < 600; index++)
    sendCandidate(ghost, room.peerId, `mc_flood_${String(index)}`, index)
  await eventually(
    async () => (await storeTotals(room.page)).messages,
    512,
    20_000
  )

  // The flood is bounded: the oldest 88 are drained and no error is shown
  const totals = await storeTotals(room.page)
  assert.ok(
    totals.messages <= 512,
    `unknown messages bounded: ${String(totals.messages)}`
  )
  assert.ok(
    totals.bytes <= 256 * 1024,
    `unknown bytes bounded: ${String(totals.bytes)}`
  )
  assert.deepEqual(
    await room.page.evaluate(() => {
      const peer = window.roomPeer as unknown as {
        _lostMessages: Map<string, unknown[]>
      }
      return [...peer._lostMessages.keys()].filter(
        (cid) => Number(cid.split('_')[2]) < 88
      )
    }),
    []
  )
  assert.equal(await shownError(room.page), null)

  // Admission still works: a member's call is answered
  const offer = await makeOffer()
  const member = await joinFromOutside(room.name, 'after-flood-member')
  const memberSignal = await rawSignaling('after-flood-member')
  sendOffer(memberSignal, room.peerId, 'mc_after_flood', offer)
  await eventually(
    () => answeredCalls(room.page),
    ['after-flood-member'],
    15_000
  )
  assert.deepEqual(errors, [])

  memberSignal.close()
  member.disconnect()
  ghost.close()
})

void test('an unknown-source flood never drains a waiting call', async () => {
  const room = await openRoom('flood-spares-waiting', [
    heldJoinAnswer,
    recordRoomCalls
  ])
  const errors: Error[] = []
  room.page.on('pageerror', (error) => errors.push(error))
  const offer = await makeOffer()
  const member = await joinFromOutside(room.name, 'spared-member')
  const memberSignal = await rawSignaling('spared-member')
  await join(room)
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)

  // A member's call waits on the held roster answer
  sendOffer(memberSignal, room.peerId, 'mc_spared', offer)
  await eventually(() => incomingCalls(room.page), ['spared-member'])

  // A stranger floods unknown connection ids: the waiting call is never
  // mistaken for unknown traffic and drained
  const ghost = await rawSignaling('spared-flood-stranger')
  for (let index = 0; index < 600; index++)
    sendCandidate(ghost, room.peerId, `mc_spare_flood_${String(index)}`, index)
  await eventually(
    async () => (await storeTotals(room.page)).messages,
    512,
    20_000
  )
  assert.deepEqual(await closedCalls(room.page), [])
  assert.equal(await shownError(room.page), null)

  // The roster answer arrives: the waiting call is answered
  await room.page.evaluate(() => {
    window.releaseJoinAnswer()
  })
  await eventually(() => answeredCalls(room.page), ['spared-member'], 15_000)
  assert.deepEqual(errors, [])

  memberSignal.close()
  member.disconnect()
  ghost.close()
})

/** Records every join-room emit's [room, id] arguments and holds the page's
 *  processing of each arrived answer until released, so a test can inspect
 *  the pending window. Ack errors (timeout, disconnect flush) deliver
 *  immediately, the way socket.io would deliver them. */
function spyJoin() {
  let realIo: typeof import('socket.io-client').io
  Object.defineProperty(window, 'io', {
    configurable: true,
    get() {
      return (...args: Parameters<typeof import('socket.io-client').io>) => {
        const socket = realIo(...args)
        window.roomSocket = socket
        const realEmit = socket.emit.bind(socket)
        socket.emit = (event: string, ...rest: unknown[]) => {
          if (event !== 'join-room') return realEmit(event, ...rest)
          window.joinEmits.push(rest.slice(0, 2))
          const callback = rest.at(-1) as
            ((...answer: unknown[]) => unknown) | undefined
          if (typeof callback !== 'function') return realEmit(event, ...rest)
          rest.pop()
          return realEmit(event, ...rest, (...answer: unknown[]) => {
            const [error] = answer as [Error | null, ...unknown[]]
            if (error !== null) return Reflect.apply(callback, io, answer)
            window.heldJoinAnswers.push({
              answer,
              release: () => Reflect.apply(callback, io, answer)
            })
          })
        }
        return socket
      }
    },
    set(value: typeof import('socket.io-client').io) {
      realIo = value
    }
  })
  window.joinEmits = []
  window.heldJoinAnswers = []
  window.releaseJoinAnswer = () => {
    const held = window.heldJoinAnswers.shift()
    if (!held) throw new Error('no held join answer to release')
    held.release()
  }
}

// Keeps a pairing outage real for as long as a test needs it: while
// blocked, every PeerJS reconnect attempt gets a socket that closes at
// once, so the app's reconnect retry keeps failing instead of racing the
// assertions. Unblocking lets the next scheduled retry connect for real.
// Keeps a pairing outage down for a whole window. The composition is
// honest: the first pairing socket is a REAL socket the test closes; every
// reconnect attempt while blocked is intercepted and answered with
// BlockedSocket, a FAKE WebSocket that never opens and reports itself
// closed 20 ms after construction. The window is therefore one real
// socket loss followed by a controlled, simulated sustained outage - not
// a real network failure. PeerJS-level state (peer.open/disconnected/id)
// is deliberately NOT asserted here: the page never exposes its Peer
// instance, and the fake cannot drive the library's internal lifecycle -
// PeerJS attaches its close handler by onclose property assignment (see
// the vendored dist), which BlockedSocket's event listeners never reach,
// so under this guard peer.disconnected reflects harness artifacts, not
// real state. Claims stay at socket level.
function reconnectGuard() {
  const RealWebSocket = window.WebSocket
  class BlockedSocket {
    binaryType: BinaryType = 'blob'
    readonly readyState = 3
    readonly url: string
    private readonly listeners: Record<string, ((event: never) => void)[]> = {}
    constructor(url: string | URL) {
      this.url = String(url)
      setTimeout(() => {
        ;(this.listeners['close'] ?? []).forEach((listener) => {
          listener(new CloseEvent('close') as never)
        })
      }, 20)
    }
    addEventListener(type: string, listener: (event: never) => void) {
      ;(this.listeners[type] ??= []).push(listener)
    }
    removeEventListener(type: string, listener: (event: never) => void) {
      this.listeners[type] = (this.listeners[type] ?? []).filter(
        (kept) => kept !== listener
      )
    }
    send() {}
    close() {}
  }
  window.blockPairingReconnect = () => {
    window.WebSocket = function (
      this: unknown,
      url: string | URL,
      protocols?: string | string[]
    ) {
      if (String(url).includes('/peerjs')) return new BlockedSocket(url)
      return new RealWebSocket(url, protocols)
    } as unknown as typeof window.WebSocket
  }
  window.unblockPairingReconnect = () => {
    window.WebSocket = RealWebSocket
  }
}

// The server's real join-room acknowledgement reaches the client but is
// never delivered to the application: the first ack packet is dropped at
// socket.io's ack dispatch (socket.onack), before it can be matched to
// the registered ack callback. The app's own callback passes through
// untouched (wrapped only to record the outcome), so socket.io's
// acknowledgement timeout - armed by the app's own
// .timeout(REQUEST_TIMEOUT_MS) wrapper - fires NATIVELY with its own
// error, and the app's unmodified retry path runs. No harness timer, no
// injected error. Later attempts' acks are delivered normally. This is
// delivery suppression at the client ack-dispatch boundary, not
// wire-level packet loss: request and answer both cross the real
// transport, and the answer's arrival at the client is real. What the
// test exercises natively is the app's timeout-and-retry handling when
// an answer never reaches its callback.
function suppressJoinAckDelivery() {
  let realIo: typeof import('socket.io-client').io
  let suppressed = false
  Object.defineProperty(window, 'io', {
    configurable: true,
    get() {
      return (...args: Parameters<typeof import('socket.io-client').io>) => {
        const socket = realIo(...args)
        window.roomSocket = socket
        const realEmit = socket.emit.bind(socket)
        socket.emit = (event: string, ...rest: unknown[]) => {
          if (event !== 'join-room') return realEmit(event, ...rest)
          window.joinEmits.push(rest.slice(0, 2))
          const callback = rest.at(-1) as
            ((...answer: unknown[]) => unknown) | undefined
          if (typeof callback !== 'function') return realEmit(event, ...rest)
          rest.pop()
          // The app's own callback is what socket.io registers and arms
          // its native ack timeout on; the wrapper only records outcomes
          const attempt: {
            id: number
            outcome?: { answer: unknown[] } | { error: string }
          } = { id: window.joinAttempts.length + 1 }
          window.joinAttempts.push(attempt)
          return realEmit(event, ...rest, (...answer: unknown[]) => {
            const [error] = answer as [Error | null, ...unknown[]]
            if (error !== null) attempt.outcome = { error: String(error) }
            else attempt.outcome = { answer }
            return Reflect.apply(callback, socket, answer)
          })
        }
        // Ack ids increment per ack-carrying emit, and join-room is the
        // first on this socket, so the first ack packet to arrive is the
        // suppressed one. socket.onack is library-private; the cast is
        // the harness reaching the dispatch point it must suppress.
        type OnAck = (packet: { id: number }) => void
        const dispatch = socket as unknown as { onack: OnAck }
        const realOnAck = dispatch.onack.bind(socket)
        dispatch.onack = (packet) => {
          if (!suppressed && window.joinEmits.length > 0) {
            suppressed = true
            return
          }
          realOnAck(packet)
        }
        return socket
      }
    },
    set(value: typeof import('socket.io-client').io) {
      realIo = value
    }
  })
  window.joinEmits = []
  window.joinAttempts = []
}

// The false-joined defect (audit decision 3): the joined title must never
// appear before the server confirms admission, and a Join attempted while
// the pairing connection is down must be refused. Title, ordinal status,
// the emitted id, the pairing connection's state and actual server
// membership are asserted separately, never merged into one claim.

void test('a Join attempted during a sustained pairing outage is refused: control disabled, no emit, no admission', async () => {
  const room = await openRoom('outage-join', [spyJoin, reconnectGuard])
  // One real pairing socket is closed, and every reconnect attempt is
  // intercepted by a fake instantly-closed socket: a controlled,
  // simulated sustained outage after one real socket loss (see
  // reconnectGuard), kept down for the whole window
  await room.page.evaluate(() => {
    window.blockPairingReconnect()
    window.recorded.peerSockets[0].close()
  })
  await eventually(
    async () => (await controls(room.page)).error,
    'Connection problem: network: Lost connection to server.'
  )
  const from = ready(server, 'server').output().length
  const pairingState = () =>
    room.page.evaluate(() => ({
      sockets: window.recorded.peerSockets.length,
      firstClosed: window.recorded.peerSockets[0].readyState === 3,
      emits: window.joinEmits.length
    }))
  // The outage render must leave Join actually disabled: asserted
  // explicitly. A click conditional on the control being enabled could
  // pass from the handler guard alone while the disabled-state render
  // regresses undetected, so no conditional click happens here
  await eventually(
    async () => (await controls(room.page)).call,
    'Join (disabled)'
  )
  // While the pairing connection is down: no joined display, no join
  // emit, no new pairing socket, and no server admission. Observations
  // are socket-level only (see reconnectGuard)
  await eventually(pairingState, { sockets: 1, firstClosed: true, emits: 0 })
  await eventually(
    async () => {
      const shown = await controls(room.page)
      const admitted = ready(server, 'server')
        .output()
        .slice(from)
        .includes(`user: ${room.peerId} - joined: outage-join`)
      return { heading: shown.heading, status: shown.status, admitted }
    },
    {
      heading: 'Join outage-join',
      status: 'Press Join to start the call',
      admitted: false
    }
  )
  // Still down at the end of the window: the outage never healed mid-test
  assert.deepEqual(await pairingState(), {
    sockets: 1,
    firstClosed: true,
    emits: 0
  })
  // The refusal says why: the pairing outage error stays shown
  assert.match((await controls(room.page)).error ?? '', /Connection problem/)
  await room.page.evaluate(() => {
    window.unblockPairingReconnect()
  })
})

void test('SYNTHETIC (harness-forced control): the Join handler itself refuses while pairing is down, with the reason shown', async () => {
  // SYNTHETIC: the disabled control is force-enabled by the harness so the
  // click reaches the handler and exercises its refusal branch directly.
  // This is not a user-path reproduction; the honest UI behavior is the
  // disabled control covered by the previous test.
  const room = await openRoom('outage-synthetic', [spyJoin, reconnectGuard])
  await room.page.evaluate(() => {
    window.blockPairingReconnect()
    window.recorded.peerSockets[0].close()
  })
  await eventually(
    async () => (await controls(room.page)).error,
    'Connection problem: network: Lost connection to server.'
  )
  const from = ready(server, 'server').output().length
  await room.page.evaluate(() => {
    ;(document.getElementById('call') as HTMLButtonElement).disabled = false
  })
  await room.page.click('#call')
  // The handler refuses with the exact reason for the refusal
  await eventually(
    async () =>
      ((await controls(room.page)).error ?? '').includes(
        'The connection to the server is down, so joining is unavailable.'
      ),
    true
  )
  // No emit, no admission, no joined display, and the control is
  // disabled again by the refusal's render
  assert.equal(await room.page.evaluate(() => window.joinEmits.length), 0)
  const shown = await controls(room.page)
  assert.equal(shown.heading, 'Join outage-synthetic')
  assert.equal(shown.status, 'Press Join to start the call')
  assert.ok(shown.call.endsWith('(disabled)'))
  const admitted = ready(server, 'server')
    .output()
    .slice(from)
    .includes(`user: ${room.peerId} - joined: outage-synthetic`)
  assert.equal(admitted, false)
  await room.page.evaluate(() => {
    window.unblockPairingReconnect()
  })
})

void test('a roster answer held mid-join shows no joined title before processing, even when pairing drops', async () => {
  const room = await openRoom('outage-mid-join', [spyJoin, reconnectGuard])
  const from = ready(server, 'server').output().length
  await room.page.click('#call')
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)
  // The emit carried this page's real room and id, exactly once
  assert.deepEqual(await room.page.evaluate(() => window.joinEmits), [
    ['outage-mid-join', room.peerId]
  ])
  // Pending feedback while the answer is held: the title claims no
  // membership, and the status says the join is in flight
  const pending = await controls(room.page)
  assert.equal(pending.heading, 'Join outage-mid-join')
  assert.equal(pending.status, 'Joining...')
  // Pairing drops while the answer is still held, and the outage is kept
  // real: reconnects fail for the whole down window
  await room.page.evaluate(() => {
    window.blockPairingReconnect()
    window.recorded.peerSockets[0].close()
  })
  await eventually(
    async () => (await controls(room.page)).error,
    'Connection problem: network: Lost connection to server.'
  )
  // While truly down with the answer still held: no joined title, still
  // exactly one emit with the original id, no new pairing socket
  // (socket-level observations only, see reconnectGuard)
  assert.deepEqual(
    await room.page.evaluate(() => ({
      sockets: window.recorded.peerSockets.length,
      firstClosed: window.recorded.peerSockets[0].readyState === 3,
      emits: window.joinEmits.length
    })),
    { sockets: 1, firstClosed: true, emits: 1 }
  )
  assert.equal((await controls(room.page)).heading, 'Join outage-mid-join')
  // The server did admit the page when the request arrived; membership is
  // real while pairing is down - two separate facts, asserted separately
  await ready(server, 'server').waitForOutput(
    `user: ${room.peerId} - joined: outage-mid-join`,
    from
  )
  // Reconnect allowed again; releasing the held answer now shows the real
  // membership and the outage side by side
  await room.page.evaluate(() => {
    window.unblockPairingReconnect()
    window.releaseJoinAnswer()
  })
  await eventually(
    async () => (await controls(room.page)).heading,
    'You are in outage-mid-join'
  )
  const joined = await controls(room.page)
  assert.equal(joined.status, '1st in the room')
  assert.match(joined.error ?? '', /Connection problem/)
  // The pairing session recovers on a new socket; the join's emitted id
  // stays the original one (recorded above), no second join is emitted
  await eventually(
    async () => room.page.evaluate(() => window.recorded.peerSockets.length),
    2
  )
  assert.equal(await room.page.evaluate(() => window.joinEmits.length), 1)
})

void test('a room-socket loss mid-join retires the admission; the already-arrived stale answer restores nothing when released', async () => {
  const room = await openRoom('outage-room-socket', [spyJoin])
  const from = ready(server, 'server').output().length
  await room.page.click('#call')
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)
  // The answer arrived at the transport and is held at the page; the room
  // socket drops before the page processes it
  await room.page.evaluate(() => {
    window.roomSocket.disconnect()
  })
  await eventually(
    async () => {
      const shown = await controls(room.page)
      return {
        heading: shown.heading,
        status: shown.status,
        error: shown.error
      }
    },
    {
      heading: 'Join outage-room-socket',
      status: 'Connection lost - press Join to rejoin',
      error:
        'Connection problem: The connection to the room was lost. Press Join to rejoin.'
    }
  )
  // The server drops the membership with the socket: the admission that
  // the held answer would have confirmed is gone
  await ready(server, 'server').waitForOutput(
    `user: ${room.peerId} - left: outage-room-socket`,
    from
  )
  // Releasing the stale answer now must restore nothing: no title, no
  // ordinal membership, no error change. Give the page a beat to process
  // it, then verify the retired state is unchanged
  await room.page.evaluate(() => {
    window.releaseJoinAnswer()
  })
  await room.page.waitForTimeout(300)
  const after = await controls(room.page)
  assert.equal(after.heading, 'Join outage-room-socket')
  assert.equal(after.status, 'Connection lost - press Join to rejoin')
  assert.match(after.error ?? '', /connection to the room was lost/)
})

void test('a server acknowledgement suppressed at delivery fires the native ack timeout; only the retried join shows the confirmed admission', async () => {
  // The server's real answer arrives at the client but is dropped at
  // socket.io's ack dispatch, so the timeout the app armed with
  // .timeout(REQUEST_TIMEOUT_MS) fires natively. This is not wire-level
  // packet loss (see suppressJoinAckDelivery); what runs unmodified is
  // the app's timeout-and-retry path when an answer never reaches it.
  const room = await openRoom('ack-suppressed', [suppressJoinAckDelivery])
  const from = ready(server, 'server').output().length
  await room.page.click('#call')
  await room.page.waitForFunction(() => window.joinEmits.length === 1)
  // The request reached the server (membership is real) but the answer
  // is never delivered to the app: while delivery is suppressed the
  // title claims no membership and the status says the join is in flight
  await ready(server, 'server').waitForOutput(
    `user: ${room.peerId} - joined: ack-suppressed`,
    from
  )
  const pending = await controls(room.page)
  assert.equal(pending.heading, 'Join ack-suppressed')
  assert.equal(pending.status, 'Joining...')
  // The first attempt's outcome is socket.io's own timeout error: no
  // harness timer produced it. The suite's served timings shorten
  // requestTimeoutMs to 500 ms (production fallback 5 s); the mechanism
  // is identical, only the wait differs
  await eventually(
    async () =>
      (await room.page.evaluate(() => window.joinAttempts)).at(0)?.outcome,
    { error: 'Error: operation has timed out' }
  )
  // The app retries on its own, the retry's ack is delivered, and only
  // that answered retry shows the confirmed admission
  await eventually(
    async () => (await controls(room.page)).heading,
    'You are in ack-suppressed',
    15_000
  )
  const joined = await controls(room.page)
  assert.equal(joined.status, '1st in the room')
  assert.deepEqual(await room.page.evaluate(() => window.joinEmits), [
    ['ack-suppressed', room.peerId],
    ['ack-suppressed', room.peerId]
  ])
  // The server logged the membership exactly once: the retry re-used the
  // same connection and id, so no duplicate admission
  const joins = ready(server, 'server')
    .output()
    .slice(from)
    .split('\n')
    .filter((line) => line.includes(`user: ${room.peerId} - joined:`))
  assert.equal(joins.length, 1)
})
