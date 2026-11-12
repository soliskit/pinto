/**
 * ROW 51 KILL/OBSERVATION PROXY - authored test tooling under the
 * reviewed row 51 verification plan (sha1
 * 9cf07f0514cece342e8bb6515f772240bb78dfc1). Sits in path between test
 * pages and the LOCAL pinto server: each page gets its own listen port
 * (that is also how a socket.io connection is matched to its page), the
 * proxy forwards to the target and sees every connection from connect.
 *
 * Behaviors (plan section references):
 * - Peer websocket identified by its upgrade request: pathname /peerjs
 *   with key+id+token query (peerjs@1.5.5 builds "<path>peerjs?key=...";
 *   pinto passes path '/', room.js:70-79), distinct from socket.io's
 *   /socket.io/ (SCENARIO A).
 * - Full-duplex forwarding with a parse-only tee: websocket frames are
 *   parsed for the frame log from CONNECTION START on both directions -
 *   the server leg's 101 head is parsed first and leftover bytes go
 *   straight to the frame parser, so an OPEN sharing one read with the
 *   end of the 101 header is still logged (CAPTURE COMPLETENESS). The
 *   negotiated Sec-WebSocket-Extensions value is recorded per connection.
 * - Kill (POST /kill): peer connections only. The server leg is detached
 *   BEFORE the client leg is closed; after the kill, client-to-server
 *   bytes are silently discarded and counted, and NOTHING - no data, no
 *   FIN, no RST, no close frame - is sent server-ward until an explicit
 *   tidy (SCENARIO A). Mode 'fin' ends the client leg with a bare TCP
 *   FIN; mode 'close-frame' writes one unmasked close frame (1001)
 *   client-ward first. The mode used is logged.
 * - Deliver (POST /deliver): the server-SEEN drop for SCENARIO B. The
 *   client leg is ended and the close IS delivered server-ward: mode
 *   'close-frame' writes one masked close frame (1001) server-ward,
 *   mode 'fin' sends a bare FIN. The mode used is logged.
 * - Tidy (POST /tidy): closes the detached server leg of a killed
 *   connection; intended for after the no-OPEN decision point, logged.
 * - /config interception (MEDIA CONTAINMENT): GET /config responses are
 *   buffered, the iceServers field value is replaced with an empty
 *   array, and the body re-serialized. Exactly one route, exactly one
 *   field; every other route and the served bundle pass byte-identical.
 *   Any surprise (non-JSON, missing field, unframed body) fails CLOSED:
 *   logged and both legs closed.
 * - Frame log: ndjson, one event per line, append+flush, mirrored to
 *   stdout (the tester learns R - the replacement connection's 101
 *   completion - from this log as it happens). Derived events are
 *   labeled derived: 'open-frame' (a text frame carrying
 *   {"type":"OPEN"}) and 'decision-point' (first post-101 client
 *   HEARTBEAT forwarded with no preceding OPEN on that connection).
 *   Raw frames remain the primary evidence; derived events only index
 *   them. Heartbeat forward timestamps are recorded per connection;
 *   the last one is the server's last received heartbeat.
 *
 * The timed actions of the ACTION PROTOCOL (the R+10 press, the button
 * readings, the R+45 visitor launch, the kill/deliver/tidy calls) are
 * performed by the human tester through the control endpoint and the
 * live log - the entity is NAMED here per the plan's execution
 * dependencies; nothing is scripted. The DOM checkpoint is the tester's
 * DevTools console read of document.getElementById('call').disabled and
 * .textContent, evidenced by screenshot.
 *
 * Plain HTTP/1.1 only, both legs (stated, not assumed: under TLS the
 * capture could not see frames). No TLS, no outside hosts: the target
 * is a local server and the proxy refuses non-loopback targets.
 *
 * Provenance: preparation approved by the owner's option 1 (ask
 * phonemsg-01M6D4JJQG5Q2NJSJXDFBF0QQ2 7:24:17 PM -> "1"
 * phonemsg-01M6D4KZFKK76M9FNPJBSSFRTR 7:25:02 PM). Preparation only:
 * any run needs its own fresh owner yes. No pinto code changes.
 */

import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import {
  WsFrameParser,
  MessageReassembler,
  encodeFrame,
  OPCODES
} from './ws-frame-parser.mjs'

const HEAD_CAP = 64 * 1024
const TEXT_LOG_CAP = 16 * 1024
const CLOSE_1001 = Buffer.from([0x03, 0xe9])

