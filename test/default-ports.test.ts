import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * True when an unprivileged process may create a user+network namespace,
 * which is what lets these tests bind the default ports without root.
 */
function namespacesAvailable(): boolean {
  const check = spawnSync('unshare', ['-Urn', 'true'], { stdio: 'ignore' })
  return check.status === 0
}

/** Loopback starts down in a fresh network namespace; bring it up. */
const LO_UP = `python3 -c "import socket,fcntl,struct; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); ifr=struct.pack('16sH14s',b'lo',0,b''); res=fcntl.ioctl(s,0x8913,ifr); flags=struct.unpack('16sH14s',res)[1]; fcntl.ioctl(s,0x8914,struct.pack('16sH14s',b'lo',flags|1,b''))"`

function inNamespace(script: string): {
  status: number | null
  output: string
} {
  const run = spawnSync(
    'unshare',
    ['-Urn', 'bash', '-c', `${LO_UP} && ${script}`],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024
    }
  )
  return {
    status: run.status,
    output: `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  }
}

test(
  'the server listens on port 443 when PORT is not configured',
  { skip: !namespacesAvailable(), timeout: 90_000 },
  () => {
    const { status, output } = inNamespace(
      'node test/default-port-server.helper.mjs'
    )
    assert.match(output, /FALLBACK-443-HTTP 200/, output)
    assert.equal(status, 0, output)
  }
)

test(
  'the room page connects on the default port when the URL has none',
  { skip: !namespacesAvailable(), timeout: 90_000 },
  () => {
    const { status, output } = inNamespace(
      'node test/default-port-client.helper.mjs'
    )
    assert.match(output, /FALLBACK-80-WS ws:\/\/127\.0\.0\.1\/peerjs/, output)
    assert.equal(status, 0, output)
  }
)

test(
  'the room page connects with wss on the default port over HTTPS',
  { skip: !namespacesAvailable(), timeout: 90_000 },
  () => {
    const { status, output } = inNamespace(
      'node test/default-port-https-client.helper.mjs'
    )
    assert.match(
      output,
      /FALLBACK-443-WSS wss:\/\/127\.0\.0\.1\/peerjs/,
      output
    )
    assert.equal(status, 0, output)
  }
)
