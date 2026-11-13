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
  // The socket connects on construction, so its listeners are registered
  // immediately - attaching them later could miss the event and hang -
  // and the connection is awaited before anything else, so an early
  // connect_error is never an unhandled rejection
  const squatter = io(realTiming.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false
  })
  t.after(() => squatter.disconnect())
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

  // A caller outside the room offers the same connection id; it waits too
  const stranger = 'replaced-stranger'
  const strangerSignal = await rawSignaling(stranger)
  sendOffer(strangerSignal, room.peerId, 'mc_replaced', offer)
  await eventually(
    () => incomingCalls(room.page).then((ids) => ids.includes(stranger)),
    true
  )

  // The roster answer arrives: the live replacement is answered, the
  // retired call is skipped, and the stranger's is turned down
  await room.page.evaluate(() => {
    window.releaseJoinAnswer()
  })
  await eventually(() => answeredCalls(room.page), [member])
  await eventually(() => closedCalls(room.page), [member, stranger])
  assert.deepEqual(errors, [])
  // The answered call's remote tracks arrive muted, so its video waits
  await eventually(
    () => controls(room.page),
    inCall(room.name, '2nd in the room')
  )
  assert.deepEqual(await attendees(room.page)(), ['audio+video waiting'])

  // Leave closes the answered call and nothing is left over
  await room.page.click('#call')
  await eventually(() => closedCalls(room.page), [member, stranger, member])
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
