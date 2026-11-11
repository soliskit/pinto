/**
 * Runs inside a user+network namespace: starts the server with PORT unset and
 * checks it falls back to port 443. Prints FALLBACK-443-HTTP <status>.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const env = { ...process.env }
delete env.PORT
const measurementStart = Date.now()
const server = spawn(process.execPath, ['src/index.ts'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
if (process.env.PINTO_MEASURE === '1')
  process.on('exit', () => server.kill('SIGKILL'))
let output = ''
server.stdout
  .setEncoding('utf8')
  .on('data', /** @param {string} data */ (data) => (output += data))
server.stderr
  .setEncoding('utf8')
  .on('data', /** @param {string} data */ (data) => (output += data))

/** @param {number} code */
async function finish(code) {
  if (process.env.PINTO_MEASURE === '1') {
    const { stopMeasuredServer } =
      await import('./measurement/stop-measured-server.mjs')
    await stopMeasuredServer(server, {
      dir: process.env.NODE_V8_COVERAGE,
      startedAt: measurementStart,
      sourceUrl: new URL('../src/index.ts', import.meta.url).href
    })
  }
  process.exit(code)
}

const deadline = Date.now() + 15_000
while (!output.includes('localhost:443')) {
  if (server.exitCode !== null || Date.now() > deadline) {
    console.log('server never listened on 443. Output:\n' + output)
    await finish(1)
  }
  await sleep(50)
}
const res = await fetch('http://127.0.0.1:443/')
console.log('FALLBACK-443-HTTP', res.status)
if (process.env.PINTO_MEASURE !== '1') server.kill()
await finish(res.status === 200 ? 0 : 1)
