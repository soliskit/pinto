import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { chromium, type Browser } from 'playwright'

const root = fileURLToPath(new URL('..', import.meta.url))

export interface Server {
  url: string
  /** Everything the server has printed so far */
  output(): string
  /** Waits until the server prints `text`, after the first `from` characters */
  waitForOutput(text: string, from?: number): Promise<void>
  stop(): Promise<void>
}

/**
 * Runs `src/index.ts` in its own process on a free port, without Twilio
 * credentials, and waits until it listens.
 */
export async function startServer(
  env: NodeJS.ProcessEnv = {}
): Promise<Server> {
  const port = await freePort()
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    KEY: '',
    TWILIO_ACCOUNT_SID: '',
    TWILIO_AUTH_TOKEN: '',
    ...env,
    PORT: String(port)
  }
  delete childEnv.NODE_TEST_CONTEXT
  // Stdin closes when this process ends, even if the test runner kills it
  // after a timeout, so the server exits then instead of running on
  const exitWithParent =
    'data:text/javascript,process.stdin.on("end",()=>process.exit()).resume()'
  const child = spawn(
    process.execPath,
    ['--import', exitWithParent, 'src/index.ts'],
    { cwd: root, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (data) => (output += data))
  child.stderr.setEncoding('utf8').on('data', (data) => (output += data))
  const exited = new Promise<void>((resolve) =>
    child.on('exit', () => resolve())
  )

  const server: Server = {
    url: `http://localhost:${port}`,
    output: () => output,
    async waitForOutput(text, from = 0) {
      const deadline = Date.now() + 10_000
      while (!output.includes(text, from)) {
        if (child.exitCode !== null || Date.now() > deadline) {
          assert.fail(`Server never printed "${text}". Output:\n${output}`)
        }
        await sleep(20)
      }
    },
    async stop() {
      child.kill()
      await exited
    }
  }
  await server.waitForOutput(`Pinto listening on http://localhost:${port}`)
  return server
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

/**
 * Chromium with a fake camera and microphone that it may use without asking.
 * Set CHROMIUM_PATH to use an installed Chromium instead of Playwright's.
 */
export function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream'
    ]
  })
}

/**
 * Reads a value until it equals `expected`, for things that change
 * asynchronously. Fails with the last value it read.
 */
export async function eventually<T>(
  read: () => Promise<T>,
  expected: T,
  timeout = 10_000
): Promise<void> {
  const deadline = Date.now() + timeout
  let actual = await read()
  while (!isDeepStrictEqual(actual, expected) && Date.now() < deadline) {
    await sleep(50)
    actual = await read()
  }
  assert.deepEqual(actual, expected)
}
