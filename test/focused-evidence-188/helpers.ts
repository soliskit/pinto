import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resourceReceipt } from './resource-receipt.ts'
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
  const resourceId = `server-${randomUUID()}`
  resourceReceipt(resourceId, 'acquire-start')
  let child: ReturnType<typeof spawn> | undefined
  let output = ''
  let spawnError: Error | undefined
  let closed = false
  let stopping: Promise<void> | undefined
  // Polling has no setup-dependent event Promise to strand on handover failure.
  async function waitForClose(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (!closed && Date.now() < deadline) await sleep(20)
    return closed
  }
  function stop(): Promise<void> {
    stopping ??= (async () => {
      if (!child) return
      if (closed) {
        resourceReceipt(resourceId, 'closed')
        return
      }
      child.kill('SIGTERM')
      if (await waitForClose(2000)) {
        resourceReceipt(resourceId, 'closed')
        return
      }
      child.kill('SIGKILL')
      if (!(await waitForClose(2000))) {
        throw Error('Owned server close not confirmed after TERM/KILL')
      }
      throw Error('Owned server required SIGKILL during cleanup')
    })()
    return stopping
  }
  try {
    child = spawn(
      process.execPath,
      ['--import', exitWithParent, 'src/index.ts'],
      { cwd: root, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    child.once('error', (error) => {
      spawnError = error
    })
    child.once('close', () => {
      closed = true
    })
    resourceReceipt(resourceId, 'acquired')
    if (!child.stdout || !child.stderr)
      throw Error('Missing owned server pipes')
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      output += data
    })
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      output += data
    })
    const ownedChild = child
    const server: Server = {
      url: `http://localhost:${String(port)}`,
      output: () => output,
      async waitForOutput(text, from = 0) {
        const deadline = Date.now() + 10_000
        while (!output.includes(text, from)) {
          if (
            spawnError ||
            ownedChild.exitCode !== null ||
            ownedChild.signalCode !== null ||
            Date.now() > deadline
          ) {
            assert.fail(`Server never printed "${text}". Output:\n${output}`)
          }
          await sleep(20)
        }
      },
      stop
    }
    await server.waitForOutput(
      `Pinto listening on http://localhost:${String(port)}`
    )
    return server
  } catch (startupError) {
    try {
      await stop()
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        'Server startup failed and cleanup did not finish normally',
        { cause: cleanupError }
      )
    }
    throw startupError
  }
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
 * Chromium with a fake camera and microphone that it may use without asking.
 * Set CHROMIUM_PATH to use an installed Chromium instead of Playwright's.
 * Set PINTO_BROWSER=webkit to use Playwright's WebKit, launched without the
 * fake camera and microphone flags, so tests that need them are not run in it.
 */
export function launchBrowser(): Promise<Browser> {
  if (process.env.PINTO_BROWSER === 'webkit') return webkit.launch()
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
