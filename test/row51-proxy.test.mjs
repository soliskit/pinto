/**
 * Unit + loopback integration tests for the row 51 kill/observation
 * proxy. Synthetic upstreams and clients only: NO pinto server, NO
 * browser, NO network beyond 127.0.0.1. These tests are tooling
 * preparation (verification of the authored bytes themselves), not the
 * row 51 run - the run needs its own fresh owner yes.
 *
 * Named coverage required by the reviewed plan:
 * - parser robustness: the 101 and the OPEN arriving together, and the
 *   OPEN split at every possible byte (CAPTURE COMPLETENESS / scenario
 *   B's positive-control machinery)
 * - the close-leak test: on kill, the server leg is detached BEFORE the
 *   client leg closes; no data, FIN, RST or close frame passes
 *   server-ward until an explicit tidy (SCENARIO A)
 * - /config interception: exactly one route, exactly one field, every
 *   other route byte-identical, surprises fail closed (MEDIA
 *   CONTAINMENT)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  WsFrameParser,
  MessageReassembler,
  encodeFrame,
  OPCODES
} from './ws-frame-parser.mjs'
import { startProxy } from './row51-proxy.mjs'

/**
 * Ordinary [[Get]] of one property on parsed data (same form as the
 * take-stage measurement helper); returns unknown.
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
const readKey = (value, key) =>
  value === null || value === undefined
    ? undefined
    : Reflect.get(Object(value), key, value)

const OPEN_TEXT = '{"type":"OPEN"}'
const HB_TEXT = '{"type":"HEARTBEAT"}'
const RESPONSE_101 =
  'HTTP/1.1 101 Switching Protocols\r\n' +
  'Upgrade: websocket\r\n' +
  'Connection: Upgrade\r\n' +
  'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n' +
  '\r\n'

/** @param {string} path */
function upgradeRequest(path) {
  return Buffer.from(
    `GET ${path} HTTP/1.1\r\n` +
      'Host: 127.0.0.1\r\n' +
      'Connection: Upgrade\r\n' +
      'Upgrade: websocket\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
      'Sec-WebSocket-Version: 13\r\n' +
      '\r\n'
  )
}

/**
 * @param {() => unknown} fn
 * @param {{ timeout?: number, interval?: number }} [options]
 */
async function waitFor(fn, { timeout = 3000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await sleep(interval)
  }
}

// ---- parser unit tests ----

void test('parser: unmasked text frame round-trip', () => {
  const p = new WsFrameParser()
  const frames = p.push(encodeFrame({ opcode: 1, payload: Buffer.from('hi') }))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].fin, true)
  assert.equal(frames[0].opcode, 1)
  assert.equal(frames[0].masked, false)
  assert.equal(frames[0].payload.toString(), 'hi')
})

void test('parser: masked client frame unmasked correctly', () => {
  const p = new WsFrameParser()
  const frames = p.push(
    encodeFrame({ opcode: 1, payload: Buffer.from(HB_TEXT), mask: true })
  )
  assert.equal(frames.length, 1)
  assert.equal(frames[0].masked, true)
  assert.equal(frames[0].payload.toString(), HB_TEXT)
})

void test('parser: 16-bit extended length', () => {
  const p = new WsFrameParser()
  const payload = Buffer.alloc(200, 0x61)
  const frames = p.push(encodeFrame({ opcode: 2, payload }))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].len, 200)
  assert.deepEqual(frames[0].payload, payload)
})

void test('parser: fragmented message reassembled', () => {
  const p = new WsFrameParser()
  const r = new MessageReassembler()
  const wire = Buffer.concat([
    encodeFrame({ fin: false, opcode: 1, payload: Buffer.from('{"type":"O') }),
    encodeFrame({ fin: true, opcode: 0, payload: Buffer.from('PEN"}') })
  ])
  const messages = r.push(p.push(wire))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].payload.toString(), OPEN_TEXT)
})

