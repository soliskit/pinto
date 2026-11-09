import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withBrowser } from './proposal-resources.ts'

const widths = [320, 360, 390, 414, 600, 767, 768, 1280]
const photoPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4RBCAwBRcwH+conGc8AAAAASUVORK5CYII=',
  'base64'
)

test('real photo controls retain minimum height and layout', async () => {
  const failures: string[] = []
  await withBrowser(async (server, browser) => {
    for (const width of widths) {
      const height = width === 320 ? 568 : width === 390 ? 844 : 800
      const context = await browser.newContext({
        baseURL: server.url,
        viewport: { width, height }
      })
      try {
        const page = await context.newPage()
        // Observe successful real image drawing without replacing app handlers.
        await page.addInitScript(`
          window.proposalPhotoDraws = [];
          const original = CanvasRenderingContext2D.prototype.drawImage;
          CanvasRenderingContext2D.prototype.drawImage = function (...args) {
            const result = original.apply(this, args);
            const image = args[0];
            if (image instanceof HTMLImageElement && image.src.startsWith('blob:')) {
              window.proposalPhotoDraws.push({
                src: image.src, complete: image.complete,
                width: image.naturalWidth, height: image.naturalHeight,
                canvasWidth: this.canvas.width, canvasHeight: this.canvas.height
              });
            }
            return result;
          };
        `)
        // Real room initialization and file input, no chooser or live call.
        await page.goto('/room/target-layout')
        await page.locator('#call:enabled').waitFor()
        for (const state of ['no-photo', 'with-photo']) {
          if (state === 'with-photo') {
            await page.locator('#photo').setInputFiles({
              name: 'controlled-photo.png',
              mimeType: 'image/png',
              buffer: photoPng
            })
            await page.locator('#remove-photo:visible').waitFor()
            await page.waitForFunction(`window.proposalPhotoDraws.some(
              (draw) => draw.complete && draw.width === 2 && draw.height === 2
                && draw.canvasWidth > 0 && draw.canvasHeight > 0
            )`)
            console.log(JSON.stringify({ width, photoDraws:
              await page.evaluate('window.proposalPhotoDraws') }))
          }
          const evidence = await page.evaluate(() => {
            const rect = (node: Element) =>
              node.getBoundingClientRect().toJSON()
            return {
              controls: [...document.querySelectorAll('.controls button')]
                .filter((node) => !(node as HTMLButtonElement).hidden)
                .map((node) => ({ id: node.id, rect: rect(node) })),
              title: rect(document.querySelector('#title')!),
              status: rect(document.querySelector('#status')!),
              self: rect(document.querySelector('#self')!)
            }
          })
          console.log(JSON.stringify({ width, height, state, evidence }))
          await page.screenshot({
            path: `target-${width}-${state}.png`,
            fullPage: true
          })
          const expected = state === 'with-photo'
            ? ['mute', 'camera', 'remove-photo', 'call']
            : ['mute', 'camera', 'call']
          if (JSON.stringify(evidence.controls.map((x) => x.id).sort()) !==
              JSON.stringify(expected.sort()))
            failures.push(`inventory:${width}/${state}`)
          for (const { id, rect } of evidence.controls) {
            if (rect.height < 44)
              failures.push(`height-rule:${width}/${state}/${id}:${rect.height}`)
            if (rect.width < 44)
              failures.push(`width-control:${width}/${state}/${id}:${rect.width}`)
            if (rect.left < 0 || rect.right > width ||
                rect.top < 0 || rect.bottom > height)
              failures.push(`offscreen:${width}/${state}/${id}`)
            for (const [name, heading] of [
              ['title', evidence.title], ['status', evidence.status]
            ] as const) {
              if (rect.left < heading.right && rect.right > heading.left &&
                  rect.top < heading.bottom && rect.bottom > heading.top)
                failures.push(`overlap:${width}/${state}/${id}/${name}`)
            }
          }
        }
        await page.goto('/')
        const open = await page.locator('.open-room').boundingBox()
        console.log(JSON.stringify({ width, height, state: 'lobby', open }))
        await page.screenshot({ path: `target-${width}-lobby.png`, fullPage: true })
        if (!open) failures.push(`missing-lobby:${width}`)
        else {
          if (open.height < 44) failures.push(`height-rule:lobby/${width}`)
          if (open.width < 44) failures.push(`width-control:lobby/${width}`)
          if (open.x < 0 || open.x + open.width > width ||
              open.y < 0 || open.y + open.height > height)
            failures.push(`offscreen:lobby/${width}`)
        }
      } finally {
        await context.close()
      }
    }
    // Retain all baseline states before surfacing the actual violated rules.
    assert.equal(failures.length, 0, failures.join('\n'))
  })
})
