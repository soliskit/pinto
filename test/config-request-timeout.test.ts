import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { after, afterEach, before, test } from 'node:test'
import type { Browser, BrowserContext, Page } from 'playwright'
import {
  eventually,
  launchBrowser,
  startServer,
  type Server
} from './helpers.ts'

// Regression tests for the 10-second /config budget (the r2 held-config
// facet). A per-test stall proxy sits between the page and the
// real server and shapes only the /config response; every other route and
// every upgrade is tunneled unchanged.

type Stall =
  | { kind: 'hold-headers' } // never answer /config at all
  | { kind: 'stall-body' } // send headers and one chunk, never end
  | { kind: 'delay'; ms: number } // buffer the real answer, send it ms late
  | { kind: 'slow-body'; ms: number } // headers now, body completes ms late
  | { kind: 'refuse' } // destroy the /config connection (network failure)
  | { kind: 'status'; code: number; body: string } // fixed HTTP error
  | { kind: 'body'; body: string } // immediate fixed 200 body

const TIMEOUT_TEXT =
  'Pinto hit an error: Uncaught Error: Connection settings could not be loaded (no answer within 10 seconds).'
const ERROR_PREFIX = 'Pinto hit an error:'
// Exact pre-change visible output for the pass-through cases; asserting
// byte equality proves the fix does not change that output.
const REFUSED_TEXT = 'Pinto hit an error: Uncaught TypeError: Failed to fetch'
const BAD_JSON_TEXT = 'Pinto hit an error: Script error.' // exact pre-change visible output

let server: Server | undefined
let browser: Browser | undefined
const contexts: BrowserContext[] = []
const proxies: http.Server[] = []

function ready<T>(resource: T | undefined, name: string): T {
  assert.ok(resource, `${name} setup did not complete`)
  return resource
}

before(async () => {
  ;[server, browser] = await Promise.all([startServer(), launchBrowser()])
})
after(async () => {
  await browser?.close()
  await server?.stop()
})
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()))
  await Promise.all(
    proxies.splice(0).map(
      (proxy) =>
        new Promise<void>((resolve) => {
          proxy.close(() => {
            resolve()
          })
        })
    )
  )
})

function handleConfig(
  stall: Stall,
  target: number,
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  switch (stall.kind) {
    case 'hold-headers':
      return // never answer
    case 'stall-body':
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"iceServers": [')
      return // never end the body
    case 'refuse':
      res.socket?.destroy()
      return
    case 'status':
      res.writeHead(stall.code, { 'content-type': 'text/plain' })
      res.end(stall.body)
      return
    case 'body':
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(stall.body)
      return
    case 'slow-body': {
      const up = http.request(
        {
          host: '127.0.0.1',
          port: target,
          path: req.url,
          method: req.method,
          headers: req.headers
        },
        (ur) => {
          const chunks: Buffer[] = []
          ur.on('data', (chunk: Buffer) => chunks.push(chunk))
          ur.on('end', () => {
            const body = Buffer.concat(chunks)
            const half = Math.ceil(body.length / 2)
            res.writeHead(ur.statusCode ?? 502, ur.headers)
            res.write(body.subarray(0, half)) // first half arrives now
            setTimeout(() => {
              res.end(body.subarray(half)) // body completes ms late
            }, stall.ms)
          })
        }
      )
      up.on('error', () => {
        res.statusCode = 502
        res.end()
      })
      req.pipe(up)
      return
    }
    case 'delay': {
      const up = http.request(
        {
          host: '127.0.0.1',
          port: target,
          path: req.url,
          method: req.method,
          headers: req.headers
        },
        (ur) => {
          const chunks: Buffer[] = []
          ur.on('data', (chunk: Buffer) => chunks.push(chunk))
          ur.on('end', () => {
            setTimeout(() => {
              res.writeHead(ur.statusCode ?? 502, ur.headers)
              res.end(Buffer.concat(chunks))
            }, stall.ms)
          })
        }
      )
      up.on('error', () => {
        res.statusCode = 502
        res.end()
      })
      req.pipe(up)
      return
    }
  }
}

/** A proxy that shapes only /config; everything else tunnels to the server */
async function startStallProxy(stall: Stall): Promise<number> {
  const target = Number(new URL(ready(server, 'server').url).port)
  const proxy = http.createServer((req, res) => {
    if (req.url?.startsWith('/config') === true) {
      handleConfig(stall, target, req, res)
      return
    }
    const up = http.request(
      {
        host: '127.0.0.1',
        port: target,
        path: req.url,
        method: req.method,
        headers: req.headers
      },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers)
        ur.pipe(res)
      }
    )
    up.on('error', () => {
      res.statusCode = 502
      res.end()
    })
    req.pipe(up)
  })
  proxy.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(target, '127.0.0.1', () => {
      const requestHead =
        `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}\r\n` +
        Object.entries(req.headers)
          .map(([key, value]) => `${key}: ${String(value)}`)
          .join('\r\n') +
        '\r\n\r\n'
      upstream.write(requestHead)
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  proxies.push(proxy)
  return new Promise((resolve) => {
    proxy.listen(0, '127.0.0.1', () => {
      const address = proxy.address()
      assert.ok(address !== null && typeof address === 'object')
      resolve(address.port)
    })
  })
}

async function openRoomViaProxy(port: number, name: string): Promise<Page> {
  const context = await ready(browser, 'browser').newContext({
    baseURL: `http://127.0.0.1:${String(port)}`
  })
  context.setDefaultTimeout(20_000)
  contexts.push(context)
  const page = await context.newPage()
  await page.goto(`/room/${encodeURIComponent(name)}`)
  return page
}

/** The page-error detail line, or null while no page error is shown */
const errorDetail = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const box = document.getElementById('error') as HTMLElement
    if (box.hidden) return null
    const detail = box.querySelector('#page-error h2')
    return detail === null ? null : detail.textContent
  })

