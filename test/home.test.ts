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

/** Opens the home page, in UTC, with the clock stopped at `time` if given */
async function openHome(time?: Date) {
  context = await browser.newContext({ baseURL: server.url, timezoneId: 'UTC' })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  if (time) {
    // Let the page load with time flowing, as Playwright recommends
    await page.clock.install({ time: time.getTime() - 60_000 })
  }
  await page.goto('/')
  if (time) await page.clock.pauseAt(time)
  return page
}

const clockText = (page: Page) => page.textContent('#clock')

/** The clock's text, with the no break spaces it uses between parts */
const clock = (time: string, date: string) =>
  `${time}\u00a0 • \u00a0${date.replace(' ', ', \u00a0')}`

describe('clock', () => {
  test('shows the time, weekday and date', async () => {
    const page = await openHome(new Date('2026-09-27T10:15:00Z'))
    assert.equal(await clockText(page), clock('10:15 AM', 'Sun Sept 27'))
    assert.equal(
      await page.getAttribute('#clock', 'datetime'),
      '2026-09-27T10:15:00.000Z'
    )
  })

  test('uses 12 hour time and every weekday', async () => {
    const page = await openHome(new Date('2026-09-27T10:15:00Z'))
    const cases: [string, string, string][] = [
      ['2026-09-27T00:05:00Z', '12:05 AM', 'Sun Sept 27'],
      ['2026-09-28T09:07:00Z', '9:07 AM', 'Mon Sept 28'],
      ['2026-09-29T12:00:00Z', '12:00 PM', 'Tues Sept 29'],
      ['2026-09-30T13:30:00Z', '1:30 PM', 'Weds Sept 30'],
      ['2026-10-01T23:59:00Z', '11:59 PM', 'Thur Oct 1'],
      ['2026-01-02T11:59:00Z', '11:59 AM', 'Fri Jan 2'],
      ['2026-05-02T18:45:00Z', '6:45 PM', 'Sat May 2']
    ]
    for (const [iso, time, date] of cases) {
      await page.clock.setSystemTime(new Date(iso))
      await page.clock.runFor(1000)
      assert.equal(await clockText(page), clock(time, date), iso)
    }
  })

  test('updates every second', async () => {
    const page = await openHome(new Date('2026-09-27T10:15:59Z'))
    assert.equal(await clockText(page), clock('10:15 AM', 'Sun Sept 27'))
    await page.clock.runFor(1000)
    assert.equal(await clockText(page), clock('10:16 AM', 'Sun Sept 27'))
  })
})

describe('room name form', () => {
  /** Submits `name` and returns the path of the room it opens */
  async function open(page: Page, name: string, submit: 'click' | 'enter') {
    await page.fill('#room-name', name)
    if (submit === 'click') await page.click('button[type=submit]')
    else await page.press('#room-name', 'Enter')
    await page.waitForURL('**/room/**')
    return new URL(page.url()).pathname
  }

  test('Open goes to the typed room, trimmed and in lower case', async () => {
    const page = await openHome()
    assert.equal(await open(page, '  Standup ', 'click'), '/room/standup')
  })

  test('Enter also opens the room', async () => {
    const page = await openHome()
    assert.equal(await open(page, 'standup', 'enter'), '/room/standup')
  })

  test('encodes the room name, and the room page decodes it', async () => {
    const page = await openHome()
    const path = await open(page, 'Team #1/Ü', 'click')
    assert.equal(path, '/room/team%20%231%2F%C3%BC')
    await page.locator('#title', { hasText: 'Join room' }).waitFor()
    assert.equal(await page.textContent('#title'), 'Join room: team #1/ü')
  })

  test('makes up a room name when none is typed', async () => {
    for (const [random, name] of [
      [0, 'autumn-bird'],
      [0.999, 'wild-wave']
    ] as const) {
      const page = await openHome()
      await page.evaluate((random) => (Math.random = () => random), random)
      assert.equal(await open(page, '   ', 'click'), `/room/${name}`)
      await context.close()
    }
  })

  test('makes up a different room name each time', async () => {
    const names = new Set<string>()
    const page = await openHome()
    for (let i = 0; i < 5; i++) {
      names.add(await open(page, '', 'click'))
      await page.goto('/')
    }
    assert.ok(names.size > 1, `always ${[...names]}`)
  })
})
