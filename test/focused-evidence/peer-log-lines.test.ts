import assert from 'node:assert/strict'
import { test } from 'node:test'
import WebSocket from 'ws'
import { appendFileSync } from 'node:fs'
import { startServer } from './helpers.ts'

test('peer connection and disconnect IDs cannot add log lines', async () => {
  const server = await startServer()
  try {
    for (const [id, expected] of [
      ['plain-id', 'plain-id'],
      ['line\nMARKER\r\\', 'line\\nMARKER\\r\\\\']
    ]) {
      const from = server.output().length
      const url = new URL(server.url.replace('http:', 'ws:') + '/peerjs')
      url.searchParams.set('key', 'pinto')
      url.searchParams.set('id', id)
      url.searchParams.set('token', 'controlled-test-token')
      const ws = new WebSocket(url)
      try {
        await new Promise<void>((resolve, reject) => {
          const opened = () => {
            ws.off('error', failed)
            resolve()
          }
          const failed = (error: Error) => {
            ws.off('open', opened)
            reject(error)
          }
          ws.once('open', opened)
          ws.once('error', failed)
        })
        await server.waitForOutput(`PeerClient connected: ${expected}`, from)
        const disconnected = new Promise<void>((resolve, reject) => {
          const closed = () => {
            ws.off('error', failed)
            resolve()
          }
          const failed = (error: Error) => {
            ws.off('close', closed)
            reject(error)
          }
          ws.once('close', closed)
          ws.once('error', failed)
        })
        ws.close()
        await disconnected
        await server.waitForOutput(`PeerClient disconnected: ${expected}`, from)
        const lines = server.output().slice(from).split('\n')
        assert.equal(
          lines.filter((line) => line === `PeerClient connected: ${expected}`)
            .length,
          1
        )
        assert.equal(
          lines.filter(
            (line) => line === `PeerClient disconnected: ${expected}`
          ).length,
          1
        )
        assert.ok(!lines.some((line) => line.startsWith('MARKER')))
      } finally {
        // Persist actual emitted bytes independently of assertion outcome.
        try {
          const sink = process.env.PINTO_PEER_LOG_RECEIPT
          if (!sink) throw Error('Missing peer sink transcript path')
          const raw = server.output().slice(from)
          if (raw.length > 65536)
            throw Error('Peer sink transcript exceeds bounded receipt')
          appendFileSync(sink, JSON.stringify({ id, expected, raw }) + '\n')
        } finally {
          ws.terminate()
        }
      }
    }
  } finally {
    await server.stop()
  }
})
