import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { io } from 'socket.io-client'
import { type Page } from 'playwright'
import {
  eventually,
  launchBrowser,
  startServer,
  type Server
} from './helpers.ts'

// Edge cases for the /config timings code in room.js. The suite's other
// tests always see either valid shortened timings or none, so the guard
// branches need payloads of their own, served by intercepting the page's
// /config request - no server support for a bad payload is needed.

// Holds a room with the page's own id so every join attempt is refused
// and the page's retry cadence can be observed. Teardown is registered
// the moment each resource exists, so a failure anywhere cannot leak one.
async function occupyRoom(
  t: TestContext,
  server: Server,
  page: Page
): Promise<void> {
  const squatter = io(server.url, {
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
  const idResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/peerjs/id'
  )
  await page.goto('/room/taken')
  const peerId = await (await idResponse).text()
  await page.locator('#call:enabled').waitFor()
  squatter.emit('join-room', 'taken', peerId)
  await server.waitForOutput(`user: ${peerId} - joined: taken`)
}

void test('valid timings drive the shortened join retry cadence', async (t) => {
  // Teardown is registered the moment each resource exists, so a
  // failure anywhere cannot leak one
  const server = await startServer()
  t.after(async () => {
    await server.stop()
  })
  const browser = await launchBrowser()
  t.after(() => browser.close())
  const context = await browser.newContext({ baseURL: server.url })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  await occupyRoom(t, server, page)

  await page.click('#call')
  // The shortened 200ms retry cadence gives up in about a second; the
  // production 2s cadence would keep the button off Join for about
  // eight. The 5s ceiling sits between the two.
  await eventually(
    async () => (await page.locator('#call').textContent()) === 'Join',
    true,
    5_000
  )
})

// Asserts that a page served a bogus joinRetryMs keeps the production
// 2-second retry cadence: at 1.5s it is still inside its first retry gap,
// where a page that accepted the value would already have given up
async function assertProductionJoinCadence(
  t: TestContext,
  joinRetryMs: unknown
): Promise<void> {
  const server = await startServer()
  t.after(async () => {
    await server.stop()
  })
  const browser = await launchBrowser()
  t.after(() => browser.close())
  const context = await browser.newContext({ baseURL: server.url })
  context.setDefaultTimeout(10_000)
  await context.route('**/config', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        iceServers: [],
        timings: { joinRetryMs, reconnectDelayMs: 500, requestTimeoutMs: 500 }
      })
    })
  })
  const page = await context.newPage()
  await occupyRoom(t, server, page)

  await page.click('#call')
  await sleep(1_500)
  assert.notEqual(await page.locator('#call').textContent(), 'Join')
}

void test('a negative timing value falls back to the production cadence', async (t) => {
  await assertProductionJoinCadence(t, -1)
})

void test('a non-number timing value falls back to the production cadence', async (t) => {
  await assertProductionJoinCadence(t, '200')
})

void test('malformed config payloads fall back to production timings', async (t) => {
  const server = await startServer()
  t.after(async () => {
    await server.stop()
  })
  const browser = await launchBrowser()
  t.after(() => browser.close())
  const context = await browser.newContext({ baseURL: server.url })
  context.setDefaultTimeout(10_000)
  // Configs the guards must fall back on, not throw: no object at all,
  // and timings that are not an object or are null. A null whole config is
  // out of scope: the page reads its iceServers later either way.
  for (const body of [
    JSON.stringify('nope'),
    JSON.stringify({ timings: 'nope' }),
    JSON.stringify({ timings: null })
  ]) {
    const page = await context.newPage()
    const pageErrors: Error[] = []
    page.on('pageerror', (error) => pageErrors.push(error))
    await page.route('**/config', async (route) => {
      await route.fulfill({ contentType: 'application/json', body })
    })
    await page.goto('/room/plain')
    await page.locator('#call:enabled').waitFor()
    assert.deepEqual(pageErrors, [])
    await page.close()
  }
})

void test('a failed config response surfaces as an error', async (t) => {
  const server = await startServer()
  t.after(async () => {
    await server.stop()
  })
  const browser = await launchBrowser()
  t.after(() => browser.close())
  const context = await browser.newContext({ baseURL: server.url })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  const pageErrors: Error[] = []
  page.on('pageerror', (error) => pageErrors.push(error))
  // The body stays valid JSON, so only the status check can fail
  await page.route('**/config', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ iceServers: [], timings: {} })
    })
  })
  await page.goto('/room/plain')
  await eventually(async () => await Promise.resolve(pageErrors.length), 1)
  assert.match(
    pageErrors[0].message,
    /Connection settings could not be loaded \(500\)\./
  )
})
