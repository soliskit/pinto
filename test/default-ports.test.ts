import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import net from 'node:net'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * Runs the default-port fallback helpers at full fidelity wherever this
 * process can bind 80/443 directly, and inside a user+network namespace
 * whenever the direct bind probe fails, whether the ports are denied to
 * the process or already occupied. Either way the helpers' own
 * assertions are unchanged: the same server, the same browser, the same
 * dialed-URL and status checks. A runner where neither path works fails
 * loudly instead of skipping.
 */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '0.0.0.0')
  })
}

function namespacesAvailable(): boolean {
  const check = spawnSync('unshare', ['-Urn', 'true'], { stdio: 'ignore' })
  return check.status === 0
}

/** Loopback starts down in a fresh network namespace; bring it up. */
const LO_UP = `python3 -c "import socket,fcntl,struct; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); ifr=struct.pack('16sH14s',b'lo',0,b''); res=fcntl.ioctl(s,0x8913,ifr); flags=struct.unpack('16sH14s',res)[1]; fcntl.ioctl(s,0x8914,struct.pack('16sH14s',b'lo',flags|1,b''))"`

function run(script: string): { status: number | null; output: string } {
  const direct = spawnSync('node', [script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024
  })
  return {
    status: direct.status,
    output: `${direct.stdout ?? ''}\n${direct.stderr ?? ''}`
  }
}

function runInNamespace(script: string): {
  status: number | null
  output: string
} {
  const wrapped = spawnSync(
    'unshare',
    ['-Urn', 'bash', '-c', `${LO_UP} && node ${script}`],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024
    }
  )
  return {
    status: wrapped.status,
    output: `${wrapped.stdout ?? ''}\n${wrapped.stderr ?? ''}`
  }
}

let directPorts: boolean | undefined
async function runner(): Promise<
  (script: string) => {
    status: number | null
    output: string
  }
> {
  directPorts ??= (await canBind(80)) && (await canBind(443))
  if (directPorts) return run
  if (namespacesAvailable()) return runInNamespace
  assert.fail(
    'this runner allows neither a direct 80/443 bind nor user namespaces'
  )
}

test(
  'the server listens on port 443 when PORT is not configured',
  { timeout: 90_000 },
  async () => {
    const { status, output } = (await runner())(
      'test/default-port-server.helper.mjs'
    )
    assert.match(output, /FALLBACK-443-HTTP 200/, output)
    assert.equal(status, 0, output)
  }
)

test(
  'the room page connects on the default port when the URL has none',
  { timeout: 90_000 },
  async () => {
    const { status, output } = (await runner())(
      'test/default-port-client.helper.mjs'
    )
    assert.match(output, /FALLBACK-80-WS ws:\/\/127\.0\.0\.1\/peerjs/, output)
    assert.equal(status, 0, output)
  }
)

test(
  'the room page connects with wss on the default port over HTTPS',
  { timeout: 90_000 },
  async () => {
    const { status, output } = (await runner())(
      'test/default-port-https-client.helper.mjs'
    )
    assert.match(
      output,
      /FALLBACK-443-WSS wss:\/\/127\.0\.0\.1\/peerjs/,
      output
    )
    assert.equal(status, 0, output)
  }
)