function now() {
  return new Date().toISOString()
}

/** Incremental chunked-body boundary scanner (pass-through; logs only). */
class ChunkedScanner {
  constructor() {
    this.buf = Buffer.alloc(0)
    this.state = 'size' // size | data | data-crlf | trailers | done
    this.remaining = 0
  }

  /**
   * Feed bytes; returns true once the terminal chunk + trailers ended.
   * @param {Buffer} chunk
   */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    for (;;) {
      if (this.state === 'size') {
        const eol = this.buf.indexOf('\r\n')
        if (eol === -1) return false
        const sizeText = this.buf.subarray(0, eol).toString('latin1')
        const size = Number.parseInt(sizeText.split(';')[0], 16)
        if (!Number.isSafeInteger(size)) {
          throw new Error(`bad chunk size ${JSON.stringify(sizeText)}`)
        }
        this.buf = this.buf.subarray(eol + 2)
        if (size === 0) {
          this.state = 'trailers'
        } else {
          this.remaining = size
          this.state = 'data'
        }
      } else if (this.state === 'data') {
        if (this.buf.length < this.remaining + 2) return false
        this.buf = this.buf.subarray(this.remaining + 2) // data + CRLF
        this.state = 'size'
      } else if (this.state === 'trailers') {
        // Terminal chunk: trailers end at an empty line
        const end = this.buf.indexOf('\r\n')
        if (end === -1) return false
        if (end === 0) {
          this.state = 'done'
          return true
        }
        this.buf = this.buf.subarray(end + 2)
      } else {
        return true
      }
    }
  }
}

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

/**
 * @param {string} text
 * @returns {{ start: string, headers: Array<[string, string]> }}
 */
function parseHead(text) {
  const lines = text.split('\r\n')
  const start = lines[0]
  /** @type {Array<[string, string]>} */
  const headers = []
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':')
    if (colon === -1) continue
    headers.push([
      lines[i].slice(0, colon).trim().toLowerCase(),
      lines[i].slice(colon + 1).trim()
    ])
  }
  return { start, headers }
}

/**
 * @param {Array<[string, string]>} headers
 * @param {string} name
 */
function headerValue(headers, name) {
  for (const [k, v] of headers) if (k === name) return v
  return undefined
}

class Connection {
  /**
   * @param {{ connSeq: number }} proxy
   * @param {import('node:net').Socket} clientSock
   * @param {string} page
   */
  constructor(proxy, clientSock, page) {
    this.proxy = proxy
    this.id = ++proxy.connSeq
    this.page = page
    this.clientSock = clientSock
    /** @type {import('node:net').Socket | null} */
    this.upstreamSock = null
    this.kind = 'http' // http | peer | socketio | other-upgrade
    this.killed = false
    this.tidied = false
    this.forwardCS = true // client -> server
    this.forwardSC = true // server -> client
    this.discardedCS = 0
    this.discardedSC = 0
    this.seenOpen = false
    this.decisionLogged = false
    /** @type {string | null} */
    this.lastHeartbeatForwarded = null
    /** @type {number | null} */
    this.rTs = null // 101 completion timestamp (R for a replacement conn)
    /** @type {Array<{ method: string | null, url?: string | null, isConfig: boolean }>} */
    this.pending = [] // FIFO of in-flight requests awaiting responses
    this.clientBuf = Buffer.alloc(0)
    this.clientState = 'head' // head | body-length | body-chunked | websocket
    this.clientRemaining = 0
    /** @type {ChunkedScanner | null} */
    this.clientChunked = null
    this.upstreamBuf = Buffer.alloc(0)
    this.upstreamState = 'head' // head | body-length | body-chunked | body-close | config-body | websocket | ws-101-head
    this.upstreamRemaining = 0
    /** @type {ChunkedScanner | null} */
    this.upstreamChunked = null
    /** @type {{ headText: string, headers: Array<[string, string]>, status: number, body: Buffer, chunkedScanner: ChunkedScanner | null, total: number | null } | null} */
    this.configCollect = null
    /** @type {WsFrameParser | null} */
    this.wsParserCS = null
    /** @type {WsFrameParser | null} */
    this.wsParserSC = null
    /** @type {MessageReassembler | null} */
    this.reasmCS = null
    /** @type {MessageReassembler | null} */
    this.reasmSC = null
    this.closed = false
  }
}

