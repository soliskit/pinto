import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { chromium, webkit, type Browser } from 'playwright'

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
  child.stdout.setEncoding('utf8').on('data', (data: string) => {
    output += data
  })
  child.stderr.setEncoding('utf8').on('data', (data: string) => {
    output += data
  })
  const exited = new Promise<void>((resolve) =>
    child.on('exit', () => {
      resolve()
    })
  )

  const server: Server = {
    url: `http://localhost:${String(port)}`,
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
  await server.waitForOutput(
    `Pinto listening on http://localhost:${String(port)}`
  )
  return server
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => {
        resolve(port)
      })
    })
  })
}

/**
 * Runs before any page script: tells instrumented code which mutant is
 * active. The mutation runner passes the selection only as an environment
 * variable on the Node test process; this bridges it into the browser,
 * merging into the namespace the instrumented header creates rather than
 * replacing it.
 */
function activateMutant(id: string) {
  const globalScope = globalThis as {
    __stryker__?: { activeMutant?: string }
  }
  const ns = (globalScope.__stryker__ ??= {})
  ns.activeMutant = id
}

/**
 * Chromium with a fake camera and microphone that it may use without asking.
 * Set CHROMIUM_PATH to use an installed Chromium instead of Playwright's.
 * Set PINTO_BROWSER=webkit to use Playwright's WebKit, launched without the
 * fake camera and microphone flags, so tests that need them are not run in it.
 *
 * During a mutation run (the runner sets __STRYKER_ACTIVE_MUTANT__), every
 * context and page from this browser registers activateMutant, so mutated
 * browser code actually runs the selected mutation; without it every
 * browser-executed mutant would survive. Outside a mutation run the browser
 * is returned untouched.
 */
export async function launchBrowser(): Promise<Browser> {
  const browser = await (process.env.PINTO_BROWSER === 'webkit'
    ? webkit.launch()
    : chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream'
        ]
      }))
  const activeMutant = process.env.__STRYKER_ACTIVE_MUTANT__
  if (activeMutant === undefined) return browser
  const newContext = browser.newContext.bind(browser)
  const newPage = browser.newPage.bind(browser)
  browser.newContext = async (...args: Parameters<Browser['newContext']>) => {
    const context = await newContext(...args)
    await context.addInitScript(activateMutant, activeMutant)
    return context
  }
  browser.newPage = async (...args: Parameters<Browser['newPage']>) => {
    const page = await newPage(...args)
    await page.addInitScript(activateMutant, activeMutant)
    return page
  }
  return browser
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

/** Runs in each page before its scripts, to record what room.js creates */
export function record() {
  const recorded: Window['recorded'] = {
    peerConnections: [],
    peerSockets: [],
    peerMessages: [],
    mediaStreams: []
  }
  window.recorded = recorded

  const { mediaDevices } = navigator
  const getUserMedia = mediaDevices.getUserMedia.bind(mediaDevices)
  mediaDevices.getUserMedia = async (constraints) => {
    const stream = await getUserMedia(constraints)
    recorded.media = stream
    recorded.mediaStreams.push(stream)
    return stream
  }

  window.RTCPeerConnection = class extends RTCPeerConnection {
    constructor(configuration?: RTCConfiguration) {
      super(configuration)
      recorded.peerConnections.push(this)
    }
  }

  window.WebSocket = class extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      if (!String(url).includes('/peerjs')) return
      recorded.peerSockets.push(this)
      this.addEventListener('message', (event) =>
        recorded.peerMessages.push(event.data as string)
      )
    }
  }
}
