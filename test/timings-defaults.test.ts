import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { io } from 'socket.io-client'
import { eventually, launchBrowser, startServer } from './helpers.ts'

// The suite runs against server-shortened timings (test/helpers.ts). This
// check holds the production cadence to account: a refused Join keeps
// retrying on the real 2-second timer when no timings are served.
void test('a refused Join retries on the real default cadence', async (t) => {
  // Teardown is registered the moment each resource exists, so a
  // failure anywhere cannot leak one
  const server = await startServer({ PINTO_TEST_TIMINGS: '' })
  t.after(async () => {
    await server.stop()
  })
  // The socket connects on construction, so its listeners are registered
  // immediately - attaching them later could miss the event and hang -
  // and the connection is awaited before anything else, so an early
  // connect_error is never an unhandled rejection
  const squatter = io(server.url, {
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
  const browser = await launchBrowser()
  t.after(() => browser.close())
  const context = await browser.newContext({ baseURL: server.url })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  const idResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/peerjs/id'
  )
  await page.goto('/room/taken')
  const peerId = await (await idResponse).text()
  await page.locator('#call:enabled').waitFor()

  // Someone already in the room holds the page's id, so each join
  // attempt is refused and the page retries until it gives up
  squatter.emit('join-room', 'taken', peerId)
  await server.waitForOutput(`user: ${peerId} - joined: taken`)

  await page.click('#call')
  // The production retry gap is 2 seconds from source (room.js's 2_000
  // fallback, four gaps between five attempts); the shortened 200ms
  // cadence would give up in about a second. This test observes only
  // the two ends: still trying at 1.5s,
  await sleep(1_500)
  assert.notEqual(await page.locator('#call').textContent(), 'Join')
  // and back to Join after exhaustion, inside a 20s ceiling. The
  // ceiling is a bound, not evidence of the 2s value.
  await eventually(
    async () => (await page.locator('#call').textContent()) === 'Join',
    true,
    20_000
  )
  // The page itself never got in: only the squatter's join is logged
  assert.equal(
    server.output().match(new RegExp(`user: ${peerId} - joined: taken`, 'g'))
      ?.length,
    1
  )
})
