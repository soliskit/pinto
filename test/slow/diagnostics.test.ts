import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, afterEach, before, test } from 'node:test'
import { io } from 'socket.io-client'
import type { Browser, BrowserContext, Page } from 'playwright'
import {
  eventually,
  launchBrowser,
  record,
  startServer,
  type Server
} from '../helpers.ts'

/**
 * Known-defect diagnostics (migration plan phase 2). Each one asserted the
 * intended behavior of a defect while its fix was not approved yet, marked
 * todo; each fix's pull request removed the mark, so these now run as the
 * gating regression tests for the privacy and call-access fixes.
 */

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
async function newPage() {
  const context = await browser.newContext({ baseURL: server.url })
  context.setDefaultTimeout(10_000)
  contexts.push(context)
  await context.addInitScript(record)
  return context.newPage()
}

interface Room {
  page: Page
  name: string
  peerId: string
}

/** Opens a room page and waits until Join can be pressed */
async function openRoom(name: string): Promise<Room> {
  const page = await newPage()
  const idResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/pinto/id'
  )
  await page.goto(`/room/${encodeURIComponent(name)}`)
  const peerId = await (await idResponse).text()
  await page.locator('#call:enabled').waitFor()
  return { page, name, peerId }
}

/** Presses Join and waits until the server has put the page in the room */
async function join({ page, name, peerId }: Room) {
  const from = server.output().length
  await page.click('#call')
  await server.waitForOutput(`user: ${peerId} - joined: ${name}`, from)
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

/** The other people's videos a room page shows */
const remoteVideos = (page: Page) =>
  page.evaluate(() => document.querySelectorAll('#attendees video').length)

/** Reads a value for `ms` and fails if it ever stops equalling `expected` */
async function stays<T>(read: () => Promise<T>, expected: T, ms = 3_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    assert.deepEqual(await read(), expected)
    await sleep(50)
  }
}

test('Stop Video, Mute and Leave stop capture', async () => {
  const room = await openRoom('diag-capture')
  const states = async (kind: 'audio' | 'video') =>
    room.page.evaluate(
      (kind) =>
        window.recorded.mediaStreams
          .flatMap((stream) => stream.getTracks())
          .filter((track) => track.kind === kind)
          .map((track) => track.readyState),
      kind
    )
  const lastState = async (kind: 'audio' | 'video') =>
    (await states(kind)).at(-1)

  // Nothing is captured before joining
  assert.deepEqual(await states('audio'), [])
  assert.deepEqual(await states('video'), [])

  await join(room)
  await eventually(() => lastState('audio'), 'live', 3_000)

  await room.page.click('#camera') // Turn On Camera
  await eventually(() => lastState('video'), 'live', 3_000)

  await room.page.click('#camera') // Stop Video
  await eventually(() => lastState('video'), 'ended', 3_000)

  await room.page.click('#mute')
  await eventually(() => lastState('audio'), 'ended', 3_000)

  await room.page.click('#call') // Leave
  await eventually(
    async () => (await states('audio')).every((state) => state === 'ended'),
    true,
    3_000
  )
  await eventually(
    async () => (await states('video')).every((state) => state === 'ended'),
    true,
    3_000
  )
})

test('a caller who never joined is not answered', async () => {
  const room = await openRoom('diag-stranger')
  await join(room)
  const caller = await openCaller()

  await caller.call(room.peerId)
  await stays(
    async () => [await caller.answered(), await remoteVideos(room.page)],
    [0, 0]
  )
})

test('a stranger cannot end a call by joining and leaving as someone else', async () => {
  const a = await openRoom('diag-impersonation')
  await join(a)
  const b = await openRoom('diag-impersonation')
  await join(b)
  await eventually(() => remoteVideos(a.page), 1)
  await eventually(() => remoteVideos(b.page), 1)

  // A stranger joins the room over socket.io claiming b's peer id, then
  // leaves by disconnecting
  const stranger = io(server.url)
  await new Promise<void>((resolve) => stranger.on('connect', () => resolve()))
  stranger.emit('join-room', a.name, b.peerId)
  stranger.disconnect()

  await stays(
    async () => [await remoteVideos(a.page), await remoteVideos(b.page)],
    [1, 1],
    6_000
  )
})