void test('parser: OPEN split at every possible byte', () => {
  const wire = encodeFrame({ opcode: 1, payload: Buffer.from(OPEN_TEXT) })
  for (let i = 1; i < wire.length; i++) {
    const p = new WsFrameParser()
    const r = new MessageReassembler()
    const first = r.push(p.push(wire.subarray(0, i)))
    const second = r.push(p.push(wire.subarray(i)))
    const messages = [...first, ...second]
    assert.equal(messages.length, 1, `split at ${String(i)}`)
    assert.equal(messages[0].payload.toString(), OPEN_TEXT)
  }
})

// ---- synthetic upstreams and clients (loopback only) ----

/**
 * @param {import('node:test').TestContext} t
 * @param {{ coalesceOpen?: boolean }} [options]
 */
async function startWsUpstream(t, { coalesceOpen = false } = {}) {
  /** @type {{ sockets: Array<import('node:net').Socket>, dataEvents: Array<number>, frames: Array<import('./ws-frame-parser.mjs').Message>, ended: number }} */
  const state = { sockets: [], dataEvents: [], frames: [], ended: 0 }
  const server = net.createServer((sock) => {
    state.sockets.push(sock)
    let buf = Buffer.alloc(0)
    let upgraded = false
    const parser = new WsFrameParser()
    const reasm = new MessageReassembler()
    /** @param {Buffer} chunk */
    const handle = (chunk) => {
      state.dataEvents.push(chunk.length)
      for (const m of reasm.push(parser.push(chunk))) {
        state.frames.push(m)
        if (m.opcode === OPCODES.TEXT) {
          sock.write(encodeFrame({ opcode: 1, payload: m.payload }))
        }
      }
    }
    sock.on('data', (chunk) => {
      if (upgraded) {
        handle(Buffer.from(chunk))
        return
      }
      buf = Buffer.concat([buf, Buffer.from(chunk)])
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) return
      upgraded = true
      let out = Buffer.from(RESPONSE_101)
      if (coalesceOpen) {
        // The risk shape: OPEN sharing one read with the 101 head's end
        out = Buffer.concat([
          out,
          encodeFrame({ opcode: 1, payload: Buffer.from(OPEN_TEXT) })
        ])
      }
      sock.write(out)
      const leftover = buf.subarray(end + 4)
      buf = Buffer.alloc(0)
      if (leftover.length) handle(leftover)
    })
    sock.on('end', () => state.ended++)
    sock.on('error', () => {})
  })
  await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      resolve(undefined)
    })
  )
  t.after(() => {
    for (const s of state.sockets) s.destroy()
    server.close()
  })
  const addr = server.address()
  if (addr === null || typeof addr === 'string') {
    throw new Error('upstream server has no port')
  }
  return { state, port: addr.port }
}

/**
 * @param {import('node:test').TestContext} t
 * @param {number} port
 * @param {string} path
 * @param {Partial<import('node:net').NetConnectOpts>} [options]
 */
async function wsClient(t, port, path, options = {}) {
  const sock = net.connect({ port, host: '127.0.0.1', ...options })
  t.after(() => {
    sock.destroy()
  })
  let buf = Buffer.alloc(0)
  sock.on('data', (c) => {
    buf = Buffer.concat([buf, Buffer.from(c)])
  })
  await new Promise((resolve) =>
    sock.once('connect', () => {
      resolve(undefined)
    })
  )
  sock.write(upgradeRequest(path))
  await waitFor(() => buf.indexOf('\r\n\r\n') !== -1)
  const leftover = buf.subarray(buf.indexOf('\r\n\r\n') + 4)
  return { sock, leftover }
}

/**
 * @param {import('node:net').Socket} sock
 * @param {string} event
 * @param {number} [timeout]
 */
