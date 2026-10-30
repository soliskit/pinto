/**
 * Runs inside a user+network namespace: serves the app over HTTPS on the
 * default port (a self-signed TLS terminator in front of the app on port 80),
 * opens a room page and checks the PeerJS connection uses wss with no explicit
 * port, exercising the secure arm of the location.port fallback.
 * Prints FALLBACK-443-WSS <url> on success.
 */
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { setTimeout as sleep } from 'node:timers/promises'

// Self-signed certificate for 127.0.0.1, generated for this run only
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinto-test-certs-'))
const keyPath = path.join(dir, 'key.pem')
const certPath = path.join(dir, 'cert.pem')
const gen = spawnSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1'
  ],
  { stdio: 'ignore' }
)
if (gen.status !== 0) {
  console.log('openssl certificate generation failed')
  process.exit(1)
}

const app = spawn(process.execPath, ['src/index.ts'], {
  env: { ...process.env, PORT: '80' },
  stdio: ['ignore', 'ignore', 'ignore']
})
process.on('exit', () => app.kill('SIGKILL'))

import fs from 'node:fs'
import { readFileSync } from 'node:fs'
const tls = https.createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  (req, res) => {
    const proxy = http.request(
      {
        host: '127.0.0.1',
        port: 80,
        path: req.url,
        method: req.method,
        headers: req.headers
      },
      (pr) => {
        res.writeHead(pr.statusCode ?? 502, pr.headers)
        pr.pipe(res)
      }
    )
    proxy.on('error', () => {
      res.statusCode = 502
      res.end()
    })
    req.pipe(proxy)
  }
)
// Secure websocket attempts can fail; constructing the Peer is what executes the fallback
tls.on('upgrade', (socket) => socket.destroy())
tls.listen(443, '127.0.0.1')

const deadline = Date.now() + 15_000
for (;;) {
  try {
    if ((await fetch('http://127.0.0.1:80/')).ok) break
  } catch {
    // app not up yet
  }
  if (Date.now() > deadline) {
    console.log('app on port 80 never answered')
    process.exit(1)
  }
  await sleep(100)
}

const browser = await chromium.launch({
  args: ['--no-sandbox', '--ignore-certificate-errors']
})
const page = await browser.newPage()
const peerSockets = []
page.on('websocket', (ws) => {
  if (ws.url().includes('/peerjs')) peerSockets.push(ws.url())
})
await page.goto('https://127.0.0.1/room/default-port-https-check', {
  timeout: 15_000
})
const pageUrl = await page.evaluate(
  () => `${globalThis.location.protocol}//${globalThis.location.host}`
)
if (pageUrl !== 'https://127.0.0.1') {
  console.log('page was not https on the default port:', pageUrl)
  process.exit(1)
}
const wsDeadline = Date.now() + 15_000
while (peerSockets.length === 0) {
  if (Date.now() > wsDeadline) {
    console.log('no PeerJS websocket was attempted')
    process.exit(1)
  }
  await sleep(100)
}
const url = new URL(peerSockets[0])
console.log('FALLBACK-443-WSS', peerSockets[0])
await browser.close()
app.kill('SIGKILL')
process.exit(url.protocol === 'wss:' && url.port === '' ? 0 : 1)
