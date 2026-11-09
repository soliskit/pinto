import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, test } from 'node:test'
import type { Browser, BrowserContext, Page } from 'playwright'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { launchBrowser, startServer, type Server } from './helpers.ts'

// REQ 14: the photo picker works by keyboard alone. Tab reaches the picker,
// a focus ring shows on the preview, and the platform's native activation
// keys open the file chooser. Before this change the input had the hidden
// attribute and was unreachable by keyboard.

let server: Server
let browser: Browser

before(async () => {
  ;[server, browser] = await Promise.all([startServer(), launchBrowser()])
})
after(async () => {
  await browser?.close()
  await server?.stop()
})

async function openRoom(context: BrowserContext, room: string) {
  const page = await context.newPage()
  await page.goto(`/room/${room}`)
  await page.locator('#call:enabled').waitFor()
  return page
}

/** Tabs from the page start, returning the focused element ids in order */
async function tabTrail(page: Page, presses: number) {
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  const trail: (string | null)[] = []
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('Tab')
    trail.push(await page.evaluate(() => document.activeElement?.id ?? null))
  }
  return trail
}

async function newContext(width: number, height: number) {
  const context = await browser.newContext({
    baseURL: server.url,
    viewport: { width, height }
  })
  context.setDefaultTimeout(10_000)
  // WebKit has no fake-media flags; its mock capture stream is gated on
  // granted camera/microphone permissions
  if (process.env.PINTO_BROWSER === 'webkit') {
    await context.grantPermissions(['camera', 'microphone'])
  }
  return context
}

