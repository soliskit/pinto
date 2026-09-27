import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, afterEach, before, describe, test } from 'node:test'
import type { Browser, BrowserContext, Page } from 'playwright'
import {
  eventually,
  launchBrowser,
  startServer,
  type Server
} from './helpers.ts'

declare const Peer: typeof import('peerjs').Peer

declare global {
  interface Window {
    recorded: {
      /** The camera and microphone stream room.js got */
      media?: MediaStream
      peerConnections: RTCPeerConnection[]
      /** WebSockets to the PeerJS server, and the messages they received */
      peerSockets: WebSocket[]
      peerMessages: string[]
    }
    caller: {
      peer: InstanceType<typeof Peer>
      stream: MediaStream
      /** Ids of the calls answered with a stream */
      answered: Set<string>
    }
  }
}

/** Runs in each page before its scripts, to record what room.js creates */
function record() {
  const recorded: Window['recorded'] = {
    peerConnections: [],
    peerSockets: [],
    peerMessages: []
  }
  window.recorded = recorded

  const { mediaDevices } = navigator
  const getUserMedia = mediaDevices.getUserMedia.bind(mediaDevices)
  mediaDevices.getUserMedia = async (constraints) =>
    (recorded.media = await getUserMedia(constraints))

  window.RTCPeerConnection = class extends RTCPeerConnection {
    constructor(configuration?: RTCConfiguration) {
      super(configuration)
      recorded.peerConnections.push(this)
    }
  }

  window.WebSocket = class extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      if (!String(url).includes('/peerjs')) return
      recorded.peerSockets.push(this)
      this.addEventListener('message', (event) =>
        recorded.peerMessages.push(event.data)
      )
    }
  }
}

function withoutCamera() {
  navigator.mediaDevices.getUserMedia = () =>
    Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
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

/** Opens a room page and waits until Join Now can be pressed */
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

/** Presses Join Now and waits until the server has put the page in the room */
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
  title: `Pinto Pinto | ${room}`,
  heading: `Join room: ${room}`,
  status: 'Choose Join Now to begin call',
  mute: 'Mute',
  camera: 'Start Video',
  call: 'Join Now',
  callEnds: false,
  removePhoto: false,
  photoInput: true,
  hint: 'Choose a photo to show instead of video',
  error: null
})

const inCall = (room: string, status: string) => ({
  ...beforeJoining(room),
  heading: `Joined | ${room}`,
  status,
  call: 'End',
  callEnds: true
})

const status = (page: Page) => () => page.textContent('#status')

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
    window.caller = { peer, stream, answered: new Set() }
  })
  await page.waitForFunction(() => window.caller.peer.open)
  return {
    call: (peerId: string) =>
      page.evaluate((peerId) => {
        const call = window.caller.peer.call(peerId, window.caller.stream)
        // Fires once for each track
        call.on('stream', () => window.caller.answered.add(call.connectionId))
      }, peerId),
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
    const { page } = await openRoom('mute')
    const microphone = () =>
      page.evaluate(() =>
        window.recorded.media?.getAudioTracks().map((track) => track.enabled)
      )
    assert.deepEqual(await microphone(), [true])

    await page.click('#mute')
    assert.deepEqual(await controls(page), {
      ...beforeJoining('mute'),
      mute: 'Unmute'
    })
    assert.deepEqual(await microphone(), [false])

    await page.click('#mute')
    assert.deepEqual(await controls(page), beforeJoining('mute'))
    assert.deepEqual(await microphone(), [true])
  })

  test('Start Video shows the camera, and Stop Video the photo again', async () => {
    const { page } = await openRoom('camera')

    await page.click('#camera')
    assert.deepEqual(await controls(page), {
      ...beforeJoining('camera'),
      camera: 'Stop Video',
      photoInput: false,
      hint: ''
    })
    assert.deepEqual(await showsCamera(page), { self: true, sent: [] })

    await page.click('#camera')
    assert.deepEqual(await controls(page), beforeJoining('camera'))
    assert.deepEqual(await showsCamera(page), { self: false, sent: [] })
  })

  test('without a camera, says why and still lets you join', async () => {
    const room = await openRoom('no camera', withoutCamera)
    const unavailable = {
      ...beforeJoining('no camera'),
      camera: 'Start Video (disabled)',
      error: 'Camera: Camera and microphone are unavailable: Permission denied'
    }
    assert.deepEqual(await controls(room.page), unavailable)

    await join(room)
    assert.deepEqual(await controls(room.page), {
      ...inCall('no camera', '1st in the room'),
      camera: 'Start Video (disabled)',
      error: unavailable.error
    })
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
  test('Join Now joins the room, and End leaves it', async () => {
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

  test('End leaves the call for everyone, and Join Now joins again', async () => {
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

  test('Start Video and Stop Video change what the call sends', async () => {
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

    await join(room)
    await caller.call(room.peerId)
    await eventually(caller.answered, 1)
    await eventually(status(room.page), '2nd in the room')
  })

  test('a new call from the same person replaces the old one', async () => {
    const room = await openRoom('twice')
    await join(room)
    const caller = await openCaller()
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
})

test('after losing the PeerJS server, says so and reconnects with the same id', async () => {
  const a = await openRoom('reconnect')
  await a.page.evaluate(() => window.recorded.peerSockets[0].close())
  await eventually(
    async () => (await controls(a.page)).error,
    'Peer: network: Lost connection to server.'
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
