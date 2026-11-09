import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, test } from 'node:test'
import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Page,
  Request,
  WebSocket
} from 'playwright'
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
      // Engines serialize the outline shorthand differently; compare the
      // longhands, whose contract is the ring itself
      const outline = await page.evaluate(() => {
        const style = getComputedStyle(document.getElementById('self-label')!)
        return {
          style: style.outlineStyle,
          width: style.outlineWidth,
          color: style.outlineColor
        }
      })
      assert.deepEqual(outline, {
        style: 'solid',
        width: '3px',
        color: 'rgb(254, 252, 232)'
      })
    } finally {
      await context.close()
    }
  })

  const roomPath = '/room/keyboard-mobile'

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
    // Failure facts up front: the failing phase and engine, page error
    // category counts, failed request categories, route hits and fetch
    // statuses, and the Join button state - bounded categories only, no
    // URLs, console text, error text, or page source. Facts print only
    // when a phase fails, each snapshot holds only what was collected up
    // to that phase, and logging itself can never replace the original
    // error, which always rethrows. Nothing retries, waits longer, or
    // changes readiness.
    const engine = process.env.PINTO_BROWSER ?? 'chromium'
    const KNOWN_FAILURES = [
      'net::ERR_ABORTED',
      'net::ERR_FAILED',
      'net::ERR_CONNECTION_REFUSED',
      'net::ERR_CONNECTION_RESET',
      'net::ERR_CONNECTION_CLOSED',
      'net::ERR_TIMED_OUT',
      'net::ERR_NAME_NOT_RESOLVED',
      'net::ERR_INTERNET_DISCONNECTED',
      'net::ERR_SSL_PROTOCOL_ERROR',
      'net::ERR_CERT_AUTHORITY_INVALID'
    ]
    const CONSOLE_BUCKETS = [
      'room.js',
      'peerjs-client',
      'socketio-client',
      'room-document',
      'no-location',
      'other'
    ]
    const CONSOLE_SOURCE_PATHS = new Map([
      ['/room.js', 'room.js'],
      ['/vendor/peerjs.min.js', 'peerjs-client'],
      ['/socket.io/socket.io.min.js', 'socketio-client']
    ])
    const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const
    const RESPONSE_TARGETS = [
      'room-doc',
      'style',
      'room-js',
      'peerjs-client',
      'socketio-client',
      'favicon',
      'config',
      'socketio-transport',
      'peer-http',
      'external',
      'other'
    ]
    const RESPONSE_PATHS = new Map([
      ['/style.css', 'style'],
      ['/room.js', 'room-js'],
      ['/vendor/peerjs.min.js', 'peerjs-client'],
      ['/socket.io/socket.io.min.js', 'socketio-client'],
      ['/favicon.ico', 'favicon'],
      ['/config', 'config']
    ])
    const ERROR_NAMES = [
      'Error',
      'TypeError',
      'RangeError',
      'ReferenceError',
      'SyntaxError'
    ]
    const WS_TARGETS = ['peer-ws', 'socketio-ws', 'other-ws'] as const
    const watch = (page: Page) => {
      const seen = {
        pageErrors: { other: 0 } as Record<string, number>,
        consoleErrors: 0,
        consoleSources: {} as Record<string, number>,
        failedRequests: 0,
        failedResourceSamples: [] as string[],
        responses: {} as Record<string, Record<string, number>>,
        responsesUnavailable: 0,
        ws: {} as Record<string, Record<string, number>>,
        wsUnavailable: 0
      }
      for (const name of ERROR_NAMES) seen.pageErrors[name] = 0
      for (const bucket of CONSOLE_BUCKETS) seen.consoleSources[bucket] = 0
      for (const target of RESPONSE_TARGETS) {
        seen.responses[target] = { other: 0 }
        for (const cls of STATUS_CLASSES) seen.responses[target][cls] = 0
      }
      for (const target of WS_TARGETS) {
        seen.ws[target] = { created: 0, traffic: 0, closed: 0, errored: 0 }
      }
      // Bucketing uses each message/response URL in memory only; only the
      // fixed category is ever recorded. A bucket names the REPORTED
      // location, never a cause. The response listener does not measure
      // WebSocket handshakes (peer server, socket.io upgrade). A zero
      // count means no matching response event was observed; it says
      // nothing about requests that received no response. The expected
      // origin is the fixture server's, fixed before navigation.
      const expectedOrigin = new URL(server.url).origin
      const bucketConsole = (message: ConsoleMessage) => {
        const raw = message.location()?.url ?? ''
        if (!raw) return 'no-location'
        try {
          const url = new URL(raw)
          if (url.origin !== expectedOrigin) return 'other'
          if (url.pathname === roomPath) return 'room-document'
          return CONSOLE_SOURCE_PATHS.get(url.pathname) ?? 'other'
        } catch {
          return 'other'
        }
      }
      const statusClass = (status: number) => {
        const cls = `${Math.floor(status / 100)}xx`
        return (STATUS_CLASSES as readonly string[]).includes(cls)
          ? cls
          : 'other'
      }
      // Exact named paths win over prefix rules, so the socket.io
      // client bundle is 'socketio-client', not transport. '/pinto/' is
      // the PeerJS HTTP API: the helpers start the server with KEY ''
      // (test/helpers.ts :30), so the default 'pinto' applies
      // (src/index.ts :27); the peer server mounts at the root (:136),
      // the client uses path '/' (room.js :80), and server.test.ts :184
      // names '/pinto/id'.
      const targetOf = (url: URL) => {
        if (url.origin !== expectedOrigin) return 'external'
        const p = url.pathname
        if (p === roomPath) return 'room-doc'
        const named = RESPONSE_PATHS.get(p)
        if (named) return named
        if (p.startsWith('/socket.io/')) return 'socketio-transport'
        if (p.startsWith('/pinto/')) return 'peer-http'
        return 'other'
      }
      const onPageError = (error: Error) => {
        const name = ERROR_NAMES.includes(error.name) ? error.name : 'other'
        seen.pageErrors[name]++
      }
      const onConsole = (message: ConsoleMessage) => {
        if (message.type() !== 'error') return
        seen.consoleErrors++
        seen.consoleSources[bucketConsole(message)]++
      }
      const onRequestFailed = (request: Request) => {
        seen.failedRequests++
        if (seen.failedResourceSamples.length < 5) {
          const text = request.failure()?.errorText ?? ''
          const kind = KNOWN_FAILURES.includes(text) ? text : 'other'
          seen.failedResourceSamples.push(`${request.resourceType()}: ${kind}`)
        }
      }
      // The whole listener body is guarded: a throwing accessor must
      // not escape the phase, and a miss increments the initialized
      // responsesUnavailable counter rather than reading as a real zero.
      const onResponse = (response: {
        status: () => number
        url: () => string
      }) => {
        try {
          const target = targetOf(new URL(response.url()))
          seen.responses[target][statusClass(response.status())]++
        } catch {
          seen.responsesUnavailable++
        }
      }
      // WebSocket URLs carry a ws/wss scheme, so their origin string
      // never equals the page's http(s) origin; classify by canonical
      // host:port against the fixture server with ws/wss accepted as
      // the counterpart schemes. The URL is used in memory only; only
      // the fixed target and flags are recorded. 'created' counts the
      // page's websocket event, which fires at socket creation, NOT at
      // handshake completion; 'traffic' flips once per socket on the
      // first frame in either direction; 'closed' and 'errored' are
      // EVENT counts and may fire more than once per socket; an
      // all-zero target means no creation event was observed for it
      // (handler failures land in wsUnavailable), never that the app
      // did not try. No frames, payloads, close codes, reasons, or
      // error text recorded.
      const expectedHost = new URL(server.url).host
      const socketDisposers: Array<() => void> = []
      const wsTargetOf = (rawUrl: string) => {
        try {
          const url = new URL(rawUrl)
          if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
            return 'other-ws'
          }
          if (url.host !== expectedHost) return 'other-ws'
          if (url.pathname === '/peerjs') return 'peer-ws'
          if (url.pathname === '/socket.io/') return 'socketio-ws'
          return 'other-ws'
        } catch {
          return 'other-ws'
        }
      }
      const onWebSocket = (socket: WebSocket) => {
        try {
          const target = wsTargetOf(socket.url())
          seen.ws[target].created++
          let sawTraffic = false
          const onTraffic = () => {
            try {
              if (sawTraffic) return
              sawTraffic = true
              seen.ws[target].traffic++
            } catch {
              seen.wsUnavailable++
            }
          }
          const onSocketClose = () => {
            try {
              seen.ws[target].closed++
            } catch {
              seen.wsUnavailable++
            }
          }
          const onSocketError = () => {
            try {
              seen.ws[target].errored++
            } catch {
              seen.wsUnavailable++
            }
          }
          // Each disposer is registered BEFORE its listener (off of a
          // never-added listener is a no-op), so a throw during
          // registration cannot leak an untracked listener.
          socketDisposers.push(() => socket.off('framereceived', onTraffic))
          socket.on('framereceived', onTraffic)
          socketDisposers.push(() => socket.off('framesent', onTraffic))
          socket.on('framesent', onTraffic)
          socketDisposers.push(() => socket.off('close', onSocketClose))
          socket.on('close', onSocketClose)
          socketDisposers.push(() => socket.off('socketerror', onSocketError))
          socket.on('socketerror', onSocketError)
        } catch {
          seen.wsUnavailable++
        }
      }
      page.on('pageerror', onPageError)
      page.on('console', onConsole)
      page.on('requestfailed', onRequestFailed)
      page.on('response', onResponse)
      page.on('websocket', onWebSocket)
      const dispose = () => {
        page.off('pageerror', onPageError)
        page.off('console', onConsole)
        page.off('requestfailed', onRequestFailed)
        page.off('response', onResponse)
        page.off('websocket', onWebSocket)
        for (const removeSocketListeners of socketDisposers) {
          try {
            removeSocketListeners()
          } catch {
            seen.wsUnavailable++
          }
        }
      }
      return { seen, dispose }
    }
    const field = async (read: () => Promise<unknown>) => {
      try {
        return await read()
      } catch {
        return 'uncollected'
      }
    }
    const joinState = async (page: Page) => {
      const button = page.locator('#call')
      const exists = await field(async () => (await button.count()) > 0)
      if (exists !== true) return { exists }
      return {
        exists,
        enabled: await field(() => button.isEnabled()),
        visible: await field(() => button.isVisible())
      }
    }
    const phase = async <T>(
      name: string,
      work: () => Promise<T>,
      snapshot?: () => Promise<unknown>
    ) => {
      try {
        return await work()
      } catch (error) {
        let facts: unknown = 'uncollected'
        if (snapshot) {
          try {
            facts = await snapshot()
          } catch {
            facts = 'uncollected'
          }
        }
        try {
          console.error(
            `layout-baseline ${engine} phase "${name}" failed`,
            facts
          )
        } catch {
          // logging must never replace the original error
        }
        throw error
      }
    }
    const baselineContext = await newContext(390, 700)
    try {
      // Per-route, differentiated facts: hit counts, fetch outcome (the
      // server's status or 'failed'), and whether fulfill completed.
      const routes = {
        roomHits: 0,
        cssHits: 0,
        roomFetch: 'none' as number | 'failed' | 'none',
        cssFetch: 'none' as number | 'failed' | 'none',
        roomFulfilled: false,
        cssFulfilled: false
      }
      await baselineContext.route('**/room/**', async (route) => {
        if (!route.request().isNavigationRequest()) {
          return route.continue()
        }
        routes.roomHits++
        let response
        try {
          response = await route.fetch()
          routes.roomFetch = response.status()
        } catch (error) {
          routes.roomFetch = 'failed'
          throw error
        }
        await route.fulfill({
          response,
          path: fixture('pre-change-room.html')
        })
        routes.roomFulfilled = true
      })
      await baselineContext.route('**/style.css', async (route) => {
        routes.cssHits++
        let response
        try {
          response = await route.fetch()
          routes.cssFetch = response.status()
        } catch (error) {
          routes.cssFetch = 'failed'
          throw error
        }
        await route.fulfill({
          response,
          path: fixture('pre-change-style.css'),
          contentType: 'text/css'
        })
        routes.cssFulfilled = true
      })
      const baseline = await baselineContext.newPage()
      const base = watch(baseline)
      try {
        await phase(
          'baseline goto',
          () => baseline.goto(roomPath),
          async () => ({ routes: { ...routes }, ...base.seen })
        )
        await phase(
          'baseline ready',
          () => baseline.locator('#call:enabled').waitFor(),
          async () => ({
            join: await joinState(baseline),
            routes: { ...routes },
            ...base.seen
          })
        )
        // The baseline must really be the pinned pre-change bytes: the
        // served stylesheet is byte-identical to the fixture, and the
        // rendered document carries the pre-change hidden input.
        let servedCssChars: number | 'uncollected' = 'uncollected'
        let hiddenInputs: number | 'uncollected' = 'uncollected'
        await phase(
          'baseline identity',
          async () => {
            assert.ok(
              routes.roomHits > 0,
              'the room document was never requested'
            )
            assert.ok(routes.cssHits > 0, 'the stylesheet was never requested')
            const servedCss = await baseline.evaluate(() =>
              fetch('/style.css').then((response) => response.text())
            )
            servedCssChars = servedCss.length
            assert.equal(
              servedCss,
              await readFile(fixture('pre-change-style.css'), 'utf8')
            )
            hiddenInputs = await baseline.locator('#photo[hidden]').count()
            assert.equal(hiddenInputs, 1)
          },
          async () => ({
            routes: { ...routes },
            servedCssChars,
            hiddenInputs,
            ...base.seen
          })
        )
        const before = await phase(
          'baseline measure',
          () => boxes(baseline),
          async () => ({ ...base.seen })
        )

        const patchedContext = await newContext(390, 700)
        try {
          const patched = await patchedContext.newPage()
          const patch = watch(patched)
          try {
            await phase(
              'patched goto',
              () => patched.goto(roomPath),
              async () => ({ ...patch.seen })
            )
            await phase(
              'patched ready',
              () => patched.locator('#call:enabled').waitFor(),
              async () => ({
                join: await joinState(patched),
                ...patch.seen
              })
            )
            const after = await phase(
              'patched measure',
              () => boxes(patched),
              async () => ({ ...patch.seen })
            )
            await phase(
              'compare',
              async () => assert.deepEqual(after, before),
              async () => ({ before, after })
            )
          } finally {
            patch.dispose()
          }
        } finally {
          await patchedContext.close()
        }
      } finally {
        base.dispose()
      }
    } finally {
      await baselineContext.close()
    }
  })
})