const joinEnabled = (page: Page): Promise<boolean> =>
  page.evaluate(
    () => !(document.getElementById('call') as HTMLButtonElement).disabled
  )

const statusText = (page: Page): Promise<string> =>
  page.evaluate(
    () => (document.getElementById('status') as HTMLElement).textContent
  )

void test('a /config that never answers times out with a named error and Join stays disabled', async () => {
  const port = await startStallProxy({ kind: 'hold-headers' })
  const page = await openRoomViaProxy(port, 'held-headers')
  await eventually(() => errorDetail(page), TIMEOUT_TEXT, 20_000)
  assert.equal(await joinEnabled(page), false)
  assert.equal(await statusText(page), '')
})

void test('a /config whose body stalls mid-response times out the same way', async () => {
  const port = await startStallProxy({ kind: 'stall-body' })
  const page = await openRoomViaProxy(port, 'stalled-body')
  await eventually(() => errorDetail(page), TIMEOUT_TEXT, 20_000)
  assert.equal(await joinEnabled(page), false)
  assert.equal(await statusText(page), '')
})

void test('a refused /config keeps its original failure, not the timeout wording', async () => {
  const port = await startStallProxy({ kind: 'refuse' })
  const page = await openRoomViaProxy(port, 'refused-config')
  await eventually(
    async () => (await errorDetail(page))?.startsWith(ERROR_PREFIX) ?? false,
    true,
    20_000
  )
  const detail = await errorDetail(page)
  assert.equal(detail, REFUSED_TEXT) // original TypeError, unchanged
  assert.equal(await joinEnabled(page), false)
})

void test('a /config answered after the budget never initializes the page', async () => {
  const port = await startStallProxy({ kind: 'delay', ms: 12_000 })
  const page = await openRoomViaProxy(port, 'late-answer')
  await eventually(() => errorDetail(page), TIMEOUT_TEXT, 20_000)
  // The delayed valid answer arrives at ~12 s; give it room to (wrongly) act
  await page.waitForTimeout(3_000)
  assert.equal(await statusText(page), '')
  assert.equal(await joinEnabled(page), false)
  assert.equal(await errorDetail(page), TIMEOUT_TEXT)
})

void test('a /config whose body completes after the budget never initializes the page', async () => {
  // Headers arrive in budget; the body finishes at ~12 s, after the budget.
  const port = await startStallProxy({ kind: 'slow-body', ms: 12_000 })
  const page = await openRoomViaProxy(port, 'late-body')
  await eventually(() => errorDetail(page), TIMEOUT_TEXT, 20_000)
  await page.waitForTimeout(3_000)
  assert.equal(await statusText(page), '')
  assert.equal(await joinEnabled(page), false)
  assert.equal(await errorDetail(page), TIMEOUT_TEXT)
})

void test('a slow in-budget /config (simulated cold relay fallback) still initializes the page', async () => {
  // Simulated: the proxy holds a valid answer for 5.5 s, the shape of a cold
  // config that waited out the server's own 5 s relay-fetch timeout. This is
  // not a real upstream fallback run.
  const port = await startStallProxy({ kind: 'delay', ms: 5_500 })
  const page = await openRoomViaProxy(port, 'slow-fallback')
  await eventually(
    () => statusText(page),
    'Press Join to start the call',
    20_000
  )
  await eventually(() => joinEnabled(page), true, 20_000)
  assert.equal(await errorDetail(page), null)
})

void test('a normal /config initializes the page (control)', async () => {
  const port = await startStallProxy({ kind: 'delay', ms: 0 })
  const page = await openRoomViaProxy(port, 'normal-config')
  await eventually(
    () => statusText(page),
    'Press Join to start the call',
    20_000
  )
  await eventually(() => joinEnabled(page), true, 20_000)
  assert.equal(await errorDetail(page), null)
})

void test('a /config HTTP error keeps its existing message', async () => {
  const port = await startStallProxy({ kind: 'status', code: 500, body: 'x' })
  const page = await openRoomViaProxy(port, 'error-config')
  await eventually(
    () => errorDetail(page),
    'Pinto hit an error: Uncaught Error: Connection settings could not be loaded (500).',
    20_000
  )
  assert.equal(await joinEnabled(page), false)
})

void test('a malformed /config body keeps its original error, not the timeout wording', async () => {
  const port = await startStallProxy({ kind: 'body', body: 'this is not json' })
  const page = await openRoomViaProxy(port, 'bad-json-config')
  await eventually(
    async () => (await errorDetail(page))?.startsWith(ERROR_PREFIX) ?? false,
    true,
    20_000
  )
  const detail = await errorDetail(page)
  assert.equal(detail, BAD_JSON_TEXT) // pre-change visible output, unchanged
  assert.equal(await joinEnabled(page), false)
})
