import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withBrowser } from './proposal-resources.ts'

void test('failed ID request shows honest nonempty error detail', async () => {
  await withBrowser(async (server, browser) => {
    for (const mode of ['500', 'abort']) {
      const context = await browser.newContext({ baseURL: server.url })
      try {
        const page = await context.newPage()
        await page.route('**/peerjs/id*', (route) =>
          mode === 'abort'
            ? route.abort()
            : route.fulfill({ status: 500, body: 'controlled failure' })
        )
        await page.goto('/room/id-error')
        await page.locator('#error:not([hidden])').waitFor()
        assert.match(
          (await page.locator('#error').textContent()) || '',
          /server-error: No further error details are available\./
        )
        assert.equal(await page.locator('#call').isDisabled(), true)
      } finally {
        await context.close()
      }
    }
  })
})

void test('nonempty peer error detail is preserved exactly', async () => {
  await withBrowser(async (server, browser) => {
    const context = await browser.newContext({ baseURL: server.url })
    try {
      const page = await context.newPage()
      // Synthetic error delivery is explicit: preserves real constructor,
      // only retains the exact created instance for a handler control.
      await page.route('**/vendor/peerjs.min.js', async (route) => {
        const response = await route.fetch()
        const body = await response.text()
        await route.fulfill({
          response,
          body:
            body +
            `\n{ const OriginalPeer = window.Peer; window.Peer = class extends OriginalPeer { constructor(...args) { super(...args); window.proposalPeer = this; } }; }`
        })
      })
      await page.goto('/room/detail-control')
      await page.locator('#call:enabled').waitFor()
      await page.evaluate(
        "window.proposalPeer.emit('error', { type: 'server-error', message: 'Controlled detailed reason' })"
      )
      const entry = page.locator('#error > div').filter({
        has: page.getByRole('heading', {
          name: 'Connection problem',
          exact: true
        })
      })
      assert.equal(
        await entry.locator('h2').textContent(),
        'server-error: Controlled detailed reason'
      )
    } finally {
      await context.close()
    }
  })
})
