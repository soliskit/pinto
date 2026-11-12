import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { after, before, describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { io, type Socket } from 'socket.io-client'
import WebSocket from 'ws'
import { eventually, freePort, startServer, type Server } from './helpers.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

void describe('with the default settings', () => {
  let server: Server
  before(async () => {
    server = await startServer()
  })
  after(async () => {
    await server.stop()
  })

  const get = (path: string) => fetch(server.url + path)

  void describe('web client', () => {
    void test('serves the home page at /', async () => {
      const response = await get('/')
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type') ?? '', /^text\/html/)
      assert.match(
        await response.text(),
        /<script type="module" src="\/home.js">/
      )
    })

    void test('serves the room page for any room name', async () => {
      for (const path of ['/room/lobby', '/room/Team%20%231%2F%C3%BC']) {
        const response = await get(path)
        assert.equal(response.status, 200, path)
        assert.match(
          await response.text(),
          /<script type="module" src="\/room.js">/
        )
      }
    })

    void test('serves the files in public/', async () => {
      const types: Record<string, RegExp> = {
        '/home.js': /^text\/javascript/,
        '/room.js': /^text\/javascript/,
        '/element.js': /^text\/javascript/,
        '/ordinal.js': /^text\/javascript/,
        '/style.css': /^text\/css/,
        '/no-video.svg': /^image\/svg\+xml/,
        '/favicon.ico': /^image\//
      }
      for (const [path, type] of Object.entries(types)) {
        const response = await get(path)
        assert.equal(response.status, 200, path)
        assert.match(response.headers.get('content-type') ?? '', type, path)
      }
    })

    void test('serves the PeerJS browser client from node_modules', async () => {
      const response = await get('/vendor/peerjs.min.js')
      assert.equal(response.status, 200)
      const file = fileURLToPath(
        import.meta.resolve('peerjs/dist/peerjs.min.js')
      )
      assert.equal(await response.text(), await readFile(file, 'utf8'))
    })

    void test('serves the Socket.IO browser client', async () => {
      const response = await get('/socket.io/socket.io.min.js')
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type') ?? '', /javascript/)
    })

    void test('answers other paths with 404', async () => {
      assert.equal((await get('/nothing-here')).status, 404)
    })

    void test('the pages send the security headers', async () => {
      for (const path of ['/', '/index.html', '/room/lobby', '/room.html']) {
        const response = await get(path)
        const csp = response.headers.get('content-security-policy') ?? ''
        assert.match(csp, /default-src 'none'/, path)
        assert.match(csp, /script-src 'self';/, path)
        assert.match(csp, /frame-ancestors 'none'/, path)
        assert.match(csp, /connect-src 'self'/, path)
        assert.equal(
          response.headers.get('x-content-type-options'),
          'nosniff',
          path
        )
        assert.equal(response.headers.get('x-frame-options'), 'DENY', path)
      }
    })

    void test('the script policy allows only self-hosted scripts', async () => {
      const response = await get('/room/lobby')
      const html = await response.text()
      const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      assert.equal(
        inline.length,
        0,
        'the served room page has no inline script'
      )
      const csp = response.headers.get('content-security-policy') ?? ''
      assert.match(
        csp,
        /script-src 'self';/,
        'the served policy allows only self-hosted scripts'
      )
      assert.doesNotMatch(
        csp,
        /sha256-/,
        'the served policy carries no inline-script hash'
      )
    })

    void test('other responses stay outside the page policy', async () => {
      for (const path of ['/style.css', '/config']) {
        const response = await get(path)
        assert.equal(
          response.headers.get('content-security-policy'),
          null,
          path
        )
      }
      // Error answers keep the framework's own minimal policy, unchanged
      const missing = await get('/nothing-here')
      assert.equal(
        missing.headers.get('content-security-policy'),
        "default-src 'none'"
      )
    })

    void test('the socket sources come from authorized configuration', async () => {
      const port = new URL(server.url).port
      if (process.env.RENDER_EXTERNAL_HOSTNAME === undefined) {
        const csp =
          (await get('/')).headers.get('content-security-policy') ?? ''
        assert.ok(csp.includes(`ws://localhost:${port}`), csp)
        assert.ok(csp.includes(`ws://127.0.0.1:${port}`), csp)
        assert.ok(!csp.includes('wss://'), csp)
      }
      const deployed = await startServer({
        RENDER_EXTERNAL_HOSTNAME: 'pinto.onrender.com'
      })
      try {
        const csp =
          (await fetch(deployed.url + '/')).headers.get(
            'content-security-policy'
          ) ?? ''
        assert.ok(
          csp.includes("connect-src 'self' wss://pinto.onrender.com"),
          csp
        )
        assert.ok(!csp.includes('ws://localhost'), csp)
      } finally {
        await deployed.stop()
      }
      const malformed = await startServer({
        RENDER_EXTERNAL_HOSTNAME: 'bad"; drop'
      })
      try {
        const csp =
          (await fetch(malformed.url + '/')).headers.get(
            'content-security-policy'
          ) ?? ''
        const directive = csp
          .split('; ')
          .find((part) => part.startsWith('connect-src'))
        assert.equal(directive, "connect-src 'self'", csp)
      } finally {
        await malformed.stop()
      }
    })
  })

  void test('/config gives a public STUN server', async () => {
    assert.deepEqual(await (await get('/config')).json(), {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    })
  })

  void describe('PeerJS', () => {
    void test('/peerjs/id gives a new UUID each time', async () => {
      const first = await (await get('/peerjs/id')).text()
      const second = await (await get('/peerjs/id')).text()
      assert.match(first, UUID)
      assert.match(second, UUID)
      assert.notEqual(first, second)
    })

    void test('the peer-list addresses answer 401 without the key', async () => {
      for (const path of ['/pinto/peers', '/peerjs/peers']) {
        assert.equal((await get(path)).status, 401, path)
      }
    })

    void test('accepts WebSocket clients with the key and logs them', async () => {
      const id = await (await get('/peerjs/id')).text()
      const peer = openPeerSocket(`key=peerjs&id=${id}&token=t`)
      assert.deepEqual(await nextMessage(peer), { type: 'OPEN' })
      await server.waitForOutput(`PeerClient connected: ${id}`)

      peer.close()
      await server.waitForOutput(`PeerClient disconnected: ${id}`)
    })

    void test('rejects WebSocket clients with another key', async () => {
      const peer = openPeerSocket('key=wrong&id=someone&token=t')
      assert.deepEqual(await nextMessage(peer), {
        type: 'ERROR',
        payload: { msg: 'Invalid key provided' }
      })
      peer.close()
    })

    void test('survives a message that is not JSON and logs only its type', async () => {
      const id = await (await get('/peerjs/id')).text()
      const peer = openPeerSocket(`key=peerjs&id=${id}&token=t`)
      assert.deepEqual(await nextMessage(peer), { type: 'OPEN' })
      peer.send('visitor text, not JSON')
      await server.waitForOutput('PeerServer error: SyntaxError')
      assert.ok(!server.output().includes('visitor text'))
      assert.equal((await get('/config')).status, 200)
      peer.close()
    })
  })

  void describe('Socket.IO', () => {
    const sockets: Socket[] = []
    after(() => {
      for (const socket of sockets) socket.disconnect()
    })

    /**
     * Connects over WebSocket only, which used to fail while PeerJS answered
     * every upgrade request. Records the room events it receives.
     */
    async function connect() {
      const socket = io(server.url, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false
      })
      sockets.push(socket)
      const events = { connected: [] as string[], disconnected: [] as string[] }
      socket.on('user-connected', (id: string) => events.connected.push(id))
      socket.on('user-disconnected', (id: string) =>
        events.disconnected.push(id)
      )
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('connect_error', reject)
      })
      return { socket, events }
    }

    async function join(socket: Socket, room: string, peerId: string) {
      socket.emit('join-room', room, peerId)
      await server.waitForOutput(
        `${String(socket.id)} - user: ${peerId} - joined: ${room}`
      )
    }

    /** Resolves when `socket` receives `event`, with its argument */
    function next(socket: Socket, event: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(Error(`${event} never arrived`))
        }, 5_000)
        socket.once(event, (value: string) => {
          clearTimeout(timer)
          resolve(value)
        })
      })
    }

    void test('join-room tells everyone else in that room, and nobody else', async () => {
      const [a, b, c, d, e] = await Promise.all(
        Array.from({ length: 5 }, connect)
      )
      await join(a.socket, 'one', 'peer-a')
      await join(c.socket, 'two', 'peer-c')

      const bJoined = next(a.socket, 'user-connected')
      await join(b.socket, 'one', 'peer-b')
      assert.equal(await bJoined, 'peer-b')

      // Each socket gets its events in order, so once c hears about d, it
      // would already have heard about b if the server had told it
      const dJoined = next(c.socket, 'user-connected')
      await join(d.socket, 'two', 'peer-d')
      await dJoined

      const eJoined = next(b.socket, 'user-connected')
      await join(e.socket, 'one', 'peer-e')
      await eJoined

      assert.deepEqual(a.events.connected, ['peer-b', 'peer-e'])
      assert.deepEqual(b.events.connected, ['peer-e'])
      assert.deepEqual(c.events.connected, ['peer-d'])
    })

    void test('leaving tells the room', async () => {
      const [a, b, c, d] = await Promise.all(Array.from({ length: 4 }, connect))
      await join(a.socket, 'three', 'peer-a')
      await join(b.socket, 'three', 'peer-b')
      await join(c.socket, 'four', 'peer-c')
      await join(d.socket, 'four', 'peer-d')

      const bLeft = next(a.socket, 'user-disconnected')
      b.socket.disconnect()
      assert.equal(await bLeft, 'peer-b')
      await server.waitForOutput(`user: peer-b - left: three (`)

      const dLeft = next(c.socket, 'user-disconnected')
      d.socket.disconnect()
      await dLeft

      assert.deepEqual(a.events.disconnected, ['peer-b'])
      assert.deepEqual(c.events.disconnected, ['peer-d'])
    })

    void test('ignores join-room without a room name and peer id', async () => {
      const [a, late] = await Promise.all([connect(), connect()])
      await join(a.socket, 'five', 'peer-a')

      const invalid: unknown[][] = [
        [],
        ['five'],
        ['five', 42],
        ['five', ''],
        ['', 'peer-x'],
        [{ room: 'five' }, 'peer-x']
      ]
      for (const args of invalid) late.socket.emit('join-room', ...args)
      const lateJoined = next(a.socket, 'user-connected')
      await join(late.socket, 'five', 'peer-late')
      assert.equal(await lateJoined, 'peer-late')

      // Nothing reached the room before the valid join
      assert.deepEqual(a.events.connected, ['peer-late'])
      assert.match(
        server.output(),
        new RegExp(
          `${String(late.socket.id)} - join-room needs a roomId and userId`
        )
      )
      // And the server is still up
      assert.equal((await get('/config')).status, 200)
    })

    void test('a second connection claiming an id already in the room is refused', async () => {
      const [a, b, stranger] = await Promise.all(
        Array.from({ length: 3 }, connect)
      )
      await join(a.socket, 'dup', 'peer-a')
      await join(b.socket, 'dup', 'peer-b')

      // The stranger is refused (answered with null) and never told to the room
      const refused = (await stranger.socket.emitWithAck(
        'join-room',
        'dup',
        'peer-b'
      )) as unknown
      assert.equal(refused, null)
      await server.waitForOutput(
        `${String(stranger.socket.id)} - join-room refused: id already in room`
      )
      // Its disconnect ends nothing: b's membership belongs to b's socket.
      // A fresh connection as a different id works normally
      stranger.socket.disconnect()
      const [other] = await Promise.all([connect()])
      const strangerHeard = next(a.socket, 'user-connected')
      await join(other.socket, 'dup', 'peer-stranger')
      await strangerHeard
      assert.deepEqual(a.events.connected, ['peer-b', 'peer-stranger'])
      assert.deepEqual(a.events.disconnected, [])

      // Once b really leaves, the id is free and can be claimed again
      const bLeft = next(a.socket, 'user-disconnected')
      b.socket.disconnect()
      assert.equal(await bLeft, 'peer-b')
      await server.waitForOutput(`user: peer-b - left: dup (`)
      const [c] = await Promise.all([connect()])
      await join(c.socket, 'dup', 'peer-b')
      await eventually(() => Promise.resolve(a.events.connected.length), 3)
      assert.deepEqual(a.events.connected, [
        'peer-b',
        'peer-stranger',
        'peer-b'
      ])
      assert.deepEqual(a.events.disconnected, ['peer-b'])
    })

    void test('join-room holds raw clients to the room-name rule', async () => {
      const [a, b, c] = await Promise.all(Array.from({ length: 3 }, connect))
      await join(a.socket, 'validroom', 'peer-a')
      // Spaces are inside the rule: the boundary case stays accepted
      const roster = (await b.socket.emitWithAck(
        'join-room',
        'bad name',
        'peer-b'
      )) as string[]
      assert.deepEqual(roster, [])
      // Exactly 40 characters is inside the rule
      assert.deepEqual(
        await b.socket.emitWithAck('join-room', 'a'.repeat(40), 'peer-b40'),
        []
      )
      const heard = next(a.socket, 'user-connected')
      await join(b.socket, 'validroom', 'peer-b2')
      assert.equal(await heard, 'peer-b2')

      const refused: [string, string][] = [
        ['a'.repeat(41), 'peer-long'], // over the 40-character rule
        ['bad/name', 'peer-slash'], // slash, outside the alphabet
        ['room\u{1F389}', 'peer-emoji'], // emoji, outside the alphabet
        ['line\nbreak', 'peer-newline'], // newline, outside the alphabet
        ['caf\u00e9', 'peer-accent'], // accented letter: ASCII letters only
        ['\u65e5\u672c\u8a9e', 'peer-nonlatin'], // non-Latin: ASCII only
        ['   ', 'peer-spaces'], // trims to empty
        ['', 'peer-empty'] // empty: refused with the reason like any other
      ]
      for (const [name, id] of refused) {
        const answer = (await c.socket.emitWithAck(
          'join-room',
          name,
          id
        )) as unknown
        assert.equal(
          answer,
          'Room names can use letters (A-Z), numbers, spaces and dashes, up to 40 characters.',
          name
        )
      }
      await server.waitForOutput('join-room refused: name outside the rule')
      // None of the refused names reached a room
      assert.deepEqual(a.events.connected, ['peer-b2'])
      assert.deepEqual(a.events.disconnected, [])
    })

    void test('join-room trims and lowercases names before applying the rule', async () => {
      const [a, b] = await Promise.all([connect(), connect()])
      const roster = (await a.socket.emitWithAck(
        'join-room',
        '  UPPER Case-1  ',
        'peer-a'
      )) as string[]
      assert.deepEqual(roster, [])
      await server.waitForOutput('user: peer-a - joined: upper case-1')
      // The normalized name is the room: the next page joins the same one
      const heard = next(a.socket, 'user-connected')
      const roster2 = (await b.socket.emitWithAck(
        'join-room',
        'upper case-1',
        'peer-b'
      )) as string[]
      assert.deepEqual(roster2, ['peer-a'])
      assert.equal(await heard, 'peer-b')
    })

    void test('a repeat join on the same connection changes nothing', async () => {
      const [a, b] = await Promise.all([connect(), connect()])
      await join(a.socket, 'rejoin', 'peer-a')
      await join(b.socket, 'rejoin', 'peer-b')

      // Answered with the roster again, but not logged or broadcast again
      const roster = (await b.socket.emitWithAck(
        'join-room',
        'rejoin',
        'peer-b'
      )) as string[]
      assert.deepEqual(roster, ['peer-a'])
      assert.deepEqual(a.events.connected, ['peer-b'])
      assert.equal(
        server.output().match(/user: peer-b - joined: rejoin/g)?.length,
        1
      )
    })

    void test('a newcomer is told who is already in the room', async () => {
      const [a, b, c] = await Promise.all(Array.from({ length: 3 }, connect))
      await join(a.socket, 'roster', 'peer-a')
      await join(b.socket, 'roster', 'peer-b')

      const roster = (await c.socket.emitWithAck(
        'join-room',
        'roster',
        'peer-c'
      )) as string[]
      assert.deepEqual([...roster].sort(), ['peer-a', 'peer-b'])
      // And the room still hears about the newcomer itself
      await eventually(() => Promise.resolve(a.events.connected.length), 2)
      assert.deepEqual(a.events.connected, ['peer-b', 'peer-c'])
    })

    void test('the current room call sites name the app room-key helper', async () => {
      // A source-shape guard over the current socket.join / socket.to lines:
      // each must name appRoom. It does not check the helper's
      // implementation, other emit forms, or delivery behavior.
      const source = await readFile(
        fileURLToPath(new URL('../src/index.ts', import.meta.url)),
        'utf8'
      )
      const bare = source
        .split('\n')
        .filter(
          (line) =>
            /socket\.(join|to)\(/.test(line) && !line.includes('appRoom(')
        )
      assert.deepEqual(bare, [])
    })

    void test('only one of two connections racing for the same id is let in', async () => {
      const [a, r1, r2, late] = await Promise.all(
        Array.from({ length: 4 }, connect)
      )
      await join(a.socket, 'race', 'peer-a')

      r1.socket.emit('join-room', 'race', 'peer-race', () => {})
      r2.socket.emit('join-room', 'race', 'peer-race', () => {})
      await server.waitForOutput('user: peer-race - joined: race')
      await server.waitForOutput('join-room refused: id already in room')
      assert.equal(
        server.output().match(/user: peer-race - joined: race/g)?.length,
        1
      )

      // The room heard about the winner exactly once: a trailing join, which
      // a hears about after everything before it, proves the order
      await join(late.socket, 'race', 'peer-late')
      await eventually(() => Promise.resolve(a.events.connected.length), 2)
      assert.deepEqual(a.events.connected, ['peer-race', 'peer-late'])
    })

    void test('disconnecting removes every id the connection claimed', async () => {
      const [a, b, c] = await Promise.all(Array.from({ length: 3 }, connect))
      await join(a.socket, 'multi', 'peer-a')
      await join(b.socket, 'multi', 'peer-b')
      await join(c.socket, 'multi', 'peer-c1')
      await join(c.socket, 'multi', 'peer-c2')

      c.socket.disconnect()
      await eventually(() => Promise.resolve(a.events.disconnected.length), 2)
      assert.deepEqual([...a.events.disconnected].sort(), [
        'peer-c1',
        'peer-c2'
      ])
      assert.deepEqual([...b.events.disconnected].sort(), [
        'peer-c1',
        'peer-c2'
      ])
      assert.deepEqual(a.events.connected, ['peer-b', 'peer-c1', 'peer-c2'])
    })
  })

  function openPeerSocket(query: string) {
    return new WebSocket(`${server.url.replace('http', 'ws')}/peerjs?${query}`)
  }
})