function onceEvent(sock, event, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no ${event} within ${String(timeout)}ms`))
    }, timeout)
    sock.once(event, () => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}

/**
 * @param {import('node:test').TestContext} t
 * @param {number} upstreamPort
 */
async function startTestProxy(t, upstreamPort) {
  /** @type {Array<Record<string, unknown>>} */
  const events = []
  const started = await startProxy({
    targetHost: '127.0.0.1',
    targetPort: upstreamPort,
    pages: [
      { label: 'main', port: 0 },
      { label: 'visitor', port: 0 }
    ],
    controlPort: 0,
    quiet: true,
    onEvent: (e) => events.push(e)
  })
  const proxy = started.proxy
  t.after(() => {
    started.close()
  })
  const pageAddr = proxy.servers[0].address()
  const controlAddr = proxy.control ? proxy.control.address() : null
  if (
    pageAddr === null ||
    typeof pageAddr === 'string' ||
    controlAddr === null ||
    typeof controlAddr === 'string'
  ) {
    throw new Error('proxy servers not listening')
  }
  return {
    events,
    proxy,
    pagePort: pageAddr.port,
    controlPort: controlAddr.port
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null
}

/**
 * @param {number} port
 * @param {string} path
 */
async function control(port, path) {
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: 'POST'
  })
  /** @type {unknown} */
  const data = await res.json()
  return data
}

const PEER_PATH = '/peerjs?key=pinto&id=test-id&token=test-token'

// ---- proxy integration tests ----

void test('proxy: coalesced 101+OPEN is captured from connection start', async (t) => {
  const upstream = await startWsUpstream(t, { coalesceOpen: true })
  const { events, pagePort } = await startTestProxy(t, upstream.port)
  const { sock } = await wsClient(t, pagePort, PEER_PATH)
  sock.write(
    encodeFrame({ opcode: 1, payload: Buffer.from(HB_TEXT), mask: true })
  )
  await waitFor(() => events.some((e) => e.ev === 'heartbeat-forwarded'))
  const open101 = events.find((e) => e.ev === 'ws-101')
  assert.ok(open101, 'ws-101 logged')
  assert.equal(open101.extensions, null)
  const openFrame = events.find(
    (e) => e.ev === 'ws-frame' && e.dir === 'sc' && e.text === OPEN_TEXT
  )
  assert.ok(openFrame, 'coalesced OPEN frame logged')
  assert.ok(
    events.some((e) => e.ev === 'open-frame'),
    'derived open-frame'
  )
  // OPEN came first, so no no-open decision point may be declared
  assert.ok(!events.some((e) => e.ev === 'decision-point'))
})

void test('proxy: no-OPEN decision point at first post-resume heartbeat', async (t) => {
  const upstream = await startWsUpstream(t)
  const { events, pagePort } = await startTestProxy(t, upstream.port)
  const { sock } = await wsClient(t, pagePort, PEER_PATH)
  sock.write(
    encodeFrame({ opcode: 1, payload: Buffer.from(HB_TEXT), mask: true })
  )
  await waitFor(() => events.some((e) => e.ev === 'decision-point'))
  const dp = events.find((e) => e.ev === 'decision-point')
  assert.ok(dp)
  assert.equal(dp.result, 'no-open-resume')
  assert.equal(dp.derived, true)
  assert.equal(typeof dp.rPlusMs, 'number')
})

void test('proxy: kill fin - no close leak server-ward until tidy', async (t) => {
  const upstream = await startWsUpstream(t)
  const { events, pagePort, controlPort } = await startTestProxy(
    t,
    upstream.port
  )
  // allowHalfOpen: the client can still write after the proxy's FIN, which
  // is what exercises the post-kill discard path
  const { sock } = await wsClient(t, pagePort, PEER_PATH, {
    allowHalfOpen: true
  })
  sock.write(
    encodeFrame({ opcode: 1, payload: Buffer.from(HB_TEXT), mask: true })
  )
  await waitFor(() => upstream.state.frames.length === 1)
  const bytesBefore = upstream.state.dataEvents.reduce((a, b) => a + b, 0)

  const res = await control(controlPort, '/kill?conn=1&mode=fin')
  assert.deepEqual(res, { ok: true })
  // The client leg closes (bare FIN): client observes end
  await onceEvent(sock, 'end')
  // Post-kill client bytes are discarded, never forwarded
  sock.write(
    encodeFrame({ opcode: 1, payload: Buffer.from(HB_TEXT), mask: true })
  )
  await sleep(400)
  const bytesAfter = upstream.state.dataEvents.reduce((a, b) => a + b, 0)
  assert.equal(bytesAfter, bytesBefore, 'nothing forwarded server-ward')
  assert.equal(upstream.state.ended, 0, 'no FIN server-ward')
  assert.equal(upstream.state.frames.length, 1, 'no close frame server-ward')
  assert.ok(
    events.some((e) => e.ev === 'discard' && e.dir === 'cs'),
    'discard recorded'
  )
  const killEvent = events.find((e) => e.ev === 'kill')
  assert.ok(killEvent)
  assert.equal(killEvent.mode, 'fin')

  const tidyRes = await control(controlPort, '/tidy?conn=1')
  assert.deepEqual(tidyRes, { ok: true })
  await waitFor(() => upstream.state.ended === 1)
  assert.ok(events.some((e) => e.ev === 'tidy'))
})

void test('proxy: kill close-frame - close goes client-ward only', async (t) => {
  const upstream = await startWsUpstream(t)
  const { events, pagePort, controlPort } = await startTestProxy(
    t,
    upstream.port
  )
  const { sock, leftover } = await wsClient(t, pagePort, PEER_PATH)
  const parser = new WsFrameParser()
  /** @type {Array<import('./ws-frame-parser.mjs').Frame>} */
  const frames = []
  if (leftover.length) frames.push(...parser.push(leftover))
  sock.on('data', (c) => frames.push(...parser.push(Buffer.from(c))))
  sock.write(
    encodeFrame({ opcode: 1, payload: Buffer.from(HB_TEXT), mask: true })
  )
  await waitFor(() => upstream.state.frames.length === 1)

  const res = await control(controlPort, '/kill?conn=1&mode=close-frame')
  assert.deepEqual(res, { ok: true })
  await waitFor(() => frames.some((f) => f.opcode === OPCODES.CLOSE))
  const closeFrame = frames.find((f) => f.opcode === OPCODES.CLOSE)
  assert.ok(closeFrame)
  assert.equal(closeFrame.masked, false, 'server-ward frames are unmasked')
  assert.deepEqual(closeFrame.payload, Buffer.from([0x03, 0xe9]))
  await sleep(300)
  assert.equal(upstream.state.frames.length, 1, 'no close frame server-ward')
  assert.equal(upstream.state.ended, 0, 'no FIN server-ward')
  assert.ok(events.some((e) => e.ev === 'kill' && e.mode === 'close-frame'))
})

void test('proxy: deliver close-frame - server-SEEN drop (scenario B)', async (t) => {
  const upstream = await startWsUpstream(t)
  const { events, pagePort, controlPort } = await startTestProxy(
    t,
    upstream.port
  )
  const { sock } = await wsClient(t, pagePort, PEER_PATH)
  sock.write(
    encodeFrame({ opcode: 1, payload: Buffer.from(HB_TEXT), mask: true })
  )
  await waitFor(() => upstream.state.frames.length === 1)

  const res = await control(controlPort, '/deliver?conn=1&mode=close-frame')
  assert.deepEqual(res, { ok: true })
  await waitFor(() =>
    upstream.state.frames.some((f) => f.opcode === OPCODES.CLOSE)
  )
  const closeFrame = upstream.state.frames.find(
    (f) => f.opcode === OPCODES.CLOSE
  )
  assert.ok(closeFrame)
  assert.deepEqual(closeFrame.payload, Buffer.from([0x03, 0xe9]))
  assert.ok(events.some((e) => e.ev === 'deliver-close-frame-sent'))
})

void test('proxy: deliver fin - FIN delivered server-ward', async (t) => {
  const upstream = await startWsUpstream(t)
  const { pagePort, controlPort } = await startTestProxy(t, upstream.port)
  const { sock } = await wsClient(t, pagePort, PEER_PATH)
  sock.write(
    encodeFrame({ opcode: 1, payload: Buffer.from(HB_TEXT), mask: true })
  )
  await waitFor(() => upstream.state.frames.length === 1)

  const res = await control(controlPort, '/deliver?conn=1&mode=fin')
  assert.deepEqual(res, { ok: true })
  await waitFor(() => upstream.state.ended === 1)
  assert.ok(
    !upstream.state.frames.some((f) => f.opcode === OPCODES.CLOSE),
    'no close frame, just FIN'
  )
})

void test('proxy: kill refused for non-peer connections', async (t) => {
  const upstream = await startWsUpstream(t)
  const { pagePort, controlPort } = await startTestProxy(t, upstream.port)
  await wsClient(t, pagePort, '/socket.io/?EIO=4&transport=websocket')
  const res = await control(controlPort, '/kill?conn=1&mode=fin')
  assert.ok(isRecord(res))
  assert.equal(res.error, 'kill is for peer conns only')
})

void test('proxy: upgrade classification peer vs socket.io vs other', async (t) => {
  const upstream = await startWsUpstream(t)
  const { events, pagePort } = await startTestProxy(t, upstream.port)
  await wsClient(t, pagePort, PEER_PATH)
  await wsClient(t, pagePort, '/socket.io/?EIO=4&transport=websocket')
  await wsClient(t, pagePort, '/something-else')
  await waitFor(() => events.filter((e) => e.ev === 'upgrade').length === 3)
  const kinds = events.filter((e) => e.ev === 'upgrade').map((e) => e.kind)
  assert.deepEqual(kinds, ['peer', 'socketio', 'other-upgrade'])
  const peerUpgrade = events.find(
    (e) => e.ev === 'upgrade' && e.kind === 'peer'
  )
  assert.ok(peerUpgrade)
  assert.deepEqual(
    [peerUpgrade.hasKey, peerUpgrade.hasId, peerUpgrade.hasToken],
    [true, true, true]
  )
})

// ---- /config interception ----

/**
 * @param {import('node:test').TestContext} t
 * @param {{ configResponder?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void }} [options]
 */
async function startHttpUpstream(t, { configResponder } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/config') {
      if (!configResponder) throw new Error('config responder missing')
      configResponder(req, res)
      return
    }
    if (req.url === '/bundle.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript',
        'content-length': 4
      })
      return res.end('AAAA')
    }
    if (req.url === '/chunked') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('Hello ')
      return res.end('World')
    }
    res.writeHead(404, { 'content-length': 0 })
    res.end()
  })
  await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      resolve(undefined)
    })
  )
  t.after(() => server.close())
  const addr = server.address()
  if (addr === null || typeof addr === 'string') {
    throw new Error('upstream server has no port')
  }
  return { port: addr.port }
}

/**
 * @param {number} port
 * @param {string} path
 * @param {{ close?: boolean }} [options]
 */
async function httpGet(port, path, { close = false } = {}) {
  const sock = net.connect(port, '127.0.0.1')
  await new Promise((resolve) => sock.once('connect', resolve))
  sock.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
      `Connection: ${close ? 'close' : 'keep-alive'}\r\n\r\n`
  )
  /** @type {Buffer<ArrayBufferLike>} */
  let buf = Buffer.alloc(0)
  const readHead = async () => {
    for (;;) {
      const end = buf.indexOf('\r\n\r\n')
      if (end !== -1) {
        const head = buf.subarray(0, end + 4).toString('latin1')
        buf = buf.subarray(end + 4)
        return head
      }
      const chunk = await new Promise(
        (/** @type {(value: Buffer) => void} */ resolve, reject) => {
          sock.once('data', resolve)
          sock.once('error', reject)
        }
      )
      buf = Buffer.concat([buf, chunk])
    }
  }
  const head = await readHead()
  const match = /content-length:\s*(\d+)/i.exec(head)
  /** @type {Buffer} */
  let body
  if (match) {
    const total = Number(match[1])
    while (buf.length < total) {
      const chunk = await new Promise(
        (/** @type {(value: Buffer) => void} */ resolve, reject) => {
          sock.once('data', resolve)
          sock.once('error', reject)
        }
      )
      buf = Buffer.concat([buf, chunk])
    }
    body = buf.subarray(0, total)
    buf = buf.subarray(total)
  } else {
    // chunk-delimited read until close
    body = await new Promise((resolve) => {
      const parts = [buf]
      sock.on('data', (c) => parts.push(Buffer.from(c)))
      sock.once('close', () => {
        resolve(Buffer.concat(parts))
      })
    })
  }
  return {
    sock,
    head,
    body,
    readHead,
    getBuf: () => buf,
    setBuf: (/** @type {Buffer<ArrayBufferLike>} */ b) => (buf = b)
  }
}

void test('proxy: /config interception rewrites iceServers only', async (t) => {
  const upstream = await startHttpUpstream(t, {
    configResponder: (req, res) => {
      const body = JSON.stringify({
        key: 'pinto',
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      })
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      })
      res.end(body)
    }
  })
  const { events, pagePort } = await startTestProxy(t, upstream.port)
  const first = await httpGet(pagePort, '/config')
  /** @type {unknown} */
  const json = JSON.parse(first.body.toString('utf8'))
  assert.equal(readKey(json, 'key'), 'pinto', 'key unchanged')
  assert.deepEqual(readKey(json, 'iceServers'), [], 'iceServers emptied')
  const m = /content-length: (\d+)/i.exec(first.head)
  assert.ok(m !== null)
  const declared = Number(m[1])
  assert.equal(
    declared,
    first.body.length,
    're-serialized content-length matches the delivered body'
  )
  const intercept = events.find((e) => e.ev === 'config-intercept')
  assert.ok(intercept)
  assert.equal(intercept.iceServersBefore, 1)
  assert.equal(intercept.iceServersAfter, 0)

  // A second request on the same keep-alive connection, other route
  first.sock.write('GET /bundle.js HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
  const head2 = await first.readHead()
  assert.ok(/content-length: 4/i.test(head2))
  let body2 = first.getBuf()
  while (body2.length < 4) {
    const chunk = await new Promise(
      (/** @type {(value: Buffer) => void} */ resolve, reject) => {
        first.sock.once('data', resolve)
        first.sock.once('error', reject)
      }
    )
    body2 = Buffer.concat([body2, chunk])
  }
  assert.equal(body2.subarray(0, 4).toString(), 'AAAA', 'bundle byte-identical')
  first.sock.destroy()
})

void test('proxy: /config interception fails closed on non-JSON', async (t) => {
  const upstream = await startHttpUpstream(t, {
    configResponder: (req, res) => {
      const body = 'not json at all'
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      })
      res.end(body)
    }
  })
  const { events, pagePort } = await startTestProxy(t, upstream.port)
  const sock = net.connect(pagePort, '127.0.0.1')
  await new Promise((resolve) => sock.once('connect', resolve))
  sock.write('GET /config HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
  await onceEvent(sock, 'close').catch(() => {})
  await waitFor(() => events.some((e) => e.ev === 'config-intercept-fail'))
  assert.ok(
    !events.some((e) => e.ev === 'config-intercept'),
    'no interception logged on failure'
  )
  sock.destroy()
})

void test('proxy: chunked non-config response passes through', async (t) => {
  const upstream = await startHttpUpstream(t, {
    configResponder: () => {}
  })
  const { pagePort } = await startTestProxy(t, upstream.port)
  const { body } = await httpGet(pagePort, '/chunked', { close: true })
  const text = body.toString('latin1')
  assert.ok(text.includes('Hello '), 'first chunk forwarded')
  assert.ok(text.includes('World'), 'terminal chunk forwarded')
})
