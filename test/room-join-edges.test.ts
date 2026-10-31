import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import type { Browser, BrowserContext, Page } from 'playwright'
import { io } from 'socket.io-client'
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
          const callback = rest.at(-1)
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
              const [error] = answer
              // Errors (ack timeout, disconnect flush) fire at once, the
              // way socket.io would deliver them; only answers that
              // actually arrived are held, with their raw payload
              if (error !== null) {
                attempt.outcome = { error: String(error) }
                return callback(...answer)
              }
              attempt.outcome = { answer }
              window.heldJoinAnswers.push({
                answer,
                release: () => callback(...answer)
              })
            })
          }
          return realEmit(event, ...rest)
        }
        return socket
      }
    },
    set(value) {
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
      const realOn = value.prototype.on as On
      ;(value.prototype as { on: On }).on = function (
        this: InstanceType<typeof Peer>,
        event: string,
        fn: (...args: unknown[]) => unknown
      ) {
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
            window.answeredConns.push(call)
            return realAnswer(...args)
          }
          fn(call)
        }) as (...args: unknown[]) => unknown)
      }
      const realCall = value.prototype.call as (
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

let server: Server
let browser: Browser
const contexts: BrowserContext[] = []

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
async function newPage(init?: (() => void) | (() => void)[]) {
  const context = await browser.newContext({ baseURL: server.url })
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
  init?: (() => void) | (() => void)[]
): Promise<Room> {
  const page = await newPage(init)
  const idResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/pinto/id'
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
  const from = server.output().length
  await page.click('#call')
  await server.waitForOutput(`user: ${peerId} - joined: ${name}`, from)
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
        : `${byId('error-title').textContent}: ${byId('error-message').textContent}`
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

async function openCaller() {
  const page = await newPage()
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
      path: '/',
      key: 'pinto'
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
          socket.on('connect', () => resolve())
        )
        await socket.emitWithAck('join-room', roomName, window.caller.peer.id)
      }, roomName)
    },
    /** How many of its calls have been answered with a stream */
    answered: () => page.evaluate(() => window.caller.answered.size)
  }
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

test('microphone denial when joining keeps the camera and mutes the mic', async () => {
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

test('a refused Join turns down a call that was still waiting', async () => {
  const room = await openRoom('refused-waiting-call', recordRoomCalls)
  const squatter = io(server.url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false
  })
  await new Promise<void>((resolve, reject) => {
    squatter.once('connect', () => resolve())
    squatter.once('connect_error', reject)
  })
  squatter.emit('join-room', 'refused-waiting-call', room.peerId)
  await server.waitForOutput(
    `user: ${room.peerId} - joined: refused-waiting-call`
  )

  // The page's Join is refused and retried; a call that arrives meanwhile
  // waits for a roster answer that never comes
  const caller = await openCaller()
  await room.page.click('#call')
  await server.waitForOutput('join-room refused: id already in room')
  await caller.call(room.peerId)
  const callerId = await caller.page.evaluate(() => window.caller.peer.id)
  await eventually(
    () => incomingCalls(room.page).then((ids) => ids.includes(callerId)),
    true
  )

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
  assert.equal(await caller.answered(), 0)
  squatter.disconnect()
})

test('Leave closes a call that is still waiting for the roster answer', async () => {
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
  assert.equal(await caller.answered(), 0)
  assert.deepEqual(await attendees(room.page)(), [])
})
