/**
 * Incremental WebSocket frame parser + serializer for the row 51
 * observation proxy. Feed arbitrary byte chunks, get complete frames
 * back; MessageReassembler folds fragmented messages. No dependencies.
 *
 * Provenance: authored as planned test tooling under the reviewed row 51
 * verification plan (sha1 9cf07f0514cece342e8bb6515f772240bb78dfc1 -
 * the proxy "is planned test tooling: separately subject to the
 * project's existing code and test rules"). Tooling preparation approved
 * by the owner's option 1 (ask phonemsg-01M6D4JJQG5Q2NJSJXDFBF0QQ2
 * 7:24:17 PM -> "1" phonemsg-01M6D4KZFKK76M9FNPJBSSFRTR 7:25:02 PM).
 * Preparation only: any run needs its own fresh owner yes. No pinto
 * code changes.
 */

import { randomBytes } from 'node:crypto'

export const OPCODES = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa
}

const MAX_PAYLOAD = 64 * 1024 * 1024

export class WsFrameParser {
  constructor() {
    this.buf = Buffer.alloc(0)
  }

  /** Feed bytes; returns an array of complete frames. */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const frames = []
    for (;;) {
      const frame = this.#tryParse()
      if (!frame) break
      frames.push(frame)
    }
    return frames
  }

  #tryParse() {
    const b = this.buf
    if (b.length < 2) return null
    const fin = (b[0] & 0x80) !== 0
    const rsv1 = (b[0] & 0x40) !== 0
    const opcode = b[0] & 0x0f
    const masked = (b[1] & 0x80) !== 0
    const len7 = b[1] & 0x7f
    let offset = 2
    let len = len7
    if (len7 === 126) {
      if (b.length < offset + 2) return null
      len = b.readUInt16BE(offset)
      offset += 2
    } else if (len7 === 127) {
      if (b.length < offset + 8) return null
      len = Number(b.readBigUInt64BE(offset))
      offset += 8
    }
    if (!Number.isSafeInteger(len) || len > MAX_PAYLOAD) {
      throw new Error(`frame payload length ${String(len)} over cap`)
    }
    let maskKey = null
    if (masked) {
      if (b.length < offset + 4) return null
      maskKey = b.subarray(offset, offset + 4)
      offset += 4
    }
    if (b.length < offset + len) return null
    let payload = Buffer.from(b.subarray(offset, offset + len))
    if (masked) {
      for (let i = 0; i < len; i++) payload[i] ^= maskKey[i & 3]
    }
    this.buf = b.subarray(offset + len)
    return { fin, rsv1, opcode, masked, len, payload }
  }
}

/** Folds fragmented messages; control frames pass through complete. */
export class MessageReassembler {
  constructor() {
    this.frag = null
  }

  /** Feed frames from WsFrameParser; returns complete messages. */
  push(frames) {
    const messages = []
    for (const f of frames) {
      if (f.opcode === OPCODES.CONTINUATION) {
        if (!this.frag) throw new Error('continuation without start')
        this.frag.parts.push(f.payload)
        if (f.fin) {
          messages.push({
            opcode: this.frag.opcode,
            rsv1: this.frag.rsv1,
            payload: Buffer.concat(this.frag.parts)
          })
          this.frag = null
        }
      } else if (f.opcode === OPCODES.TEXT || f.opcode === OPCODES.BINARY) {
        if (this.frag) {
          throw new Error('new data message before continuation finished')
        }
        if (f.fin) {
          messages.push({ opcode: f.opcode, rsv1: f.rsv1, payload: f.payload })
        } else {
          this.frag = { opcode: f.opcode, rsv1: f.rsv1, parts: [f.payload] }
        }
      } else {
        messages.push({ opcode: f.opcode, rsv1: f.rsv1, payload: f.payload })
      }
    }
    return messages
  }
}

/**
 * Serialize one frame. mask: false (server-to-client) or true (a random
 * client mask key); client-to-server frames must be masked per RFC 6455.
 */
export function encodeFrame({
  fin = true,
  rsv1 = false,
  opcode,
  payload = Buffer.alloc(0),
  mask = false
}) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode
  if (!mask) return Buffer.concat([header, payload])
  const key = randomBytes(4)
  header[1] |= 0x80
  const masked = Buffer.from(payload)
  for (let i = 0; i < len; i++) masked[i] ^= key[i & 3]
  return Buffer.concat([header, key, masked])
}
