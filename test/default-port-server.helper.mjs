/**
 * Runs inside a user+network namespace: starts the server with PORT unset and
 * checks it falls back to port 443. Prints FALLBACK-443-HTTP <status>.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const env = { ...process.env }
delete env.PORT
const server = spawn(process.execPath, ['src/index.ts'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
let output = ''
server.stdout.setEncoding('utf8').on('data', (data) => (output += data))
server.stderr.setEncoding('utf8').on('data', (data) => (output += data))

const deadline = Date.now() + 15_000
while (!output.includes('localhost:443')) {
  if (server.exitCode !== null || Date.now() > deadline) {
    console.log('server never listened on 443. Output:\n' + output)
    process.exit(1)
  }
  await sleep(50)
}
const res = await fetch('http://127.0.0.1:443/')
console.log('FALLBACK-443-HTTP', res.status)
server.kill()
process.exit(res.status === 200 ? 0 : 1)
