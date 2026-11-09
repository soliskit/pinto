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

test('HTTP error config is rejected even when its JSON looks valid', async () => {
  await withBrowser(async (server, browser) => {
    const context = await browser.newContext({ baseURL: server.url })
    try {
      const page = await context.newPage()
      await page.route('**/config', (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"key":"pinto","iceServers":[]}'
        })
      )
      await page.goto('/room/config-error')
      await page.locator('#page-error').waitFor()
      assert.match(
        (await page.locator('#page-error').textContent()) || '',
        /Connection settings could not be loaded \(500\)/
      )
      assert.equal(await page.locator('#mute').isDisabled(), true)
      assert.equal(await page.locator('#call').isDisabled(), true)
    } finally {
      await context.close()
    }
  })
})

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
