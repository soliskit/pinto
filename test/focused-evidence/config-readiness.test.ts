import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withBrowser } from './proposal-resources.ts'

test('pending config disables Mute until its handler is installed', async () => {
  await withBrowser(async (server, browser) => {
    const context = await browser.newContext({ baseURL: server.url })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrived!: () => void
    const requested = new Promise<void>((resolve) => {
      arrived = resolve
    })
    try {
      const page = await context.newPage()
      await page.route('**/config', async (route) => {
        arrived()
        await gate
        await route.continue()
      })
      await page.goto('/room/config-readiness', {
        waitUntil: 'domcontentloaded'
      })
      await requested
      assert.equal(await page.locator('#mute').isDisabled(), true)
      assert.equal(await page.locator('#camera').isDisabled(), true)
      assert.equal(await page.locator('#call').isDisabled(), true)
      const before = await page.locator('#mute').textContent()
      await page
        .locator('#mute')
        .evaluate((el) => (el as HTMLButtonElement).click())
      assert.equal(await page.locator('#mute').textContent(), before)
      release()
      await page.locator('#call:enabled').waitFor()
      await page.locator('#mute').click()
      assert.equal(await page.locator('#mute').textContent(), 'Unmute')
    } finally {
      release()
      await context.close()
    }
  })
})

for (const format of ['json', 'html']) {
  test(`HTTP 500 ${format} config is rejected before initialization`, async () => {
    await withBrowser(async (server, browser) => {
      const context = await browser.newContext({ baseURL: server.url })
      try {
        const page = await context.newPage()
        let undefinedIdRequests = 0
        page.on('request', (request) => {
          if (new URL(request.url()).pathname.includes('/undefined/id'))
            undefinedIdRequests++
        })
        await page.route('**/config', (route) =>
          route.fulfill({
            status: 500,
            contentType: format === 'json' ? 'application/json' : 'text/html',
            body: format === 'json'
              ? '{"iceServers":[]}'
              : '<!doctype html><title>Controlled error</title><p>Unavailable</p>'
          })
        )
        await page.goto('/room/config-error')
        // Observe an actual terminal initialization signal on either arm.
        await page.waitForFunction(() =>
          document.querySelector('#page-error') ||
          document.querySelector('#error:not([hidden])') ||
          document.querySelector('#call:not([disabled])')
        )
        const evidence = {
          format,
          message: await page.locator('#page-error').count()
            ? await page.locator('#page-error').textContent()
            : null,
          muteDisabled: await page.locator('#mute').isDisabled(),
          joinDisabled: await page.locator('#call').isDisabled(),
          undefinedIdRequests
        }
        console.log(JSON.stringify({ configFailureEvidence: evidence }))
        assert.match(
          evidence.message || '',
          /Connection settings could not be loaded \(500\)/
        )
        assert.equal(evidence.muteDisabled, true)
        assert.equal(evidence.joinDisabled, true)
        assert.equal(undefinedIdRequests, 0, 'no keyless peer ID request')
      } finally {
        await context.close()
      }
    })
  })
}

test('aborted and unreadable config retains existing visible failure reporting', async () => {
  await withBrowser(async (server, browser) => {
    for (const mode of ['abort', 'invalid-json', '500-text']) {
      const context = await browser.newContext({ baseURL: server.url })
      try {
        const page = await context.newPage()
        await page.route('**/config', (route) =>
          mode === 'abort'
            ? route.abort()
            : route.fulfill({
                status: mode === '500-text' ? 500 : 200,
                contentType: 'text/plain',
                body: 'not JSON'
              })
        )
        await page.goto('/room/config-nonregression')
        await page.locator('#page-error').waitFor()
        assert.ok(
          ((await page.locator('#page-error').textContent()) || '').length > 10
        )
        assert.equal(await page.locator('#mute').isDisabled(), true)
        assert.equal(await page.locator('#call').isDisabled(), true)
      } finally {
        await context.close()
      }
    }
  })
})
