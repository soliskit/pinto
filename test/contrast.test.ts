import assert from 'node:assert/strict'
import { after, afterEach, before, describe, test } from 'node:test'
import type { Browser, BrowserContext, Page } from 'playwright'
import { launchBrowser, startServer, type Server } from './helpers.ts'

let server: Server
let browser: Browser
let context: BrowserContext

before(async () => {
  ;[server, browser] = await Promise.all([startServer(), launchBrowser()])
})
after(async () => {
  await browser?.close()
  await server?.stop()
})
afterEach(() => context?.close())

async function open(path: string): Promise<Page> {
  context = await browser.newContext({ baseURL: server.url })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  await page.goto(path)
  return page
}

/** Parses a computed `rgb(r, g, b)` or `rgba(r, g, b, a)` color */
function rgb(color: string): [number, number, number] {
  const parts = color.match(/[\d.]+/g)?.map(Number)
  assert.ok(parts && parts.length >= 3, `not an rgb color: ${color}`)
  return [parts[0], parts[1], parts[2]]
}

/** WCAG 2.2 relative luminance of an sRGB color */
function luminance([r, g, b]: [number, number, number]): number {
  const linear = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** WCAG 2.2 contrast ratio between two colors */
function contrast(foreground: string, background: string): number {
  const l1 = luminance(rgb(foreground))
  const l2 = luminance(rgb(background))
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (lighter + 0.05) / (darker + 0.05)
}

// Page text meets WCAG 2.2 AA: 4.5:1 for normal text (owner decision,
// October 20, 2026; docs/requirements.md REQ 12)
describe('contrast', () => {
  test('room-name placeholder against its input background', async () => {
    const page = await open('/')
    const [foreground, background] = await page.evaluate(() => [
      getComputedStyle(document.querySelector('input')!, '::placeholder').color,
      getComputedStyle(document.querySelector('input')!).backgroundColor
    ])
    assert.ok(
      contrast(foreground, background) >= 4.5,
      `placeholder ${foreground} on ${background}: ${contrast(foreground, background).toFixed(2)}:1, below 4.5:1`
    )
  })

  test('Mute text against its button background', async () => {
    const page = await open('/room/test')
    const [foreground, background] = await page.evaluate(() => [
      getComputedStyle(document.querySelector('.mute')!).color,
      getComputedStyle(document.querySelector('.mute')!).backgroundColor
    ])
    assert.ok(
      contrast(foreground, background) >= 4.5,
      `Mute ${foreground} on ${background}: ${contrast(foreground, background).toFixed(2)}:1, below 4.5:1`
    )
  })
})