/**
 * @param {{
 *   targetHost?: string,
 *   targetPort?: number,
 *   pages?: Array<{ label: string, port: number }>,
 *   controlPort?: number,
 *   logPath?: string | null,
 *   onEvent?: ((ev: Record<string, unknown>) => void) | null,
 *   quiet?: boolean
 * }} options
 */
export function startProxy({
  targetHost = '127.0.0.1',
  targetPort,
  pages, // [{ label, port }]
  controlPort,
  logPath = null,
  onEvent = null,
  quiet = false
}) {
  if (targetPort == null || !pages?.length || controlPort == null) {
    throw new Error('targetPort, pages and controlPort are required')
  }
  if (targetHost !== '127.0.0.1' && targetHost !== 'localhost') {
    throw new Error('refusing non-loopback target (local-only containment)')
  }

  const proxy = {
    connSeq: 0,
    /** @type {Map<number, Connection>} */
    conns: new Map(),
    /** @type {Array<import('node:net').Server>} */
    servers: [],
    /** @type {import('node:http').Server | null} */
    control: null,
    /** @type {import('node:fs').WriteStream | null} */
    logStream: null,
    closed: false
  }

  /** @param {Record<string, unknown>} ev */
  function emit(ev) {
    const line = JSON.stringify({ ts: now(), ...ev })
    if (proxy.logStream) proxy.logStream.write(line + '\n')
    if (!quiet) process.stdout.write(line + '\n')
    if (onEvent) onEvent(ev)
  }

  if (logPath) {
    proxy.logStream = fs.createWriteStream(logPath, { flags: 'wx' })
  }

  /**
   * @param {Connection} conn
   * @param {string} dir
   * @param {{ opcode: number, fin: boolean, rsv1: boolean, len: number }} frame
   * @param {import('./ws-frame-parser.mjs').Message | null} message
   */
  function logFrame(conn, dir, frame, message) {
    /** @type {Record<string, unknown>} */
    const ev = {
      ev: 'ws-frame',
      conn: conn.id,
      dir,
      opcode: frame.opcode,
      fin: frame.fin,
      rsv1: frame.rsv1,
      len: frame.len
    }
    if (message && message.opcode === OPCODES.TEXT) {
      const text = message.payload.toString('utf8')
      ev.text = text.length > TEXT_LOG_CAP ? text.slice(0, TEXT_LOG_CAP) : text
      ev.textTruncated = text.length > TEXT_LOG_CAP
    } else if (message) {
      ev.payloadHex = message.payload.toString('hex')
    }
    emit(ev)
  }

  /**
   * @param {Connection} conn
   * @param {string} dir
   * @param {import('./ws-frame-parser.mjs').Message} message
   */
  function inspectPeerMessage(conn, dir, message) {
    if (conn.kind !== 'peer' || message.opcode !== OPCODES.TEXT) return
    let type
    try {
      /** @type {unknown} */
      const parsed = JSON.parse(message.payload.toString('utf8'))
      type = readKey(parsed, 'type')
    } catch {
      return
    }
    if (dir === 'sc' && type === 'OPEN') {
      conn.seenOpen = true
      emit({ ev: 'open-frame', conn: conn.id, derived: true })
    }
    if (dir === 'cs' && type === 'HEARTBEAT') {
      conn.lastHeartbeatForwarded = now()
      emit({
        ev: 'heartbeat-forwarded',
        conn: conn.id,
        at: conn.lastHeartbeatForwarded
      })
      if (!conn.seenOpen && !conn.decisionLogged) {
        conn.decisionLogged = true
        emit({
          ev: 'decision-point',
          conn: conn.id,
          derived: true,
          result: 'no-open-resume',
          rPlusMs: conn.rTs ? Date.now() - conn.rTs : null
        })
      }
    }
  }

  /**
   * @param {Connection} conn
   * @param {string} dir
   * @param {Buffer} chunk
   */
  function teeWs(conn, dir, chunk) {
    const parser = dir === 'cs' ? conn.wsParserCS : conn.wsParserSC
    const reasm = dir === 'cs' ? conn.reasmCS : conn.reasmSC
    let frames
    try {
      frames = parser.push(chunk)
      const messages = reasm.push(frames)
      for (const f of frames) logFrame(conn, dir, f, null)
      for (const m of messages) {
        logFrame(conn, dir, { ...m, fin: true, len: m.payload.length }, m)
        inspectPeerMessage(conn, dir, m)
      }
    } catch (error) {
      // Parsing is a tee: never block forwarding on a parse failure
      emit({
        ev: 'parse-error',
        conn: conn.id,
        dir,
        error: String(error && error.message)
      })
      const fresh = new WsFrameParser()
      const freshReasm = new MessageReassembler()
      if (dir === 'cs') {
        conn.wsParserCS = fresh
        conn.reasmCS = freshReasm
      } else {
        conn.wsParserSC = fresh
        conn.reasmSC = freshReasm
      }
    }
  }

  /**
   * @param {Connection} conn
   * @param {() => void} onReady
   */
  function connectUpstream(conn, onReady) {
    const up = net.connect(targetPort, targetHost)
    conn.upstreamSock = up
    up.on('connect', () => {
      emit({ ev: 'upstream-connect', conn: conn.id })
      onReady()
    })
    up.on('data', (chunk) => {
      onUpstreamData(conn, chunk)
    })
    up.on('end', () => {
      emit({ ev: 'upstream-end', conn: conn.id })
      if (conn.killed || conn.closed) return
      conn.clientSock.end()
    })
    up.on('error', (error) => {
      emit({ ev: 'upstream-error', conn: conn.id, error: String(error) })
      if (conn.killed || conn.closed) return
      conn.clientSock.destroy()
    })
    up.on('close', () => {
      emit({ ev: 'upstream-close', conn: conn.id })
      conn.closed = true
    })
  }

  /** @param {string} pathname */
  function classifyUpgrade(pathname) {
    if (pathname === '/peerjs') return 'peer'
    if (pathname.startsWith('/socket.io/')) return 'socketio'
    return 'other-upgrade'
  }

  /**
   * @param {Connection} conn
   * @param {string} headText
   * @param {Buffer} headBytes
   * @param {Buffer} leftover
   */
  function handleUpgrade(conn, headText, headBytes, leftover) {
    const { start } = parseHead(headText)
    const target = start.split(' ')[1] || ''
    let pathname = target
    let query = {}
    try {
      const url = new URL(target, 'http://localhost')
      pathname = url.pathname
      query = Object.fromEntries(url.searchParams.entries())
    } catch {
      // keep raw pathname
    }
    conn.kind = classifyUpgrade(pathname)
    conn.clientState = 'websocket'
    conn.upstreamState = 'ws-101-head'
    conn.wsParserCS = new WsFrameParser()
    conn.wsParserSC = new WsFrameParser()
    conn.reasmCS = new MessageReassembler()
    conn.reasmSC = new MessageReassembler()
    emit({
      ev: 'upgrade',
      conn: conn.id,
      kind: conn.kind,
      url: target,
      hasKey: 'key' in query,
      hasId: 'id' in query,
      hasToken: 'token' in query
    })
    connectUpstream(conn, () => {
      conn.upstreamSock.write(headBytes)
      if (leftover.length) onClientData(conn, leftover)
    })
  }

  /**
   * @param {Connection} conn
   * @param {Buffer} chunk
   */
  function onClientData(conn, chunk) {
    if (conn.closed) return
    if (!conn.forwardCS) {
      conn.discardedCS += chunk.length
      emit({
        ev: 'discard',
        conn: conn.id,
        dir: 'cs',
        bytes: chunk.length,
        total: conn.discardedCS
      })
      return
    }
    if (conn.clientState === 'websocket') {
      teeWs(conn, 'cs', chunk)
      conn.upstreamSock.write(chunk)
      return
    }
    conn.clientBuf = conn.clientBuf.length
      ? Buffer.concat([conn.clientBuf, chunk])
      : chunk
    for (;;) {
      if (conn.clientState === 'head') {
        const end = conn.clientBuf.indexOf('\r\n\r\n')
        if (end === -1) {
          if (conn.clientBuf.length > HEAD_CAP) {
            emit({ ev: 'error', conn: conn.id, error: 'request head over cap' })
            conn.clientSock.destroy()
          }
          return
        }
        const headBytes = conn.clientBuf.subarray(0, end + 4)
        const headText = headBytes.toString('latin1')
        conn.clientBuf = conn.clientBuf.subarray(end + 4)
        const { start, headers } = parseHead(headText)
        const [method, target] = start.split(' ')
        let pathname = target || ''
        try {
          pathname = new URL(target, 'http://localhost').pathname
        } catch {
          // keep raw
        }
        const isUpgrade =
          /\bupgrade\b/i.test(headerValue(headers, 'connection') || '') &&
          (headerValue(headers, 'upgrade') || '').toLowerCase() === 'websocket'
        emit({ ev: 'request', conn: conn.id, method, url: target })
        if (isUpgrade) {
          handleUpgrade(conn, headText, headBytes, conn.clientBuf)
          return
        }
        const isConfig = method === 'GET' && pathname === '/config'
        conn.pending.push({ method, url: target, isConfig })
        if (!conn.upstreamSock) {
          const body = Buffer.from(conn.clientBuf)
          conn.clientBuf = Buffer.alloc(0)
          const { headers: h } = { headers }
          const len = Number(headerValue(h, 'content-length') || 0)
          connectUpstream(conn, () => {
            conn.upstreamSock.write(headBytes)
            if (body.length) onClientBodyBytes(conn, body)
          })
          conn.clientState = len > 0 ? 'body-length' : 'head'
          conn.clientRemaining = len
          if (headerValue(headers, 'transfer-encoding') === 'chunked') {
            conn.clientState = 'body-chunked'
            conn.clientChunked = new ChunkedScanner()
          }
          return
        }
        conn.upstreamSock.write(headBytes)
        const len = Number(headerValue(headers, 'content-length') || 0)
        if (headerValue(headers, 'transfer-encoding') === 'chunked') {
          conn.clientState = 'body-chunked'
          conn.clientChunked = new ChunkedScanner()
        } else if (len > 0) {
          conn.clientState = 'body-length'
          conn.clientRemaining = len
        } else {
          conn.clientState = 'head'
        }
      } else if (conn.clientState === 'body-length') {
        const take = Math.min(conn.clientRemaining, conn.clientBuf.length)
        if (take === 0) return
        const part = conn.clientBuf.subarray(0, take)
        conn.clientBuf = conn.clientBuf.subarray(take)
        conn.clientRemaining -= take
        conn.upstreamSock.write(part)
        if (conn.clientRemaining > 0) return
        conn.clientState = 'head'
      } else if (conn.clientState === 'body-chunked') {
        if (conn.clientBuf.length === 0) return
        const part = conn.clientBuf
        conn.clientBuf = Buffer.alloc(0)
        let done = false
        try {
          done = conn.clientChunked.push(part)
        } catch (error) {
          emit({ ev: 'error', conn: conn.id, error: String(error.message) })
        }
        conn.upstreamSock.write(part)
        if (!done) return
        conn.clientState = 'head'
      } else {
        return
      }
    }
  }

  /**
   * @param {Connection} conn
   * @param {Buffer} bytes
   */
  function onClientBodyBytes(conn, bytes) {
    conn.clientBuf = bytes
    const state = conn.clientState
    if (state === 'body-length' && conn.clientRemaining > 0) {
      const take = Math.min(conn.clientRemaining, conn.clientBuf.length)
      const part = conn.clientBuf.subarray(0, take)
      conn.clientBuf = conn.clientBuf.subarray(take)
      conn.clientRemaining -= take
      conn.upstreamSock.write(part)
      if (conn.clientRemaining === 0) conn.clientState = 'head'
    }
    if (conn.clientBuf.length) onClientData(conn, Buffer.alloc(0))
  }

  /**
   * @param {Connection} conn
   * @param {Buffer} chunk
   */
  function onUpstreamData(conn, chunk) {
    if (!conn.forwardSC) {
      conn.discardedSC += chunk.length
      emit({
        ev: 'discard',
        conn: conn.id,
        dir: 'sc',
        bytes: chunk.length,
        total: conn.discardedSC
      })
      return
    }
    if (conn.upstreamState === 'websocket') {
      teeWs(conn, 'sc', chunk)
      conn.clientSock.write(chunk)
      return
    }
    conn.upstreamBuf = conn.upstreamBuf.length
      ? Buffer.concat([conn.upstreamBuf, chunk])
      : chunk
    for (;;) {
      if (conn.upstreamState === 'ws-101-head') {
        const end = conn.upstreamBuf.indexOf('\r\n\r\n')
        if (end === -1) {
          if (conn.upstreamBuf.length > HEAD_CAP) {
            emit({ ev: 'error', conn: conn.id, error: '101 head over cap' })
            conn.clientSock.destroy()
          }
          return
        }
        const headBytes = conn.upstreamBuf.subarray(0, end + 4)
        const leftover = conn.upstreamBuf.subarray(end + 4)
        const { start, headers } = parseHead(headBytes.toString('latin1'))
        conn.rTs = Date.now()
        emit({
          ev: 'ws-101',
          conn: conn.id,
          status: start,
          extensions: headerValue(headers, 'sec-websocket-extensions') || null
        })
        conn.upstreamBuf = Buffer.alloc(0)
        conn.upstreamState = 'websocket'
        conn.clientSock.write(headBytes)
        // Leftover bytes after the 101 head are already frame bytes -
        // this is where an OPEN coalesced with the 101 is captured
        if (leftover.length) {
          teeWs(conn, 'sc', leftover)
          conn.clientSock.write(leftover)
        }
        return
      } else if (conn.upstreamState === 'head') {
        const end = conn.upstreamBuf.indexOf('\r\n\r\n')
        if (end === -1) {
          if (conn.upstreamBuf.length > HEAD_CAP) {
            emit({
              ev: 'error',
              conn: conn.id,
              error: 'response head over cap'
            })
            conn.clientSock.destroy()
          }
          return
        }
        const headBytes = conn.upstreamBuf.subarray(0, end + 4)
        const headText = headBytes.toString('latin1')
        conn.upstreamBuf = conn.upstreamBuf.subarray(end + 4)
        const { start, headers } = parseHead(headText)
        const req = conn.pending.shift() || { method: null, isConfig: false }
        const status = Number(start.split(' ')[1] || 0)
        emit({
          ev: 'response',
          conn: conn.id,
          status,
          for: req.url || null,
          contentLength: headerValue(headers, 'content-length') || null,
          transferEncoding: headerValue(headers, 'transfer-encoding') || null
        })
        const noBody =
          (status >= 100 && status < 200) || status === 204 || status === 304
        const len = Number(headerValue(headers, 'content-length') || 0)
        const chunked = headerValue(headers, 'transfer-encoding') === 'chunked'
        if (req.isConfig && !noBody) {
          conn.configCollect = {
            headText,
            headers,
            status,
            body: Buffer.alloc(0),
            chunkedScanner: chunked ? new ChunkedScanner() : null,
            total: chunked ? null : len
          }
          conn.upstreamState = 'config-body'
        } else if (noBody || (!chunked && len === 0 && status !== 200)) {
          conn.clientSock.write(headBytes)
          conn.upstreamState = 'head'
        } else if (chunked) {
          conn.clientSock.write(headBytes)
          conn.upstreamState = 'body-chunked'
          conn.upstreamChunked = new ChunkedScanner()
        } else if (headerValue(headers, 'content-length') !== undefined) {
          conn.clientSock.write(headBytes)
          conn.upstreamState = 'body-length'
          conn.upstreamRemaining = len
          if (len === 0) conn.upstreamState = 'head'
        } else {
          conn.clientSock.write(headBytes)
          conn.upstreamState = 'body-close'
        }
      } else if (conn.upstreamState === 'body-length') {
        const take = Math.min(conn.upstreamRemaining, conn.upstreamBuf.length)
        if (take === 0) return
        const part = conn.upstreamBuf.subarray(0, take)
        conn.upstreamBuf = conn.upstreamBuf.subarray(take)
        conn.upstreamRemaining -= take
        conn.clientSock.write(part)
        if (conn.upstreamRemaining > 0) return
        conn.upstreamState = 'head'
      } else if (conn.upstreamState === 'body-chunked') {
        if (conn.upstreamBuf.length === 0) return
        const part = conn.upstreamBuf
        conn.upstreamBuf = Buffer.alloc(0)
        let done = false
        try {
          done = conn.upstreamChunked.push(part)
        } catch (error) {
          emit({ ev: 'error', conn: conn.id, error: String(error.message) })
        }
        conn.clientSock.write(part)
        if (!done) return
        conn.upstreamState = 'head'
      } else if (conn.upstreamState === 'body-close') {
        conn.clientSock.write(conn.upstreamBuf)
        conn.upstreamBuf = Buffer.alloc(0)
        return
      } else if (conn.upstreamState === 'config-body') {
        if (conn.upstreamBuf.length === 0) return
        const cc = conn.configCollect
        const part = conn.upstreamBuf
        conn.upstreamBuf = Buffer.alloc(0)
        let done
        if (cc.chunkedScanner) {
          try {
            done = cc.chunkedScanner.push(part)
          } catch (error) {
            emit({
              ev: 'config-intercept-fail',
              conn: conn.id,
              error: String(error.message)
            })
            conn.clientSock.destroy()
            conn.upstreamSock.destroy()
            return
          }
          cc.body = Buffer.concat([cc.body, part])
        } else {
          cc.body = Buffer.concat([cc.body, part])
          done = cc.body.length >= cc.total
        }
        if (!done) return
        interceptConfig(conn)
        conn.upstreamState = 'head'
      } else {
        return
      }
    }
  }

  /** @param {Connection} conn */
  function interceptConfig(conn) {
    const cc = conn.configCollect
    conn.configCollect = null
    let raw = cc.body
    if (cc.chunkedScanner) {
      // De-chunk the collected body
      const chunks = []
      let buf = raw
      for (;;) {
        const eol = buf.indexOf('\r\n')
        if (eol === -1) break
        const size = Number.parseInt(
          buf.subarray(0, eol).toString('latin1').split(';')[0],
          16
        )
        if (!Number.isSafeInteger(size)) break
        if (size === 0) break
        chunks.push(buf.subarray(eol + 2, eol + 2 + size))
        buf = buf.subarray(eol + 2 + size + 2)
      }
      raw = Buffer.concat(chunks)
    }
    /** @type {unknown} */
    let json
    try {
      json = JSON.parse(raw.toString('utf8'))
    } catch (/** @type {unknown} */ error) {
      emit({
        ev: 'config-intercept-fail',
        conn: conn.id,
        error: `non-JSON /config body: ${error instanceof Error ? error.message : String(error)}`
      })
      conn.clientSock.destroy()
      conn.upstreamSock.destroy()
      return
    }
    if (!json || typeof json !== 'object' || !('iceServers' in json)) {
      emit({
        ev: 'config-intercept-fail',
        conn: conn.id,
        error: 'no iceServers field in /config body'
      })
      conn.clientSock.destroy()
      conn.upstreamSock.destroy()
      return
    }
    const beforeCount = Array.isArray(json.iceServers)
      ? json.iceServers.length
      : null
    json.iceServers = []
    const body = Buffer.from(JSON.stringify(json), 'utf8')
    const kept = cc.headers.filter(
      ([k]) => k !== 'content-length' && k !== 'transfer-encoding'
    )
    const head =
      cc.headText.split('\r\n')[0] +
      '\r\n' +
      kept.map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      `\r\ncontent-length: ${String(body.length)}\r\n\r\n`
    emit({
      ev: 'config-intercept',
      conn: conn.id,
      page: conn.page,
      iceServersBefore: beforeCount,
      iceServersAfter: 0
    })
    conn.clientSock.write(Buffer.concat([Buffer.from(head, 'latin1'), body]))
  }

  /**
   * @param {Connection} conn
   * @param {string} mode
   */
  function kill(conn, mode) {
    if (conn.kind !== 'peer') return { error: 'kill is for peer conns only' }
    if (conn.killed) return { error: 'already killed' }
    if (conn.clientState !== 'websocket') {
      return { error: 'connection is not an established websocket' }
    }
    conn.killed = true
    conn.forwardCS = false
    conn.forwardSC = false
    emit({ ev: 'kill', conn: conn.id, mode })
    // The server leg is detached BEFORE the client leg is closed: nothing
    // further is written server-ward, and the client close never pipes
    if (mode === 'close-frame') {
      conn.clientSock.write(
        encodeFrame({ opcode: OPCODES.CLOSE, payload: CLOSE_1001 })
      )
    }
    conn.clientSock.end()
    emit({ ev: 'kill-done', conn: conn.id, mode })
    return { ok: true }
  }

  /**
   * @param {Connection} conn
   * @param {string} mode
   */
  function deliver(conn, mode) {
    if (conn.kind !== 'peer') return { error: 'deliver is for peer conns only' }
    if (conn.killed) return { error: 'already ended' }
    if (conn.clientState !== 'websocket') {
      return { error: 'connection is not an established websocket' }
    }
    conn.killed = true
    conn.forwardCS = false
    conn.forwardSC = false
    emit({ ev: 'deliver', conn: conn.id, mode })
    if (mode === 'close-frame') {
      conn.upstreamSock.write(
        encodeFrame({ opcode: OPCODES.CLOSE, payload: CLOSE_1001, mask: true })
      )
      emit({ ev: 'deliver-close-frame-sent', conn: conn.id })
    } else {
      conn.upstreamSock.end()
      emit({ ev: 'deliver-fin-sent', conn: conn.id })
    }
    conn.clientSock.end()
    return { ok: true }
  }

  /** @param {Connection} conn */
  function tidy(conn) {
    if (!conn.killed) return { error: 'not killed' }
    if (conn.tidied) return { error: 'already tidied' }
    conn.tidied = true
    emit({ ev: 'tidy', conn: conn.id })
    if (!conn.upstreamSock.destroyed) conn.upstreamSock.end()
    return { ok: true }
  }

  // Control endpoint (loopback only): the tester's named interface
  proxy.control = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const conn = proxy.conns.get(Number(url.searchParams.get('conn')))
    /** @param {number} code @param {object} obj */
    const answer = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (url.pathname === '/conns') {
      answer(200, {
        conns: [...proxy.conns.values()].map((c) => ({
          id: c.id,
          page: c.page,
          kind: c.kind,
          killed: c.killed,
          tidied: c.tidied,
          seenOpen: c.seenOpen,
          lastHeartbeatForwarded: c.lastHeartbeatForwarded
        }))
      })
      return
    }
    if (!conn) {
      answer(404, { error: 'unknown conn' })
      return
    }
    if (req.method !== 'POST') {
      answer(405, { error: 'POST only' })
      return
    }
    if (url.pathname === '/kill') {
      answer(200, kill(conn, url.searchParams.get('mode') || 'fin'))
      return
    }
    if (url.pathname === '/deliver') {
      answer(200, deliver(conn, url.searchParams.get('mode') || 'close-frame'))
      return
    }
    if (url.pathname === '/tidy') {
      answer(200, tidy(conn))
      return
    }
    answer(404, { error: 'unknown control path' })
  })

  const ready = []
  for (const { label, port } of pages) {
    const server = net.createServer((clientSock) => {
      const conn = new Connection(proxy, clientSock, label)
      proxy.conns.set(conn.id, conn)
      emit({ ev: 'connect', conn: conn.id, page: label })
      clientSock.on('data', (chunk) => {
        onClientData(conn, chunk)
      })
      clientSock.on('end', () => {
        emit({ ev: 'client-end', conn: conn.id })
        if (conn.killed || conn.closed) return
        if (conn.upstreamSock && !conn.upstreamSock.destroyed) {
          conn.upstreamSock.end()
        }
      })
      clientSock.on('error', (error) => {
        emit({ ev: 'client-error', conn: conn.id, error: String(error) })
        if (conn.killed || conn.closed) return
        if (conn.upstreamSock) conn.upstreamSock.destroy()
      })
      clientSock.on('close', () => {
        emit({ ev: 'client-close', conn: conn.id })
      })
    })
    proxy.servers.push(server)
    ready.push(
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          emit({ ev: 'listen', page: label, port })
          resolve()
        })
      })
    )
  }
  ready.push(
    new Promise((resolve, reject) => {
      proxy.control.once('error', reject)
      proxy.control.listen(controlPort, '127.0.0.1', () => {
        emit({ ev: 'control-listen', port: controlPort })
        resolve()
      })
    })
  )

  return Promise.all(ready).then(() => ({
    proxy,
    emit,
    close() {
      for (const c of proxy.conns.values()) {
        c.clientSock.destroy()
        if (c.upstreamSock) c.upstreamSock.destroy()
      }
      for (const s of proxy.servers) s.close()
      proxy.control.close()
      if (proxy.logStream) proxy.logStream.end()
    }
  }))
}

/**
 * @param {Array<string>} argv
 */
function parseArgs(argv) {
  /** @type {{ pages: Array<{ label: string, port: number }>, targetHost?: string, targetPort?: number, controlPort?: number, logPath?: string }} */
  const args = { pages: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target-host') args.targetHost = argv[++i]
    else if (a === '--target-port') args.targetPort = Number(argv[++i])
    else if (a === '--page') {
      const [label, port] = argv[++i].split(':')
      args.pages.push({ label, port: Number(port) })
    } else if (a === '--control-port') args.controlPort = Number(argv[++i])
    else if (a === '--log') args.logPath = argv[++i]
    else throw new Error(`unknown argument ${a}`)
  }
  return args
}

if (process.argv[1] && process.argv[1].endsWith('row51-proxy.mjs')) {
  const args = parseArgs(process.argv.slice(2))
  startProxy(args).catch((/** @type {unknown} */ error) => {
    console.error(error)
    process.exit(1)
  })
}