void test('legacy KEY cannot change the default PeerJS connection key', async () => {
  const server = await startServer({ KEY: 'secret' })
  try {
    const config = (await (await fetch(`${server.url}/config`)).json()) as {
      key?: unknown
    }
    assert.equal(config.key, undefined)

    const id = await (await fetch(`${server.url}/peerjs/id`)).text()
    assert.match(id, UUID)

    const url = `${server.url.replace('http', 'ws')}/peerjs?key=peerjs&id=${id}&token=t`
    const peer = new WebSocket(url)
    assert.deepEqual(await nextMessage(peer), { type: 'OPEN' })
    peer.close()
  } finally {
    await server.stop()
  }
})

async function nextMessage(socket: WebSocket) {
  const [data] = (await once(socket, 'message', {
    signal: AbortSignal.timeout(5_000)
  })) as [Buffer | string]
  return JSON.parse(String(data)) as unknown
}

void describe('with a partial Twilio configuration', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))

  async function boot(env: Record<string, string>) {
    const child = spawn(process.execPath, ['src/index.ts'], {
      cwd: root,
      env: { ...process.env, KEY: '', PORT: String(await freePort()), ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout
      .setEncoding('utf8')
      .on('data', (data: string) => (output += data))
    child.stderr
      .setEncoding('utf8')
      .on('data', (data: string) => (output += data))
    // 'close' fires after the stdio streams close, so output is complete
    const closed = once(child, 'close') as Promise<
      [number | null, NodeJS.Signals | null]
    >
    const spawnFailed = once(child, 'error').then(([error]) => {
      throw error
    })
    const controller = new AbortController()
    const deadline = sleep(10_000, undefined, {
      signal: controller.signal
    }).then(
      () => 'timed out' as const,
      () => 'aborted' as const
    )
    try {
      const result = await Promise.race([
        closed.then(([code]) => ({ code, output, timedOut: false })),
        spawnFailed,
        deadline.then((state) => {
          if (state === 'timed out') child.kill('SIGKILL')
          return { code: null, output, timedOut: state === 'timed out' }
        })
      ])
      if (result.timedOut) {
        await closed
        assert.fail(`server did not exit within 10s. Output:\n${output}`)
      }
      return result
    } finally {
      controller.abort()
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
    }
  }

  void test('refuses to start with only TWILIO_ACCOUNT_SID set', async () => {
    const { code, output } = await boot({
      TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32),
      TWILIO_AUTH_TOKEN: ''
    })
    assert.equal(code, 1)
    assert.match(output, /TWILIO_AUTH_TOKEN is not set/)
    assert.doesNotMatch(output, /Pinto listening/)
  })

  void test('refuses to start with only TWILIO_AUTH_TOKEN set', async () => {
    const { code, output } = await boot({
      TWILIO_ACCOUNT_SID: '',
      TWILIO_AUTH_TOKEN: 'secret'
    })
    assert.equal(code, 1)
    assert.match(output, /TWILIO_ACCOUNT_SID is not set/)
    assert.doesNotMatch(output, /Pinto listening/)
  })
})
