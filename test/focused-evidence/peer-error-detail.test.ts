import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withBrowser } from './proposal-resources.ts'

for (const mode of ['500', 'abort']) {
  test(`failed ID request (${mode}) has one error and no retry`, async () => {
    await withBrowser(async (server, browser) => {
      const context = await browser.newContext({ baseURL: server.url })
      try {
        const page = await context.newPage()
        let idRequests = 0
        page.on('request', (request) => {
          if (new URL(request.url()).pathname === '/pinto/id')
            idRequests++
        })
        await page.route('**/pinto/id*', (route) =>
          mode === 'abort'
            ? route.abort()
            : route.fulfill({ status: 500, body: 'controlled failure' })
        )
        await page.goto('/room/id-error')
        await page.locator('#error:not([hidden])').waitFor()
        // Span the app's 5000ms reconnect delay, without authorizing retries.
        const started = Date.now()
        await new Promise((resolve) => setTimeout(resolve, 5500))
        const entries = await page.locator('#error > div').evaluateAll((nodes) =>
          nodes.map((node) => ({
            heading: node.querySelector('h1')?.textContent,
            detail: node.querySelector('h2')?.textContent
          }))
        )
        const evidence = {
          mode,
          observationMs: Date.now() - started,
          idRequests,
          entries,
          joinDisabled: await page.locator('#call').isDisabled()
        }
        console.log(JSON.stringify({ peerFailureEvidence: evidence }))
        assert.equal(entries.length, 1, 'single error entry')
        assert.equal(entries[0].heading, 'Connection problem')
        assert.equal(
          entries[0].detail,
          'server-error: No further error details are available.'
        )
        assert.equal(idRequests, 1, 'one initial ID request and no retry')
        assert.equal(evidence.joinDisabled, true)
      } finally {
        await context.close()
      }
    })
  })
}

test('nonempty peer error detail is preserved exactly', async () => {
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
