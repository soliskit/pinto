import assert from 'node:assert/strict'
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

/** Holds the page's processing of the join answer until the test releases it */
function heldJoinAnswer() {
  let realIo: typeof import('socket.io-client').io
  Object.defineProperty(window, 'io', {
    configurable: true,
    get() {
      return (...args: Parameters<typeof import('socket.io-client').io>) => {
        const socket = realIo(...args)
        const realEmit = socket.emit.bind(socket)
        socket.emit = (event: string, ...rest: unknown[]) => {
          const callback = rest.at(-1)
          if (event === 'join-room' && typeof callback === 'function') {
            rest.pop()
            // The answer itself arrived in time: socket.io clears its ack
            // timeout on arrival. Only the page's processing is held.
            return realEmit(event, ...rest, (...answer: unknown[]) => {
              window.releaseJoinAnswer = () => callback(...answer)
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
async function newPage(init?: () => void) {
  const context = await browser.newContext({ baseURL: server.url })
  context.setDefaultTimeout(10_000)
  contexts.push(context)
  await context.addInitScript(record)
  if (init) await context.addInitScript(init)
  return context.newPage()
}

interface Room {
  page: Page
  name: string
  peerId: string
}

/** Opens a room page and waits until Join can be pressed */
async function openRoom(name: string, init?: () => void): Promise<Room> {
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
