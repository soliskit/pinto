import assert from 'node:assert/strict'
import { test } from 'node:test'
import WebSocket from 'ws'
import { appendFileSync } from 'node:fs'
import { startServer } from './helpers.ts'

function writePeerSink(
  server: Awaited<ReturnType<typeof startServer>>,
  from: number,
  id: string,
  expected: string
) {
  const sink = process.env.PINTO_PEER_LOG_RECEIPT
  if (!sink) throw Error('Missing peer sink transcript path')
  const raw = server.output().slice(from)
  if (raw.length > 65536)
    throw Error('Peer sink transcript exceeds bounded receipt')
  appendFileSync(sink, JSON.stringify({ id, expected, raw }) + '\n')
}

function throwFailures(errors: unknown[], message: string) {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1)
    throw new AggregateError(errors, message, { cause: errors[0] })
}

for (const [name, id, expected] of [
  ['plain peer ID is byte-identical in both log sinks', 'plain-id', 'plain-id'],
  [
    'peer line breaks cannot forge log lines',
    'line\nMARKER\r\\',
    'line\\nMARKER\\r\\\\'
  ],
  [
    'peer Arabic letter mark is escaped in both log sinks',
    'left\u061cright',
    'left\\u061cright'
  ]
]) {
  void test(name, async () => {
    const server = await startServer()
    const failures: unknown[] = []
    try {
      const from = server.output().length
      const url = new URL(server.url.replace('http:', 'ws:') + '/peerjs')
      url.searchParams.set('key', 'peerjs')
      url.searchParams.set('id', id)
      url.searchParams.set('token', 'controlled-test-token')
      const ws = new WebSocket(url)
      const attemptFailures: unknown[] = []
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
        await server.waitForOutput('PeerClient connected:', from)
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
        await server.waitForOutput('PeerClient disconnected:', from)
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
      } catch (operationError) {
        attemptFailures.push(operationError)
      }
      // Persist actual emitted bytes independently of assertion outcome.
      try {
        writePeerSink(server, from, id, expected)
      } catch (receiptError) {
        attemptFailures.push(receiptError)
      }
      try {
        ws.terminate()
      } catch (terminationError) {
        attemptFailures.push(terminationError)
      }
      throwFailures(attemptFailures, 'Peer operation or receipt cleanup failed')
    } catch (operationError) {
      failures.push(operationError)
    }
    try {
      await server.stop()
    } catch (stopError) {
      failures.push(stopError)
    }
    throwFailures(failures, 'Peer test or server cleanup failed')
  })
}
