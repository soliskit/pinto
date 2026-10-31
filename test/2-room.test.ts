import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, afterEach, before, describe, test } from 'node:test'
import type { Browser, BrowserContext, Page } from 'playwright'
import { io } from 'socket.io-client'
import {
  eventually,
  launchBrowser,
  record,
  startServer,
  type Server
} from './helpers.ts'

function withoutCamera() {
  navigator.mediaDevices.getUserMedia = () =>
    Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
}

/** Holds every capture request until the test releases it */
function gatedCapture() {
  window.realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
    navigator.mediaDevices
  )
  window.captureGate = []
  navigator.mediaDevices.getUserMedia = (constraints) =>
    new Promise((resolve, reject) => {
      window.captureGate.push({ constraints, resolve, reject })
    })
}

/** Holds the page's processing of join answers until the test releases them,
 * oldest first, the way captureGate queues capture requests */
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

const status = (page: Page) => () => page.textContent('#status')

/**
 * What a page's calls have received and sent so far, from the connection
 * statistics: packets for each kind, and video frames decoded.
 */
function mediaFlow(page: Page) {
  return () =>
    page.evaluate(async () => {
      const flow = {
        audioReceived: 0,
        videoReceived: 0,
        framesDecoded: 0,
        audioSent: 0,
        videoSent: 0
      }
      for (const connection of window.recorded.peerConnections) {
        for (const stat of (await connection.getStats()).values()) {
          if (stat.type === 'inbound-rtp') {
            if (stat.kind === 'audio')
              flow.audioReceived += stat.packetsReceived
            if (stat.kind === 'video') {
              flow.videoReceived += stat.packetsReceived
              flow.framesDecoded += stat.framesDecoded
            }
          }
          if (stat.type === 'outbound-rtp') {
            if (stat.kind === 'audio') flow.audioSent += stat.packetsSent
            if (stat.kind === 'video') flow.videoSent += stat.packetsSent
          }
        }
      }
      return flow
    })
}

/**
 * The other people's videos: the kinds of track each one gets, and whether
 * frames have arrived.
 */
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
function allTrackStates(page: Page) {
  return () =>
    page.evaluate(() =>
      window.recorded.mediaStreams
        .flatMap((stream) => stream.getTracks())
        .map((track) => track.readyState)
    )
}

/** The readyState of every audio track the page has captured */
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
function selfColors(page: Page, points: [number, number][]) {
  return () =>
    page.evaluate((points) => {
      const video = document.getElementById('self') as HTMLVideoElement
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext('2d') as CanvasRenderingContext2D
      context.drawImage(video, 0, 0)
      return points.map(([x, y]) => {
        const [r, g, b, a] = context.getImageData(x, y, 1, 1).data
        if (a < 128) return 'nothing'
        if (r > 200 && g < 60 && b < 60) return 'red'
        if (b > 200 && r < 60 && g < 60) return 'blue'
        if (r < 60 && g < 60 && b < 60) return 'black'
        return `rgb(${r}, ${g}, ${b})`
      })
    }, points)
}

