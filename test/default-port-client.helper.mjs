/**
 * Runs inside a user+network namespace: starts the server on port 80, opens a
 * room page and checks the PeerJS connection uses the default port (no explicit
 * port in the URL), exercising the location.port fallback.
 * Prints FALLBACK-80-WS <url> on success.
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { setTimeout as sleep } from 'node:timers/promises'

const server = spawn(process.execPath, ['src/index.ts'], {
  env: { ...process.env, PORT: '80' },
  stdio: ['ignore', 'ignore', 'ignore']
})
process.on('exit', () => server.kill('SIGKILL'))

// Wait for the server on the default port
const deadline = Date.now() + 15_000
for (;;) {
  try {
    if ((await fetch('http://127.0.0.1/')).ok) break
  } catch {
    // server not up yet
  }
  if (Date.now() > deadline) {
    console.log('server on port 80 never answered')
    process.exit(1)
  }
  await sleep(100)
}

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage()
const peerSockets = []
page.on('websocket', (ws) => {
  if (ws.url().includes('/peerjs')) peerSockets.push(ws.url())
})
await page.goto('http://127.0.0.1/room/default-port-check', { timeout: 15_000 })
if ((await page.evaluate(() => globalThis.location.port)) !== '') {
  console.log('location.port was not empty on the default port')
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
// A URL with no explicit port means the fallback picked the default port 80
const url = new URL(peerSockets[0])
console.log('FALLBACK-80-WS', peerSockets[0])
await browser.close()
server.kill('SIGKILL')
process.exit(url.port === '' ? 0 : 1)
