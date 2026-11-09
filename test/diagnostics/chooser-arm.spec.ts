// D1 (non-certifying diagnostic): one Enter under an awaited,
// renderer-acked interception arm on a dedicated CDP session.
// Asserts nothing about REQ 14; changes no existing test. Chromium only.
// Runs once per explicit approval only. Never in a suite.
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, test } from 'node:test'
import type { Browser } from 'playwright'
import { launchBrowser, startServer, type Server } from '../helpers.ts'

let server: Server
let browser: Browser

/**
 * Writes one bounded diagnostic line. A write failure never
 * propagates, so logging can never mask the result it reports.
 */
function safeLog(line: string, fields: Record<string, string>): void {
  try {
    console.log(line, fields)
  } catch {
    // Swallowed on purpose: logging never masks the original result.
  }
}

/**
 * Bounds the WAIT for `work` to `ms` and rejects with a labeled error on
 * timeout. The work itself is not cancelled: it may still settle after
 * the wait has been abandoned.
 */
async function bounded<T>(
  label: string,
  work: Promise<T>,
  ms = 10_000
): Promise<T> {
  const timer = new AbortController()
  try {
    return await Promise.race([
      work,
      sleep(ms, undefined, { signal: timer.signal }).then(() => {
        throw new Error(`bounded wait exceeded ${ms}ms: ${label}`)
      })
    ])
  } catch (error) {
    if (timer.signal.aborted) {
      throw new Error(`bounded wait exceeded ${ms}ms: ${label}`)
    }
    throw error
  } finally {
    timer.abort()
  }
}

before(async () => {
  // Owned resources are acquired one at a time: if the browser launch
  // fails after the server started, the server is stopped before the
  // error propagates instead of being orphaned.
  server = await startServer()
  try {
    browser = await launchBrowser()
  } catch (error) {
    try {
      await bounded('server stop in setup', server.stop(), 30_000)
    } catch {
      safeLog('D1 cleanup failed', { step: 'server stop in setup' })
    }
    throw error
  }
})

after(async () => {
  // Independent owned cleanup: each resource is stopped even when the
  // other stop fails, each stop is bounded, and a stop failure is its
  // own bounded line - it never masks the test's original result.
  if (browser) {
    try {
      await bounded('browser close', browser.close(), 30_000)
    } catch {
      safeLog('D1 cleanup failed', { step: 'browser close' })
    }
  }
  if (server) {
    try {
      await bounded('server stop', server.stop(), 30_000)
    } catch {
      safeLog('D1 cleanup failed', { step: 'server stop' })
    }
  }
})

describe('D1 chooser arm diagnostic (non-certifying)', () => {
  test('one Enter under an awaited interception arm', async () => {
    // Chromium only: CDP sessions exist nowhere else (Playwright 1.65:
    // "CDP session is only available in Chromium"), and no chooser
    // variation has been observed in any recorded WebKit job.
    assert.notEqual(process.env.PINTO_BROWSER, 'webkit')
    const context = await browser.newContext({
      baseURL: server.url,
      viewport: { width: 1280, height: 800 }
    })
    context.setDefaultTimeout(10_000)
    let step = 'open room'
    try {
      const page = await context.newPage()
      await page.goto('/room/keyboard-keys')
      step = 'readiness wait'
      await page.locator('#call:enabled').waitFor()
      step = 'focus trail'
      for (let i = 0; i < 4; i++) await page.keyboard.press('Tab')
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        'photo'
      )
      step = 'attach CDP session'
      const cdp = await bounded(step, context.newCDPSession(page))
      // An agent joins instrumentation only with its domain enabled:
      // enable() registers it (Chromium 158.0.8127.18,
      // inspector_page_agent.cc:562), disable() removes it (:580).
      step = 'enable Page domain'
      await bounded(step, cdp.send('Page.enable'))
      // The Success response is generated after the renderer sets the
      // flag (inspector_page_agent.cc:2000-2006): awaiting it settles
      // that THIS session's arm is effective before the press, and
      // settles nothing else.
      step = 'arm interception'
      await bounded(
        step,
        cdp.send('Page.setInterceptFileChooserDialog', { enabled: true })
      )
      // The listener is registered BEFORE the press, so event collection
      // spans registration, the press itself, and the wait below.
      const opened = new Promise<'arrived'>((resolve) =>
        cdp.on('Page.fileChooserOpened', () => resolve('arrived'))
      )
      step = 'one Enter press'
      await page.keyboard.press('Enter')
      // The bounded 10-second wait starts now that the press has
      // resolved; an event that arrived during the press already
      // resolved `opened`. Projection: arrival only - no event params,
      // frame or node ids, payload bytes, or timing values.
      const outcomeTimer = new AbortController()
      const outcome = await Promise.race([
        opened,
        sleep(10_000, undefined, { signal: outcomeTimer.signal }).then(
          () => 'not-observed' as const
        )
      ])
      outcomeTimer.abort()
      safeLog('D1 armed-enter outcome', { outcome })
    } catch (error) {
      // A failed precondition is an error, never an outcome: the
      // outcome line above is only reached after a completed press.
      safeLog('D1 precondition failed', { step })
      throw error
    } finally {
      // Cleanup is guarded so a close failure is reported separately
      // and can never replace the original error or read as an outcome.
      try {
        await bounded('context close', context.close(), 30_000)
      } catch {
        safeLog('D1 cleanup failed', { step: 'context close' })
      }
    }
  })
})