/** An image file of one color */
function image(color: string, width: number, height: number) {
  return {
    name: `${color}.svg`,
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`
    )
  }
}

/** A plain PeerJS client in its own page, to call room pages directly */
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
const heldAnswers = (page: Page): Promise<unknown[][]> =>
  page.evaluate(() => window.heldJoinAnswers.map((held) => held.answer))

describe('before joining', () => {
  test('shows the room name and lets you join', async () => {
    const { page } = await openRoom('Team #1/ü')
    assert.deepEqual(await controls(page), beforeJoining('Team #1/ü'))
    assert.deepEqual(await showsCamera(page), { self: false, sent: [] })
  })

  test('Mute turns the microphone off, and Unmute on again', async () => {
    const room = await openRoom('mute')

    // Before joining, Mute chooses how you join; nothing is captured yet
    await room.page.click('#mute')
    assert.deepEqual(await controls(room.page), {
      ...beforeJoining('mute'),
      mute: 'Unmute'
    })
    assert.deepEqual(await audioStates(room.page)(), [])

    // Joining muted captures no microphone
    await join(room)
    assert.deepEqual(await audioStates(room.page)(), [])

    // Unmute captures it, Mute stops it
    await room.page.click('#mute')
    await eventually(audioStates(room.page), ['live'], 3_000)
    await room.page.click('#mute')
    await eventually(audioStates(room.page), ['ended'], 3_000)
  })

  test('Turn On Camera shows the camera, and Turn Off Camera the photo again', async () => {
    const room = await openRoom('camera')

    // Before joining, the button chooses whether you join with the camera
    // on; the camera itself stays off until then
    await room.page.click('#camera')
    assert.deepEqual(await controls(room.page), {
      ...beforeJoining('camera'),
      camera: 'Turn Off Camera',
      photoInput: false,
      hint: ''
    })
    assert.deepEqual(await showsCamera(room.page), { self: false, sent: [] })

    // Joining with the camera on captures it and shows it
    await join(room)
    await eventually(() => showsCamera(room.page), { self: true, sent: [] })

    await room.page.click('#camera')
    assert.deepEqual(await showsCamera(room.page), { self: false, sent: [] })
  })

  test('without a camera, says why and still lets you join', async () => {
    const room = await openRoom('no camera', withoutCamera)

    // Nothing is captured before Join, so there is no error yet
    assert.deepEqual(await controls(room.page), beforeJoining('no camera'))

    // The failure shows when joining tries to capture, and joining works
    await join(room)
    await eventually(() => controls(room.page), {
      ...inCall('no camera', '1st in the room'),
      mute: 'Unmute',
      error:
        "Camera and microphone: Pinto can't reach your camera or microphone: Permission denied"
    })
  })

  test('camera denial when joining keeps the mic and shows camera off', async () => {
    const room = await openRoom('camera-denied', () => {
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices
      )
      navigator.mediaDevices.getUserMedia = (constraints) =>
        constraints?.video
          ? Promise.reject(
              new DOMException('Permission denied', 'NotAllowedError')
            )
          : getUserMedia(constraints)
    })
    await room.page.click('#camera')
    await join(room)
    await eventually(() => controls(room.page), {
      ...inCall('camera-denied', '1st in the room'),
      error:
        "Camera and microphone: Pinto can't reach your camera or microphone: Permission denied"
    })
    await eventually(audioStates(room.page), ['live'], 3_000)
    assert.deepEqual(await showsCamera(room.page), { self: false, sent: [] })
  })

  test('a chosen photo shows instead of the placeholder until removed', async () => {
    const { page } = await openRoom('photo')
    const placeholder = selfColors(page, [
      [200, 150],
      [60, 10],
      [10, 10]
    ])
    await eventually(placeholder, ['black', 'black', 'nothing'])

    // A wide photo shrinks to 288 by 144, in the middle of the frame
    await page.setInputFiles('#photo', image('red', 1000, 500))
    const wide = selfColors(page, [
      [200, 150],
      [57, 150],
      [343, 150],
      [55, 150],
      [345, 150],
      [200, 79],
      [200, 221],
      [200, 77],
      [200, 223]
    ])
    await eventually(wide, [
      ...['red', 'red', 'red', 'nothing', 'nothing'],
      ...['red', 'red', 'nothing', 'nothing']
    ])
    assert.equal((await controls(page)).removePhoto, true)
    // So the same file can be chosen again
    assert.equal(await page.inputValue('#photo'), '')

    // A small photo keeps its size, 100 by 50
    await page.setInputFiles('#photo', image('blue', 100, 50))
    const small = selfColors(page, [
      [200, 150],
      [151, 150],
      [149, 150],
      [200, 124]
    ])
    await eventually(small, ['blue', 'blue', 'nothing', 'nothing'])

    await page.click('#remove-photo')
    await eventually(placeholder, ['black', 'black', 'nothing'])
    assert.deepEqual(await controls(page), beforeJoining('photo'))
  })

  test('clicking your own preview opens the photo chooser, and the chosen photo shows', async () => {
    const { page } = await openRoom('preview-click')
    const placeholder = selfColors(page, [
      [200, 150],
      [60, 10],
      [10, 10]
    ])
    await eventually(placeholder, ['black', 'black', 'nothing'])

    // The click, not the file input, is what asks for a file
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.click('#self-label')
    ])
    await chooser.setFiles(image('red', 1000, 500))

    // Same wide photo as above: 288 by 144, in the middle of the frame
    const wide = selfColors(page, [
      [200, 150],
      [57, 150],
      [343, 150],
      [55, 150],
      [345, 150],
      [200, 79],
      [200, 221],
      [200, 77],
      [200, 223]
    ])
    await eventually(wide, [
      ...['red', 'red', 'red', 'nothing', 'nothing'],
      ...['red', 'red', 'nothing', 'nothing']
    ])
    assert.equal((await controls(page)).removePhoto, true)
  })

  test('a file that is not an image leaves the last picture', async () => {
    const { page } = await openRoom('not an image')
    const errors: Error[] = []
    page.on('pageerror', (error) => errors.push(error))
    const center = selfColors(page, [[200, 150]])
    await eventually(center, ['black'])

    await page.setInputFiles('#photo', {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not an image')
    })
    // The photo is drawn again every second
    await sleep(1500)
    assert.deepEqual(await center(), ['black'])
    assert.deepEqual(errors, [])
  })
})

describe('in a call', () => {
  test('Join joins the room, and Leave leaves it', async () => {
    const room = await openRoom('solo')
    await join(room)
    assert.deepEqual(
      await controls(room.page),
      inCall('solo', '1st in the room')
    )

    const from = server.output().length
    await room.page.click('#call')
    assert.deepEqual(await controls(room.page), beforeJoining('solo'))
    await server.waitForOutput(`user: ${room.peerId} - left: solo`, from)
  })

  test('everyone in the room sees and hears everyone else', async () => {
    const a = await openRoom('trio')
    const b = await openRoom('trio')
    const c = await openRoom('trio')
    const elsewhere = await openRoom('elsewhere')
    await join(elsewhere)
    await join(a)
    await join(b)
    await eventually(status(a.page), '2nd in the room')
    await eventually(status(b.page), '2nd in the room')
    await join(c)

    const two = ['audio+video playing', 'audio+video playing']
    for (const { page } of [a, b, c]) {
      await eventually(attendees(page), two)
      assert.deepEqual(await controls(page), inCall('trio', '3rd in the room'))
    }
    assert.deepEqual(await attendees(elsewhere.page)(), [])
    assert.equal(await status(elsewhere.page)(), '1st in the room')
  })

  test('the fourth person in a room is told they are 4th', async () => {
    const pages = [
      await openRoom('quartet'),
      await openRoom('quartet'),
      await openRoom('quartet'),
      await openRoom('quartet')
    ]
    for (const [index, room] of pages.entries()) {
      await join(room)
      const wanted = ['1st', '2nd', '3rd', '4th'][index]
      await eventually(status(room.page), `${wanted} in the room`)
    }
  })

  test('audio and video packets keep flowing both ways', async () => {
    const a = await openRoom('flow')
    const b = await openRoom('flow')
    await join(a)
    await join(b)
    await eventually(attendees(a.page), ['audio+video playing'])
    await eventually(attendees(b.page), ['audio+video playing'])

    const pages = [a.page, b.page]
    const before = await Promise.all(pages.map((page) => mediaFlow(page)()))
    await sleep(2000)
    const after = await Promise.all(pages.map((page) => mediaFlow(page)()))

    // Each side takes in, and sends out, more audio and video than it did
    // two seconds earlier, so media went both ways between the two readings
    for (const [i, flow] of after.entries()) {
      for (const key of [
        'audioReceived',
        'videoReceived',
        'framesDecoded',
        'audioSent',
        'videoSent'
      ] as const) {
        assert.ok(
          flow[key] > before[i][key],
          `page ${i + 1}: ${key} did not increase from ${before[i][key]}`
        )
      }
    }
  })

  test('a failed call connection logs the PeerJS error', async () => {
    const a = await openRoom('call-error')
    const b = await openRoom('call-error')
    await join(a)
    await join(b)
    await eventually(attendees(a.page), ['audio+video playing'])
    await eventually(attendees(b.page), ['audio+video playing'])

    // Watch for the error room.js logs from its call error handler
    const consoleErrors: { type?: string; message?: string }[] = []
    a.page.on('console', (message) => {
      if (message.type() !== 'error') return
      const [first] = message.args()
      first
        ?.evaluate((error) => ({
          type: (error as { type?: string } | null)?.type,
          message: (error as { message?: string } | null)?.message
        }))
        .then((entry) => consoleErrors.push(entry))
        .catch(() => {})
    })

    // Simulate the browser reporting the one live call's transport as
    // failed, so the real PeerJS listener produces the error
    const driven = await a.page.evaluate(() => {
      const connections = window.recorded.peerConnections
      if (connections.length !== 1)
        return `expected one managed connection, found ${connections.length}`
      const [pc] = connections
      if (typeof pc.oniceconnectionstatechange !== 'function')
        return 'the PeerJS ICE listener is not registered'
      if (
        pc.iceConnectionState !== 'connected' &&
        pc.iceConnectionState !== 'completed'
      )
        return `connection not established: ${pc.iceConnectionState}`
      Object.defineProperty(pc, 'iceConnectionState', {
        configurable: true,
        get: () => 'failed'
      })
      pc.dispatchEvent(new Event('iceconnectionstatechange'))
      return 'ok'
    })
    assert.equal(driven, 'ok')

    // PeerJS itself constructs the error, naming the peer it lost
    const wanted = {
      type: 'negotiation-failed',
      message: `Negotiation of connection to ${b.peerId} failed.`
    }
    await eventually(
      async () =>
        consoleErrors.find(
          (entry) =>
            entry.type === wanted.type && entry.message === wanted.message
        ) ?? null,
      wanted
    )

    // PeerJS then closes the call, and the page drops the peer's video
    await eventually(attendees(a.page), [])
  })

  test('Leave leaves the call for everyone, and Join joins again', async () => {
    const a = await openRoom('again')
    const b = await openRoom('again')
    await join(a)
    await join(b)
    await eventually(status(a.page), '2nd in the room')

    await b.page.click('#call')
    assert.deepEqual(await controls(b.page), beforeJoining('again'))
    assert.deepEqual(await attendees(b.page)(), [])
    await eventually(status(a.page), '1st in the room')
    assert.deepEqual(await attendees(a.page)(), [])

    await join(b)
    await eventually(status(a.page), '2nd in the room')
    await eventually(status(b.page), '2nd in the room')
  })

  test('closing the page leaves the call', async () => {
    const a = await openRoom('closing')
    const b = await openRoom('closing')
    await join(a)
    await join(b)
    await eventually(status(a.page), '2nd in the room')

    await b.page.context().close()
    await eventually(status(a.page), '1st in the room')
    assert.deepEqual(await attendees(a.page)(), [])
  })

  test('Turn On Camera and Turn Off Camera change what the call sends', async () => {
    const a = await openRoom('switch')
    const b = await openRoom('switch')
    await join(a)
    await join(b)
    await eventually(status(a.page), '2nd in the room')
    assert.deepEqual(await showsCamera(a.page), { self: false, sent: [false] })

    // Calls switch tracks without renegotiating, which takes a moment
    await a.page.click('#camera')
    await eventually(() => showsCamera(a.page), { self: true, sent: [true] })

    await a.page.click('#camera')
    await eventually(() => showsCamera(a.page), { self: false, sent: [false] })
  })

  test('calls are turned down until you join', async () => {
    const room = await openRoom('quiet')
    const caller = await openCaller()
    const offered = () =>
      room.page.evaluate(() =>
        window.recorded.peerMessages.some(
          (message) => JSON.parse(message).type === 'OFFER'
        )
      )

    // room.js handles the offer as it arrives, so it has turned it down by
    // the time the test sees it
    await caller.call(room.peerId)
    await eventually(offered, true)
    const connections = () =>
      room.page.evaluate(() => window.recorded.peerConnections.length)
    assert.equal(await connections(), 0)
    assert.deepEqual(await attendees(room.page)(), [])

    // Once the caller joins too, its call is answered
    await join(room)
    await caller.join('quiet')
    await caller.call(room.peerId)
    await eventually(caller.answered, 1)
    await eventually(status(room.page), '2nd in the room')
  })

  test('a new call from the same person replaces the old one', async () => {
    const room = await openRoom('twice')
    const caller = await openCaller()
    await caller.join('twice')
    await join(room)
    const connections = () =>
      room.page.evaluate(() =>
        window.recorded.peerConnections.map(
          (connection) => connection.signalingState === 'closed'
        )
      )

    await caller.call(room.peerId)
    await eventually(caller.answered, 1)
    await caller.call(room.peerId)
    await eventually(caller.answered, 2)

    // The first call is closed and only the second one is shown
    assert.deepEqual(await connections(), [true, false])
    await eventually(attendees(room.page), ['audio+video playing'])
    assert.equal(await status(room.page)(), '2nd in the room')
  })

  test('a refused Join goes back to Join after trying again', async () => {
    const room = await openRoom('taken')
    // Someone already in the room holds the page's id
    const squatter = io(server.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    })
    await new Promise<void>((resolve, reject) => {
      squatter.once('connect', () => resolve())
      squatter.once('connect_error', reject)
    })
    squatter.emit('join-room', 'taken', room.peerId)
    await server.waitForOutput(`user: ${room.peerId} - joined: taken`)

    // The page keeps trying for a while, then shows Join again
    await room.page.click('#call')
    await eventually(() => controls(room.page), beforeJoining('taken'), 20_000)
    // The microphone the failed join captured is stopped again
    await eventually(
      async () => (await audioStates(room.page)()).every((s) => s === 'ended'),
      true,
      3_000
    )
    // The page itself never got in: only the squatter's join is logged
    assert.equal(
      server
        .output()
        .match(new RegExp(`user: ${room.peerId} - joined: taken`, 'g'))?.length,
      1
    )
    squatter.disconnect()
  })

  test('Leave cancels a Join that is still being retried', async () => {
    const room = await openRoom('taken-leave')
    const squatter = io(server.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    })
    await new Promise<void>((resolve, reject) => {
      squatter.once('connect', () => resolve())
      squatter.once('connect_error', reject)
    })
    squatter.emit('join-room', 'taken-leave', room.peerId)
    await server.waitForOutput(`user: ${room.peerId} - joined: taken-leave`)

    // Join is refused and retried every 2 seconds; Leave cancels that
    const from = server.output().length
    await room.page.click('#call')
    await server.waitForOutput('join-room refused: id already in room', from)
    await room.page.click('#call') // Leave
    await sleep(4_500) // beyond the next retry
    assert.equal(
      server
        .output()
        .slice(from)
        .match(/join-room refused: id already in room/g)?.length,
      1
    )
    assert.equal(
      server
        .output()
        .match(new RegExp(`user: ${room.peerId} - joined: taken-leave`, 'g'))
        ?.length,
      1
    )
    squatter.disconnect()
  })

  test('a call that beats the roster answer waits for it, then is answered', async () => {
    const room = await openRoom('early-call', heldJoinAnswer)
    const caller = await openCaller()
    await caller.join('early-call')
    // Call the moment the server says someone joined, and record closes
    await caller.page.evaluate(() => {
      window.caller.socket!.on('user-connected', (peerId: string) => {
        const call = window.caller.peer.call(peerId, window.caller.stream)
        // Fires once for each track
        call.on('stream', () => window.caller.answered.add(call.connectionId))
        call.on('close', () => window.caller.closed.add(call.connectionId))
      })
    })

    await room.page.click('#call') // Join; the page's roster answer is held

    // The offer arrives while the roster answer is held. An incoming call
    // has no connection until it is answered (peerjs.js: answer() starts
    // it), so no connection and no answer here. PeerJS close() on an
    // unanswered incoming call emits nothing (its `if (!this.open) return`
    // guard), so an empty close set is expected queued OR refused; only the
    // answer after release proves the call was queued, not refused.
    await eventually(
      () =>
        room.page.evaluate(() =>
          window.recorded.peerMessages.some(
            (message) => JSON.parse(message).type === 'OFFER'
          )
        ),
      true
    )
    assert.equal(
      await room.page.evaluate(() => window.recorded.peerConnections.length),
      0
    )
    assert.equal(await caller.answered(), 0)
    assert.equal(await caller.page.evaluate(() => window.caller.closed.size), 0)

    // The roster answer lands: the queued call is decided and answered
    await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)
    await room.page.evaluate(() => window.releaseJoinAnswer())
    await eventually(
      () => room.page.evaluate(() => window.recorded.peerConnections.length),
      1
    )
    await eventually(caller.answered, 1, 6_000)
  })

  test('capture grants that arrive after Leave are stopped, not used', async () => {
    const room = await openRoom('gated-leave', gatedCapture)

    // Camera chosen before Join, so Join asks for the camera and microphone;
    // Leave lands before either grant does
    await room.page.click('#camera')
    await room.page.click('#call')
    await room.page.waitForFunction(() => window.captureGate.length >= 2)
    await room.page.click('#call') // Leave
    await room.page.evaluate(async () => {
      for (const request of window.captureGate.splice(0))
        request.resolve(await window.realGetUserMedia(request.constraints))
    })

    // The late grants are discarded: nothing they captured stays live
    await eventually(
      async () => (await allTrackStates(room.page)()).length,
      2,
      3_000
    )
    assert.deepEqual(await allTrackStates(room.page)(), ['ended', 'ended'])
    assert.deepEqual(await showsCamera(room.page), { self: false, sent: [] })
    assert.deepEqual(await controls(room.page), {
      ...beforeJoining('gated-leave'),
      camera: 'Turn Off Camera',
      photoInput: false,
      hint: ''
    })
  })

  test('capture grants that arrive after a failed Join are stopped, not used', async () => {
    const room = await openRoom('gated-failed', gatedCapture)
    // Someone already in the room holds the page's id, so Join is refused
    const squatter = io(server.url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    })
    await new Promise<void>((resolve, reject) => {
      squatter.once('connect', () => resolve())
      squatter.once('connect_error', reject)
    })
    squatter.emit('join-room', 'gated-failed', room.peerId)
    await server.waitForOutput(`user: ${room.peerId} - joined: gated-failed`)

    // Camera chosen before Join; the grants are still held when the join
    // fails after all retries and the page returns to Join
    await room.page.click('#camera')
    await room.page.click('#call')
    await room.page.waitForFunction(() => window.captureGate.length >= 2)
    await eventually(
      () => controls(room.page),
      {
        ...beforeJoining('gated-failed'),
        camera: 'Turn Off Camera',
        photoInput: false,
        hint: ''
      },
      20_000
    )
    await room.page.evaluate(async () => {
      for (const request of window.captureGate.splice(0))
        request.resolve(await window.realGetUserMedia(request.constraints))
    })

    // The retired grants are discarded: nothing they captured stays live
    await eventually(
      async () => (await allTrackStates(room.page)()).length,
      2,
      3_000
    )
    assert.deepEqual(await allTrackStates(room.page)(), ['ended', 'ended'])
    squatter.disconnect()
  })

  for (const kind of ['video', 'audio'] as const) {
    for (const newerJoin of [false, true]) {
      const boundary = newerJoin ? 'a newer Join' : 'Leave'
      test(`${kind} rejection after ${boundary} is ignored`, async () => {
        const name = `old-rejection-${kind}-${newerJoin}`
        const room = await openRoom(name, gatedCapture)
        if (kind === 'video') await room.page.click('#camera')
        await join(room)
        await room.page.waitForFunction(() => window.captureGate.length > 0)
        await room.page.click('#call') // Leave retires the first requests
        if (newerJoin) {
          await join(room)
          await room.page.waitForFunction(
            (count) => window.captureGate.length >= count,
            kind === 'video' ? 4 : 2
          )
        }
        await room.page.evaluate(async (kind) => {
          const count = kind === 'video' ? 2 : 1
          const requests = window.captureGate.splice(0)
          for (const request of requests.slice(count))
            request.resolve(await window.realGetUserMedia(request.constraints))
          for (const request of requests.slice(0, count)) {
            if (request.constraints?.[kind])
              request.reject(new DOMException('Old denial', 'NotAllowedError'))
            else
              request.resolve(
                await window.realGetUserMedia(request.constraints)
              )
          }
          // Allow async capture continuations to handle the old result.
          await new Promise((resolve) => setTimeout(resolve, 0))
        }, kind)
        const expected = newerJoin
          ? inCall(name, '1st in the room')
          : beforeJoining(name)
        assert.deepEqual(await controls(room.page), {
          ...expected,
          ...(kind === 'video'
            ? { camera: 'Turn Off Camera', photoInput: false, hint: '' }
            : {})
        })
        if (newerJoin) {
          await eventually(
            async () =>
              (await allTrackStates(room.page)()).filter(
                (state) => state === 'live'
              ).length,
            kind === 'video' ? 2 : 1,
            3_000
          )
          await room.page.click('#call')
        }
        await eventually(
          async () =>
            (await allTrackStates(room.page)()).every(
              (state) => state === 'ended'
            ),
          true,
          3_000
        )
      })
    }
  }

  for (const kind of ['video', 'audio'] as const) {
    test(`${kind} rapid toggles retire older capture in both orders`, async () => {
      for (const latestFirst of [false, true]) {
        const room = await openRoom(
          `toggle-${kind}-${latestFirst}`,
          gatedCapture
        )
        const button = kind === 'video' ? '#camera' : '#mute'
        if (kind === 'video') await room.page.click(button)
        else await room.page.click(button) // Join muted, with no pending mic
        await join(room)
        if (kind === 'video') {
          await room.page.waitForFunction(() => window.captureGate.length === 2)
          // Finish the unrelated microphone request first.
          await room.page.evaluate(async () => {
            const index = window.captureGate.findIndex(
              (r) => r.constraints?.audio
            )
            const [request] = window.captureGate.splice(index, 1)
            request.resolve(await window.realGetUserMedia(request.constraints))
          })
        } else await room.page.click(button) // First pending mic request
        await room.page.waitForFunction(() => window.captureGate.length === 1)
        await room.page.click(button) // Off while first request is pending
        await room.page.click(button) // On creates the current request
        await room.page.waitForFunction(() => window.captureGate.length === 2)
        const states = await room.page.evaluate(async (latestFirst) => {
          const requests = window.captureGate.splice(0)
          const streams: MediaStream[] = []
          for (const index of latestFirst ? [1, 0] : [0, 1]) {
            streams[index] = await window.realGetUserMedia(
              requests[index].constraints
            )
            requests[index].resolve(streams[index])
            await new Promise((resolve) => setTimeout(resolve, 0))
          }
          return streams.map((stream) => stream.getTracks()[0].readyState)
        }, latestFirst)
        assert.deepEqual(states, ['ended', 'live'])
        await room.page.click(button) // Stop Video or Mute
        await eventually(
          async () =>
            room.page.evaluate(
              (kind) =>
                window.recorded.mediaStreams
                  .flatMap((stream) => stream.getTracks())
                  .filter((track) => track.kind === kind)
                  .every((track) => track.readyState === 'ended'),
              kind
            ),
          true,
          3_000
        )
        await room.page.click('#call') // Leave stops any other capture too
        await eventually(
          async () =>
            (await allTrackStates(room.page)()).every(
              (state) => state === 'ended'
            ),
          true,
          3_000
        )
      }
    })
  }

  for (const kind of ['video', 'audio'] as const) {
    test(`${kind} grant that arrives after the choice changed is stopped, not used`, async () => {
      const name = `choice-changed-${kind}`
      const room = await openRoom(name, gatedCapture)
      const button = kind === 'video' ? '#camera' : '#mute'
      if (kind === 'video') await room.page.click(button)
      await join(room)
      await room.page.waitForFunction(() => window.captureGate.length > 0)
      if (kind === 'video') {
        // Finish the unrelated microphone request first
        await room.page.evaluate(async () => {
          const index = window.captureGate.findIndex(
            (request) => request.constraints?.audio
          )
          const [request] = window.captureGate.splice(index, 1)
          request.resolve(await window.realGetUserMedia(request.constraints))
        })
        await room.page.waitForFunction(() => window.captureGate.length === 1)
      }

      // The choice changes while the capture grant is still pending
      await room.page.click(button)
      await room.page.evaluate(async () => {
        const [request] = window.captureGate.splice(0)
        request.resolve(await window.realGetUserMedia(request.constraints))
      })

      // The late grant is stopped, never shown or sent
      await eventually(
        async () =>
          room.page.evaluate(
            (kind) =>
              window.recorded.mediaStreams
                .flatMap((stream) => stream.getTracks())
                .filter((track) => track.kind === kind)
                .map((track) => track.readyState),
            kind
          ),
        ['ended'],
        3_000
      )
      assert.deepEqual(await controls(room.page), {
        ...inCall(name, '1st in the room'),
        ...(kind === 'audio' ? { mute: 'Unmute' } : {})
      })
      if (kind === 'video')
        assert.deepEqual(await showsCamera(room.page), {
          self: false,
          sent: []
        })
    })
  }

  for (const kind of ['video', 'audio'] as const) {
    test(`${kind} rejection from before a newer choice is ignored`, async () => {
      const name = `choice-race-${kind}`
      const room = await openRoom(name, gatedCapture)
      const button = kind === 'video' ? '#camera' : '#mute'
      if (kind === 'video') await room.page.click(button)
      await join(room)
      await room.page.waitForFunction(() => window.captureGate.length > 0)
      if (kind === 'video') {
        // Finish the unrelated microphone request first
        await room.page.evaluate(async () => {
          const index = window.captureGate.findIndex(
            (request) => request.constraints?.audio
          )
          const [request] = window.captureGate.splice(index, 1)
          request.resolve(await window.realGetUserMedia(request.constraints))
        })
        await room.page.waitForFunction(() => window.captureGate.length === 1)
      }

      // Off retires the pending request; on starts the current one
      await room.page.click(button)
      await room.page.click(button)
      await room.page.waitForFunction(() => window.captureGate.length === 2)
      await room.page.evaluate(async () => {
        const [older, newer] = window.captureGate.splice(0)
        older.reject(new DOMException('Old denial', 'NotAllowedError'))
        // Let the retired rejection's continuation run first
        await new Promise((resolve) => setTimeout(resolve, 0))
        newer.resolve(await window.realGetUserMedia(newer.constraints))
      })

      // The retired rejection writes no choice and shows no error; the
      // current grant is live and used
      assert.deepEqual(await controls(room.page), {
        ...inCall(name, '1st in the room'),
        ...(kind === 'video'
          ? { camera: 'Turn Off Camera', photoInput: false, hint: '' }
          : {})
      })
      await eventually(
        async () =>
          room.page.evaluate(
            (kind) =>
              window.recorded.mediaStreams
                .flatMap((stream) => stream.getTracks())
                .filter((track) => track.kind === kind)
                .map((track) => track.readyState),
            kind
          ),
        ['live'],
        3_000
      )
      if (kind === 'video')
        await eventually(() => showsCamera(room.page), {
          self: true,
          sent: []
        })
    })
  }
})

test('after losing the PeerJS server, says so and reconnects with the same id', async () => {
  const a = await openRoom('reconnect')
  await a.page.evaluate(() => window.recorded.peerSockets[0].close())
  await eventually(
    async () => (await controls(a.page)).error,
    'Connection problem: network: Lost connection to server.'
  )

  // room.js waits 5 seconds before reconnecting
  const sockets = () =>
    a.page.evaluate(() =>
      window.recorded.peerSockets.map((socket) => {
        const id = new URL(socket.url).searchParams.get('id')
        return `${id} ${socket.readyState === WebSocket.OPEN ? 'open' : 'closed'}`
      })
    )
  await eventually(sockets, [`${a.peerId} closed`, `${a.peerId} open`], 8_000)

  // And calls work again
  const b = await openRoom('reconnect')
  await join(a)
  await join(b)
  await eventually(status(a.page), '2nd in the room')
  await eventually(status(b.page), '2nd in the room')
})

test('a roster answer that arrives after Leave is ignored', async () => {
  const room = await openRoom('stale-roster', [heldJoinAnswer, recordRoomCalls])
  await room.page.click('#call') // First Join; its empty roster answer is held
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)
  await room.page.click('#call') // Leave retires that attempt

  // A member joins, then the page's fresh Join is answered with them in it
  const member = await openCaller()
  await member.join('stale-roster')
  await room.page.click('#call')
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 2)

  // The sensitivity below assumes the stale answer is a success with an
  // empty roster and the fresh one names the member; check both payloads
  assert.deepEqual(await heldAnswers(room.page), [
    [null, []],
    [null, [await member.page.evaluate(() => window.caller.peer.id)]]
  ])

  // The stale empty answer lands first. If it loaded a roster, the member
  // would be refused as a non-member below (line 341 prevents exactly that)
  await room.page.evaluate(() => window.releaseJoinAnswer())
  const memberId = await member.page.evaluate(() => window.caller.peer.id)
  await member.call(room.peerId)
  // Sending the offer does not wait for the room page to process it; hold
  // the fresh answer until the call has arrived and queued behind it,
  // or the drain below is not what answers the call
  await eventually(
    () => incomingCalls(room.page).then((ids) => ids.includes(memberId)),
    true
  )
  // Still waiting: neither answered nor closed, with one answer held.
  // With 341 deleted the member is already closed here, so the test fails
  // fast with a reason instead of timing out below.
  assert.ok(!(await closedCalls(room.page)).includes(memberId))
  assert.ok(!(await answeredCalls(room.page)).includes(memberId))
  assert.equal(await room.page.evaluate(() => window.heldJoinAnswers.length), 1)

  // The fresh answer names the member, so their waiting call is answered
  await room.page.evaluate(() => window.releaseJoinAnswer())
  await eventually(member.answered, 1)
  assert.ok(!(await closedCalls(room.page)).includes(memberId))
  assert.deepEqual(await answeredCalls(room.page), [memberId])
  await eventually(status(room.page), '2nd in the room')
})

test('a call from outside the room is turned down while joined', async () => {
  const room = await openRoom('outsider', [heldJoinAnswer, recordRoomCalls])
  await join(room)
  // join() only waits for the server log; wait for the answer itself
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)
  assert.deepEqual(await heldAnswers(room.page), [[null, []]])
  await room.page.evaluate(() => window.releaseJoinAnswer())
  await eventually(status(room.page), '1st in the room')

  // The roster is loaded and empty: an outsider's offer is refused at once.
  // The positive proof is the spy seeing the room close the outsider's
  // incoming call (answerIfMember's refusal); the negative proof is that no
  // stream is ever sent back (a caller-side close event cannot be the proof:
  // peerjs.js emits nothing for a close before the call is open).
  const outsider = await openCaller() // Never joins the room
  await outsider.call(room.peerId)
  const outsiderId = await outsider.page.evaluate(() => window.caller.peer.id)
  await eventually(
    () => closedCalls(room.page).then((ids) => ids.includes(outsiderId)),
    true
  )

  // A member's call right after is answered, so the refusal was a decision
  // about the outsider, not a stuck call path
  const member = await openCaller()
  await member.join('outsider')
  await member.call(room.peerId)
  const memberId = await member.page.evaluate(() => window.caller.peer.id)
  await eventually(member.answered, 1)
  assert.equal(await outsider.answered(), 0)
  assert.deepEqual(await closedCalls(room.page), [outsiderId])
  assert.ok(!(await closedCalls(room.page)).includes(memberId))
  assert.deepEqual(await answeredCalls(room.page), [memberId])
  await eventually(status(room.page), '2nd in the room')
})

test('an outside call that beats the roster answer is turned down when it loads', async () => {
  // The member joins first, so the page's held roster answer names them and
  // the drain below decides both calls from the roster alone - not from a
  // member-joined notification overtaking the held answer
  const member = await openCaller()
  await member.join('early-outsider')
  const room = await openRoom('early-outsider', [
    heldJoinAnswer,
    recordRoomCalls
  ])
  await join(room) // Joined at the server; its roster answer is still held
  const outsider = await openCaller() // Never joins the room

  // Both calls arrive before the roster and wait for it. When it loads, the
  // member's is answered and the outsider's is closed by the same pass, so
  // neither is left waiting.
  await outsider.call(room.peerId)
  await member.call(room.peerId)
  const outsiderId = await outsider.page.evaluate(() => window.caller.peer.id)
  const memberId = await member.page.evaluate(() => window.caller.peer.id)
  // Sending the offers does not wait for the room page to process them; both
  // must have arrived (and queued) before the roster lands, or the drain
  // loop under test never runs
  await eventually(
    () =>
      incomingCalls(room.page).then(
        (ids) => ids.includes(outsiderId) && ids.includes(memberId)
      ),
    true
  )
  // Still waiting: neither call answered nor closed, and the held answer
  // names the member - the drain below is what decides both calls
  assert.deepEqual(await closedCalls(room.page), [])
  assert.deepEqual(await answeredCalls(room.page), [])
  assert.deepEqual(await heldAnswers(room.page), [[null, [memberId]]])
  await room.page.evaluate(() => window.releaseJoinAnswer())
  await eventually(member.answered, 1)
  await eventually(
    () => closedCalls(room.page).then((ids) => ids.includes(outsiderId)),
    true
  )
  assert.equal(await outsider.answered(), 0)
  assert.ok(!(await closedCalls(room.page)).includes(memberId))
  assert.deepEqual(await answeredCalls(room.page), [memberId])
  await eventually(status(room.page), '2nd in the room')
})

test('a Join buffered while disconnected is cancelled by Leave', async () => {
  const room = await openRoom('buffered-join', [
    heldJoinAnswer,
    recordRoomCalls
  ])
  await join(room)
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)
  await room.page.evaluate(() => window.releaseJoinAnswer())
  await eventually(status(room.page), '1st in the room')

  // Leave cleanly while connected: the server forgets the page
  const from = server.output().length
  await room.page.click('#call') // Leave
  assert.deepEqual(await controls(room.page), beforeJoining('buffered-join'))
  await server.waitForOutput(`user: ${room.peerId} - left: buffered-join`, from)

  // Disconnect the socket: it can no longer send. Join now buffers the
  // packet and registers its ack - observed, not inferred
  await room.page.evaluate(() => window.roomSocket.disconnect())
  await room.page.click('#call') // Join, buffered
  assert.deepEqual(
    await room.page.evaluate(() => {
      const packet = window.roomSocket.sendBuffer[0]?.data as
        unknown[] | undefined
      return {
        connected: window.roomSocket.connected,
        event: packet?.[0],
        buffered: window.roomSocket.sendBuffer.length
      }
    }),
    { connected: false, event: 'join-room', buffered: 1 }
  )
  const attempt = await room.page.evaluate(() => window.joinAttempts.length)

  // Watch the socket before Leave: the connect listener proves the
  // replacement connection by its new id, and the outgoing hook sees
  // every event packet the reconnect flush sends
  const oldSocketId = await room.page.evaluate(() => {
    window.outgoingPackets = []
    window.roomSocket.onAnyOutgoing((event) =>
      window.outgoingPackets.push(String(event))
    )
    const old = window.roomSocket.id
    window.roomSocket.once('connect', () => {
      window.reconnectedAs = window.roomSocket.id
    })
    return old
  })

  // Leave retires the attempt and purges its buffered Join: observed
  // synchronously inside the click, before any reconnect flush
  const flushed = server.output().length
  assert.deepEqual(
    await room.page.evaluate(() => {
      document.querySelector<HTMLElement>('#call')?.click()
      return window.roomSocket.sendBuffer.map(
        (packet) => (packet.data as unknown[])[0]
      )
    }),
    []
  )
  assert.deepEqual(await controls(room.page), beforeJoining('buffered-join'))

  // The purged attempt's acknowledgement still resolves: its timeout
  // error, in this already-disconnected state. The error alone would
  // not prove cancellation; the purge assertion above and the flush
  // log below do that
  await room.page.waitForFunction(
    (id) => window.joinAttempts[id - 1]?.outcome !== undefined,
    attempt
  )
  const outcome = await room.page.evaluate(
    (id) => window.joinAttempts[id - 1].outcome,
    attempt
  )
  assert.ok(outcome && 'error' in outcome)
  assert.match(outcome.error, /timed out/)

  // The replacement connection is a new socket whose flush carried no
  // join-room, and the server never re-adds the page
  await room.page.waitForFunction(
    (old) => window.reconnectedAs !== undefined && window.reconnectedAs !== old,
    oldSocketId
  )
  assert.deepEqual(
    await room.page.evaluate(() =>
      window.outgoingPackets.filter((event) => event === 'join-room')
    ),
    []
  )
  assert.ok(
    !server
      .output()
      .slice(flushed)
      .includes(`user: ${room.peerId} - joined: buffered-join`)
  )

  // A later joiner: the server does not name the departed page
  const joiner = await openRoom('buffered-join', [
    heldJoinAnswer,
    recordRoomCalls
  ])
  await join(joiner)
  await joiner.page.waitForFunction(() => window.heldJoinAnswers.length === 1)
  assert.deepEqual(await heldAnswers(joiner.page), [[null, []]])
  await joiner.page.evaluate(() => window.releaseJoinAnswer())

  // The page's next Join is a first Join again: the participant hears
  // the announcement and calls the page itself. The call records are
  // cleared before the rejoin click, so a call from the phantom era
  // could not satisfy this
  await joiner.page.evaluate(() => {
    window.outgoingConns.length = 0
  })
  await room.page.click('#call') // Join again
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)
  assert.deepEqual(await heldAnswers(room.page), [[null, [joiner.peerId]]])
  await room.page.evaluate(() => window.releaseJoinAnswer())
  await joiner.page.waitForFunction(
    (peerId) => window.outgoingConns.some((conn) => conn.peer === peerId),
    room.peerId
  )
  await room.page.waitForFunction(
    (peerId) => window.answeredCalls.includes(peerId),
    joiner.peerId
  )
  await eventually(status(room.page), '2nd in the room')
})

test('a Join buffered past the ping deadline is cancelled by Leave', async () => {
  const room = await openRoom('same-task-join', [
    heldJoinAnswer,
    recordRoomCalls
  ])
  await join(room)
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)
  await room.page.evaluate(() => window.releaseJoinAnswer())
  await eventually(status(room.page), '1st in the room')

  // Leave cleanly while connected: the server forgets the page, and
  // Leave's own reconnect gives the socket a live connection again
  const left = server.output().length
  await room.page.click('#call') // Leave
  await server.waitForOutput(
    `user: ${room.peerId} - left: same-task-join`,
    left
  )
  await room.page.waitForFunction(() => window.roomSocket.connected)

  const oldSocketId = await room.page.evaluate(() => {
    window.outgoingPackets = []
    window.roomSocket.onAnyOutgoing((event) =>
      window.outgoingPackets.push(String(event))
    )
    const old = window.roomSocket.id
    window.roomSocket.once('connect', () => {
      window.reconnectedAs = window.roomSocket.id
    })
    return old
  })

  // One synchronous task: the clock moves past the ping deadline (45
  // seconds of server defaults covers wherever it last reset), Join
  // buffers while the socket still reports connected because the
  // pending close is only scheduled as a microtask, the clock
  // restores, and Leave purges the packet, all before the scheduled
  // close can run
  const facts = await room.page.evaluate(() => {
    const socket = window.roomSocket
    const realNow = Date.now
    const facts: {
      precondition?: { connected: boolean; event: unknown; buffered: number }
      attempt: number
      bufferedAfterLeave?: number
      outcome?: { answer: unknown[] } | { error: string }
    } = { attempt: 0 }
    try {
      Date.now = () => realNow() + 60_000
      document.querySelector<HTMLElement>('#call')?.click()
      const packet = socket.sendBuffer[0]?.data as unknown[] | undefined
      facts.precondition = {
        connected: socket.connected,
        event: packet?.[0],
        buffered: socket.sendBuffer.length
      }
      facts.attempt = window.joinAttempts.length
    } finally {
      // Restored before Leave even when a step fails, so the shifted
      // clock cannot leak into the disconnect or later tests
      Date.now = realNow
    }
    document.querySelector<HTMLElement>('#call')?.click() // Leave
    facts.bufferedAfterLeave = socket.sendBuffer.length
    facts.outcome = window.joinAttempts[facts.attempt - 1]?.outcome
    return facts
  })
  assert.deepEqual(facts.precondition, {
    connected: true,
    event: 'join-room',
    buffered: 1
  })
  assert.deepEqual(facts.bufferedAfterLeave, 0)

  // Both checks in one assertion, so a failing ordering check cannot
  // hide the behavioral one: with the packet already purged, the
  // disconnect inside the Leave click errored the ack at once, and
  // the replacement connection's flush carried no join-room
  await room.page.waitForFunction(
    (old) => window.reconnectedAs !== undefined && window.reconnectedAs !== old,
    oldSocketId
  )
  const joinRoomSent = await room.page.evaluate(() =>
    window.outgoingPackets.includes('join-room')
  )
  assert.deepEqual(
    {
      ackOutcome:
        facts.outcome && 'error' in facts.outcome
          ? facts.outcome.error
          : undefined,
      joinRoomSent
    },
    { ackOutcome: 'Error: socket has been disconnected', joinRoomSent: false }
  )
})

test('a Join buffered without Leave succeeds on its original attempt', async () => {
  const room = await openRoom('buffered-rejoin', [
    heldJoinAnswer,
    recordRoomCalls
  ])
  await join(room)
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)
  await room.page.evaluate(() => window.releaseJoinAnswer())
  await eventually(status(room.page), '1st in the room')

  const left = server.output().length
  await room.page.click('#call') // Leave
  await server.waitForOutput(
    `user: ${room.peerId} - left: buffered-rejoin`,
    left
  )

  await room.page.evaluate(() => window.roomSocket.disconnect())
  await room.page.click('#call') // Join, buffered
  const attempt = await room.page.evaluate(() => window.joinAttempts.length)
  assert.deepEqual(
    await room.page.evaluate(() => window.roomSocket.sendBuffer.length),
    1
  )

  // No Leave: the original attempt stays live, the reconnect flushes
  // it, and its own answer arrives - no timeout recorded
  await room.page.evaluate(() => window.roomSocket.connect())
  await room.page.waitForFunction(
    (id) => window.joinAttempts[id - 1]?.outcome !== undefined,
    attempt
  )
  const outcome = await room.page.evaluate(
    (id) => window.joinAttempts[id - 1].outcome,
    attempt
  )
  assert.ok(outcome && 'answer' in outcome)
  await room.page.evaluate(() => window.releaseJoinAnswer())
  await eventually(status(room.page), '1st in the room')
})

test('a buffered Join lost before reconnect is retried, its loss recorded', async () => {
  const room = await openRoom('buffered-loss', [
    heldJoinAnswer,
    recordRoomCalls
  ])
  await join(room)
  await room.page.waitForFunction(() => window.heldJoinAnswers.length === 1)
  await room.page.evaluate(() => window.releaseJoinAnswer())
  await eventually(status(room.page), '1st in the room')

  const left = server.output().length
  await room.page.click('#call') // Leave
  await server.waitForOutput(`user: ${room.peerId} - left: buffered-loss`, left)

  await room.page.evaluate(() => window.roomSocket.disconnect())
  await room.page.click('#call') // Join, buffered
  const attempt = await room.page.evaluate(() => window.joinAttempts.length)

  // The test itself drops the packet, the over-purge the control above
  // exists to catch: the original attempt can only time out, and the
  // retry loop still joins the page about 7 seconds later
  await room.page.evaluate(() => {
    window.roomSocket.sendBuffer.length = 0
    window.roomSocket.connect()
  })
  await room.page.waitForFunction(
    (id) => window.joinAttempts[id - 1]?.outcome !== undefined,
    attempt
  )
  const lost = await room.page.evaluate(
    (id) => window.joinAttempts[id - 1].outcome,
    attempt
  )
  assert.ok(lost && 'error' in lost)
  assert.match(lost.error, /timed out/)

  // The retry's own tagged attempt succeeds on a fresh answer
  await room.page.waitForFunction(
    (id) =>
      window.joinAttempts.length > id && window.heldJoinAnswers.length === 1,
    attempt
  )
  assert.deepEqual(await heldAnswers(room.page), [[null, []]])
  await room.page.evaluate(() => window.releaseJoinAnswer())
  await eventually(status(room.page), '1st in the room')
})

test('a page that has not joined makes no call when a joiner is announced', async () => {
  const room = await openRoom('stray-member', [heldJoinAnswer, recordRoomCalls])

  // Register the page at the server directly, while it shows Join: no
  // callback, so the server joins the socket without replying
  await room.page.evaluate(
    ({ name, peerId }) => {
      window.roomSocket.emit('join-room', name, peerId)
    },
    { name: room.name, peerId: room.peerId }
  )
  await server.waitForOutput(`user: ${room.peerId} - joined: stray-member`)

  // The page's own handler runs first, so by the time this listener
  // records the announcement any call it made would be recorded too
  await room.page.evaluate(() => {
    window.announcedPeers = []
    window.roomSocket.on('user-connected', (peerId) => {
      window.announcedPeers.push(String(peerId))
    })
  })

  const joiner = await openRoom('stray-member', [
    heldJoinAnswer,
    recordRoomCalls
  ])
  await join(joiner)
  await joiner.page.waitForFunction(() => window.heldJoinAnswers.length === 1)
  // Positive control: the roster names the page
  assert.deepEqual(await heldAnswers(joiner.page), [[null, [room.peerId]]])
  await joiner.page.evaluate(() => window.releaseJoinAnswer())

  // The announcement reached the page - and it made no call. Without
  // the joined guard this fails with the joiner's id recorded, which
  // doubles as the call-recording hook's positive control
  await room.page.waitForFunction(
    (peerId) => window.announcedPeers.includes(peerId),
    joiner.peerId
  )
  assert.deepEqual(
    await room.page.evaluate(() =>
      window.outgoingConns.map((conn) => conn.peer)
    ),
    []
  )
})

test('the served socket.io bundle matches what the Join purge depends on', async () => {
  // The purge and its tests read socket.io's internal sendBuffer, so a
  // bundle change must fail here and force a fresh look at both. The
  // pin is the served file, not the npm package
  const response = await fetch(`${server.url}/socket.io/socket.io.min.js`)
  const hash = createHash('sha256')
    .update(Buffer.from(await response.arrayBuffer()))
    .digest('hex')
  assert.equal(
    hash,
    'd5d79a35039e860b32bdef4795528b05c2f788d4b2d9dacc913120e2878f7b3f'
  )
})

test('turning the camera back on captures a fresh track', async () => {
  const room = await openRoom('camera-re-on')
  await room.page.click('#camera') // Chosen before Join
  await join(room)
  await eventually(() => showsCamera(room.page), { self: true, sent: [] })

  await room.page.click('#camera') // Off: the live track is stopped
  await eventually(() => showsCamera(room.page), { self: false, sent: [] })

  await room.page.click('#camera') // On again: the ended track is replaced
  await eventually(() => showsCamera(room.page), { self: true, sent: [] })

  // One ended video track from the first capture, one live from the second
  const videoStates = () =>
    room.page.evaluate(() =>
      window.recorded.mediaStreams
        .flatMap((stream) => stream.getVideoTracks())
        .map((track) => track.readyState)
    )
  assert.deepEqual((await videoStates()).sort(), ['ended', 'live'])
})
