import assert from 'node:assert/strict'
import { describe, test, before, after } from 'node:test'
import type { Browser, BrowserContext } from 'playwright'
import { launchBrowser, startServer, type Server } from './helpers.ts'

// REQ 13: attendee videos fit the page width without sideways scrolling.
// Two callers join a room at a 390px phone viewport while one sends a real
// 400px-wide camera stream (a test-only getUserMedia hook returns a canvas
// stream; audio requests still use Chrome's fake device). The witness for
// issue #180 showed the 400px-wide remote tile overflowing its container and
// the document widening to 395px on a 390px viewport.

let server: Server
let browser: Browser

before(async () => {
  ;[server, browser] = await Promise.all([startServer(), launchBrowser()])
})
after(async () => {
  await browser?.close()
  await server?.stop()
})

function fakeCameraHook() {
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (constraints && constraints.video) {
      const canvas = document.createElement('canvas')
      canvas.width = 400
      canvas.height = 300
      const ctx = canvas.getContext('2d')
      let n = 0
      setInterval(() => {
        if (!ctx) return
        ctx.fillStyle = n++ % 2 ? '#123456' : '#654321'
        ctx.fillRect(0, 0, 400, 300)
      }, 100)
      return canvas.captureStream(10)
    }
    return orig(constraints)
  }
}

async function joinRoom(context: BrowserContext, room: string) {
  const page = await context.newPage()
  await page.addInitScript(fakeCameraHook)
  await page.goto(`/room/${room}`)
  await page.getByRole('button', { name: 'Turn On Camera' }).click()
  await page.getByRole('button', { name: 'Join', exact: true }).click()
  return page
}

describe('Attendee video width (REQ 13)', () => {
  test('a 400px remote stream fits a 390px page without sideways scrolling', async () => {
    const room = 'video-width-test'
    const ctxA = await browser.newContext({
      baseURL: server.url,
      viewport: { width: 390, height: 700 }
    })
    const ctxB = await browser.newContext({
      baseURL: server.url,
      viewport: { width: 390, height: 700 }
    })
    ctxA.setDefaultTimeout(10_000)
    ctxB.setDefaultTimeout(10_000)
    try {
      await joinRoom(ctxA, room)
      const pageB = await joinRoom(ctxB, room)

      // Wait until page B renders a remote attendee tile whose stream is flowing at 400px
      await pageB.waitForFunction(() => {
        const videos = [...document.querySelectorAll('.attendee-grid video')]
        return videos.some(
          (video) => (video as HTMLVideoElement).videoWidth === 400
        )
      })
      await pageB.waitForTimeout(500)

      const measured = await pageB.evaluate(() => {
        const container = document.querySelector<HTMLElement>('.attendee-grid')
        const tile = [
          ...document.querySelectorAll<HTMLVideoElement>('.attendee-grid video')
        ].find((video) => video.videoWidth === 400)
        const presenter =
          document.querySelector<HTMLElement>('.presenter video')
        if (!container || !tile || !presenter) return null
        return {
          containerRect: container.getBoundingClientRect().toJSON(),
          tileRect: tile.getBoundingClientRect().toJSON(),
          presenterRect: presenter.getBoundingClientRect().toJSON(),
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          innerWidth: window.innerWidth
        }
      })
      assert.ok(
        measured,
        'expected a remote attendee tile and the presenter preview'
      )

      // The tile's actual rendered bounds fit inside its container and the viewport
      assert.ok(
        measured.tileRect.right <= measured.containerRect.right + 0.5,
        `tile right ${measured.tileRect.right} exceeds container right ${measured.containerRect.right}`
      )
      assert.ok(
        measured.tileRect.left >= measured.containerRect.left - 0.5,
        `tile left ${measured.tileRect.left} is outside container left ${measured.containerRect.left}`
      )
      assert.ok(
        measured.tileRect.right <= measured.innerWidth + 0.5,
        `tile right ${measured.tileRect.right} exceeds viewport width ${measured.innerWidth}`
      )

      // The page never grows wider than its viewport
      assert.ok(
        measured.scrollWidth <= measured.clientWidth,
        `document scrollWidth ${measured.scrollWidth} exceeds clientWidth ${measured.clientWidth}`
      )

      // The attendee-only limit does not shrink the presenter's fixed-size preview
      assert.equal(
        measured.presenterRect.width,
        160,
        'presenter preview must keep its 10rem fixed width'
      )
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