describe('Photo picker keyboard operation (REQ 14)', () => {
  test('Tab reaches the picker and shows the ring on the preview', async () => {
    const context = await newContext(1280, 800)
    try {
      const page = await openRoom(context, 'keyboard-tab')

      // DOM order: Mute, Turn On Camera, Join, then the picker input
      assert.deepEqual(await tabTrail(page, 4), [
        'mute',
        'camera',
        'call',
        'photo'
      ])

      // The ring on the preview: warm white, 3px, 2px out, rounded corners
      const ring = await page.evaluate(() => {
        const style = getComputedStyle(document.getElementById('self-label')!)
        return {
          style: style.outlineStyle,
          width: style.outlineWidth,
          color: style.outlineColor,
          offset: style.outlineOffset,
          radius: style.borderRadius
        }
      })
      assert.deepEqual(ring, {
        style: 'solid',
        width: '3px',
        color: 'rgb(254, 252, 232)',
        offset: '2px',
        radius: '8px'
      })
    } finally {
      await context.close()
    }
  })

  test('the native activation keys open the file chooser', async () => {
    const context = await newContext(1280, 800)
    try {
      const page = await openRoom(context, 'keyboard-keys')
      await tabTrail(page, 4)
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        'photo'
      )
      // One press per key: a key that does not open the chooser fails the
      // test, whatever the cause. Unrolled so each press has its own line:
      // Enter first, then Space, in this same context
      const [enterChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.keyboard.press('Enter')
      ])
      assert.ok(enterChooser)
      const [spaceChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.keyboard.press('Space')
      ])
      assert.ok(spaceChooser)
    } finally {
      await context.close()
    }
  })

  test('clicking the preview still opens the chooser', async () => {
    const context = await newContext(1280, 800)
    try {
      const page = await openRoom(context, 'keyboard-pointer')
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.click('#self-label')
      ])
      assert.ok(chooser)
    } finally {
      await context.close()
    }
  })

  test('the picker has the accessible name Choose photo', async () => {
    const context = await newContext(1280, 800)
    try {
      const page = await openRoom(context, 'keyboard-name')
      const input = page.getByLabel('Choose photo')
      assert.equal(await input.getAttribute('id'), 'photo')
    } finally {
      await context.close()
    }
  })

  test('with the camera on, the picker stays disabled for keyboard too', async () => {
    const context = await newContext(1280, 800)
    try {
      const page = await openRoom(context, 'keyboard-camera')
      await page.click('#camera')
      assert.equal(await page.locator('#photo').isDisabled(), true)

      // Tab passes the disabled picker by
      const trail = await tabTrail(page, 8)
      assert.ok(!trail.includes('photo'))

      // The preview does not open a chooser, exactly as for pointer users.
      // A raw mouse click: Playwright's click refuses the label while its
      // control is disabled, which is the state under test
      let opened = false
      page.once('filechooser', () => {
        opened = true
      })
      const label = await page.locator('#self-label').boundingBox()
      await page.mouse.click(
        label!.x + label!.width / 2,
        label!.y + label!.height / 2
      )
      await sleep(1_000)
      assert.equal(opened, false)
    } finally {
      await context.close()
    }
  })

  test('the picker stays invisible at 390px', async () => {
    const context = await newContext(390, 700)
    try {
      const page = await openRoom(context, 'keyboard-mobile')

      // Visually hidden: a clipped 1px box, not a layout shift
      const box = await page.locator('#photo').boundingBox()
      assert.ok(box && box.width <= 1 && box.height <= 1)
    } finally {
      await context.close()
    }
  })

  test('the page does not widen at 390px', async () => {
    const context = await newContext(390, 700)
    try {
      const page = await openRoom(context, 'keyboard-mobile')
      const scrollWidth = await page.evaluate(
        () => document.documentElement.scrollWidth
      )
      assert.ok(scrollWidth <= 390, `page widened to ${scrollWidth}px`)
    } finally {
      await context.close()
    }
  })

  test('the ring appears on keyboard focus at 390px', async () => {
    const context = await newContext(390, 700)
    try {
      const page = await openRoom(context, 'keyboard-mobile')
      await tabTrail(page, 4)
      const outline = await page.evaluate(
        () => getComputedStyle(document.getElementById('self-label')!).outline
      )
      assert.equal(outline, 'rgb(254, 252, 232) solid 3px')
    } finally {
      await context.close()
    }
  })

  test('the keyboard fix does not shift the layout at 390px', async () => {
    // Baseline: the room and stylesheet bytes from before this fix, pinned
    // as fixtures. Routes keep the server's status and headers and replace
    // only the body, so the comparison is pre-change vs patched bytes in
    // the same engine and viewport.
    const fixture = (name: string) =>
      fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
    const boxes = async (page: Page) => {
      const [label, video] = await Promise.all([
        page.locator('#self-label').boundingBox(),
        page.locator('#self').boundingBox()
      ])
      assert.ok(label, 'preview label has no layout box')
      assert.ok(video, 'preview video has no layout box')
      return { label, video }
    }
    const baselineContext = await newContext(390, 700)
    try {
      let cssHits = 0
      await baselineContext.route('**/room/**', async (route) => {
        if (!route.request().isNavigationRequest()) {
          return route.continue()
        }
        await route.fulfill({
          response: await route.fetch(),
          path: fixture('pre-change-room.html')
        })
      })
      await baselineContext.route('**/style.css', async (route) => {
        cssHits++
        await route.fulfill({
          response: await route.fetch(),
          path: fixture('pre-change-style.css'),
          contentType: 'text/css'
        })
      })
      const baseline = await openRoom(baselineContext, 'keyboard-mobile')
      // The baseline must really be the pinned pre-change bytes: the served
      // stylesheet is byte-identical to the fixture, and the rendered
      // document carries the pre-change hidden input.
      assert.ok(cssHits > 0, 'the stylesheet was never requested')
      const servedCss = await baseline.evaluate(() =>
        fetch('/style.css').then((response) => response.text())
      )
      assert.equal(
        servedCss,
        await readFile(fixture('pre-change-style.css'), 'utf8')
      )
      assert.equal(await baseline.locator('#photo[hidden]').count(), 1)
      const before = await boxes(baseline)

      const patchedContext = await newContext(390, 700)
      try {
        const patched = await openRoom(patchedContext, 'keyboard-mobile')
        const after = await boxes(patched)
        assert.deepEqual(after, before)
      } finally {
        await patchedContext.close()
      }
    } finally {
      await baselineContext.close()
    }
  })
})
