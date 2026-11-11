import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withBrowser } from './proposal-resources.ts'

void test('selected44px targets retain narrow and large layouts', async () => {
  await withBrowser(async (server, browser) => {
    for (const width of [320, 390, 414, 568, 768, 1280]) {
      const height = width === 320 ? 568 : width === 390 ? 844 : 800
      const context = await browser.newContext({
        baseURL: server.url,
        viewport: { width, height }
      })
      try {
        const page = await context.newPage()
        // Layout only: no PeerJS/media initialization or chooser execution.
        await page.route('**/room.js', (route) =>
          route.fulfill({ contentType: 'text/javascript', body: '' })
        )
        await page.goto('/room/target-layout')
        for (const state of ['join-no-photo', 'leave-with-photo']) {
          await page.locator('#remove-photo').evaluate((el, show) => {
            ;(el as HTMLButtonElement).hidden = !show
          }, state === 'leave-with-photo')
          await page.locator('#call').evaluate((el, leave) => {
            el.textContent = leave ? 'Leave' : 'Join'
            el.classList.toggle('end', leave)
          }, state === 'leave-with-photo')
          const evidence = (await page
            .locator('.controls button:visible')
            .evaluateAll((buttons) =>
              buttons.map((el) => ({
                id: el.id,
                rect: el.getBoundingClientRect().toJSON() as DOMRect
              }))
            )) as { id: string; rect: DOMRect }[]
          console.log(JSON.stringify({ width, height, state, evidence }))
          // Capture before assertions so an intended baseline failure has pixels.
          await page.screenshot({
            path: `target-${String(width)}-${state}.png`,
            fullPage: true
          })
          const expectedIds =
            state === 'leave-with-photo'
              ? ['mute', 'camera', 'remove-photo', 'call']
              : ['mute', 'camera', 'call']
          assert.deepEqual(
            evidence.map(({ id }) => id).sort(),
            expectedIds.sort()
          )
          for (const { id, rect } of evidence) {
            assert.ok(
              rect.height >= 44,
              `height-rule:${String(width)}/${state}/${id}: ${JSON.stringify(rect)}`
            )
            assert.ok(
              rect.width >= 44,
              `width-control:${String(width)}/${state}/${id}: ${JSON.stringify(rect)}`
            )
            assert.ok(
              rect.left >= 0 &&
                rect.right <= width &&
                rect.top >= 0 &&
                rect.bottom <= height,
              `${String(width)}/${state}/${id}: offscreen`
            )
          }
        }
        await page.goto('/')
        await page.screenshot({
          path: `target-${String(width)}-lobby.png`,
          fullPage: true
        })
        const open = await page.locator('.open-room').boundingBox()
        assert.ok(open, 'lobby target exists')
        assert.ok(
          open.height >= 44,
          `height-rule:lobby/${String(width)}: ${JSON.stringify(open)}`
        )
        assert.ok(
          open.width >= 44,
          `width-control:lobby/${String(width)}: ${JSON.stringify(open)}`
        )
      } finally {
        await context.close()
      }
    }
  })
})
