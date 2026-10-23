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
 * Known-defect diagnostics (migration plan phase 2). Each one asserts the
 * intended behavior of a defect whose fix is not approved yet, so it runs
 * marked todo: it reports on every run without gating, and its fix's pull
 * request removes the mark to make it the gating regression test.
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

test(
  'Stop Video, Mute and Leave stop capture',
  {
    todo: 'Known defect (audit finding 1): the tracks stay live. The fix removes this mark.'
  },
  async () => {
    const room = await openRoom('diag-capture')
    const state = async (kind: 'audio' | 'video') =>
      room.page.evaluate(
        (kind) =>
          window.recorded.media
            ?.getTracks()
            .find((track) => track.kind === kind)?.readyState,
        kind
      )

    await room.page.click('#camera')
    await eventually(() => state('video'), 'ended', 3_000)

    await room.page.click('#mute')
    await eventually(() => state('audio'), 'ended', 3_000)

    await join(room)
    await room.page.click('#call') // Leave
    await eventually(() => state('video'), 'ended', 3_000)
    await eventually(() => state('audio'), 'ended', 3_000)
  }
)

test(
  'a caller who never joined is not answered',
  {
    todo: 'Known defect (audit finding 3): a stranger who never joins is answered. The fix removes this mark.'
  },
  async () => {
    const room = await openRoom('diag-stranger')
    await join(room)
    const caller = await openCaller()

    await caller.call(room.peerId)
    await stays(
      async () => [await caller.answered(), await remoteVideos(room.page)],
      [0, 0]
    )
  }
)

test(
  'a stranger cannot end a call by joining and leaving as someone else',
  {
    todo: "Known defect (audit finding 4): a false join and leave with a real guest's id ends their call. The fix removes this mark."
  },
  async () => {
    const a = await openRoom('diag-impersonation')
    await join(a)
    const b = await openRoom('diag-impersonation')
    await join(b)
    await eventually(() => remoteVideos(a.page), 1)
    await eventually(() => remoteVideos(b.page), 1)

    // A stranger joins the room over socket.io claiming b's peer id, then
    // leaves by disconnecting
    const stranger = io(server.url)
    await new Promise<void>((resolve) =>
      stranger.on('connect', () => resolve())
    )
    stranger.emit('join-room', a.name, b.peerId)
    stranger.disconnect()

    await stays(
      async () => [await remoteVideos(a.page), await remoteVideos(b.page)],
      [1, 1],
      6_000
    )
  }
)
