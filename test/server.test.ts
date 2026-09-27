import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { io, type Socket } from 'socket.io-client'
import WebSocket from 'ws'
import { startServer, type Server } from './helpers.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('with the default settings', () => {
  let server: Server
  before(async () => {
    server = await startServer()
  })
  after(() => server?.stop())

  const get = (path: string) => fetch(server.url + path)

  describe('web client', () => {
    test('serves the home page at /', async () => {
      const response = await get('/')
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type') ?? '', /^text\/html/)
      assert.match(
        await response.text(),
        /<script type="module" src="\/home.js">/
      )
    })

    test('serves the room page for any room name', async () => {
      for (const path of ['/room/lobby', '/room/Team%20%231%2F%C3%BC']) {
        const response = await get(path)
        assert.equal(response.status, 200, path)
        assert.match(
          await response.text(),
          /<script type="module" src="\/room.js">/
        )
      }
    })

    test('serves the files in public/', async () => {
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

    test('serves the PeerJS browser client from node_modules', async () => {
      const response = await get('/vendor/peerjs.min.js')
      assert.equal(response.status, 200)
      const file = fileURLToPath(
        import.meta.resolve('peerjs/dist/peerjs.min.js')
      )
      assert.equal(await response.text(), await readFile(file, 'utf8'))
    })

    test('serves the Socket.IO browser client', async () => {
      const response = await get('/socket.io/socket.io.min.js')
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type') ?? '', /javascript/)
    })

    test('answers other paths with 404', async () => {
      assert.equal((await get('/nothing-here')).status, 404)
    })
  })

  test('/config gives the PeerJS key and a public STUN server', async () => {
    assert.deepEqual(await (await get('/config')).json(), {
      key: 'pinto',
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    })
  })

  describe('PeerJS', () => {
    test('/pinto/id gives a new UUID each time', async () => {
      const first = await (await get('/pinto/id')).text()
      const second = await (await get('/pinto/id')).text()
      assert.match(first, UUID)
      assert.match(second, UUID)
      assert.notEqual(first, second)
    })

    test('accepts WebSocket clients with the key and logs them', async () => {
      const id = await (await get('/pinto/id')).text()
      const peer = openPeerSocket(`key=pinto&id=${id}&token=t`)
      assert.deepEqual(await nextMessage(peer), { type: 'OPEN' })
      await server.waitForOutput(`PeerClient connected: ${id}`)

      peer.close()
      await server.waitForOutput(`PeerClient disconnected: ${id}`)
    })

    test('rejects WebSocket clients with another key', async () => {
      const peer = openPeerSocket('key=wrong&id=someone&token=t')
      assert.deepEqual(await nextMessage(peer), {
        type: 'ERROR',
        payload: { msg: 'Invalid key provided' }
      })
      peer.close()
    })
  })

  describe('Socket.IO', () => {
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
        `${socket.id} - user: ${peerId} - joined: ${room}`
      )
    }

    /** Resolves when `socket` receives `event`, with its argument */
    function next(socket: Socket, event: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error(`${event} never arrived`)),
          5_000
        )
        socket.once(event, (value: string) => {
          clearTimeout(timer)
          resolve(value)
        })
      })
    }

    test('join-room tells everyone else in that room, and nobody else', async () => {
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

    test('leaving tells the room', async () => {
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

    test('ignores join-room without a room name and peer id', async () => {
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
        new RegExp(`${late.socket.id} - join-room needs a roomId and userId`)
      )
      // And the server is still up
      assert.equal((await get('/config')).status, 200)
    })
  })

  function openPeerSocket(query: string) {
    return new WebSocket(`${server.url.replace('http', 'ws')}/peerjs?${query}`)
  }
})

test('KEY sets the PeerJS key', async () => {
  const server = await startServer({ KEY: 'secret' })
  try {
    const config = await (await fetch(`${server.url}/config`)).json()
    assert.equal(config.key, 'secret')

    const id = await (await fetch(`${server.url}/secret/id`)).text()
    assert.match(id, UUID)

    const url = `${server.url.replace('http', 'ws')}/peerjs?key=secret&id=${id}&token=t`
    const peer = new WebSocket(url)
    assert.deepEqual(await nextMessage(peer), { type: 'OPEN' })
    peer.close()
  } finally {
    await server.stop()
  }
})

async function nextMessage(socket: WebSocket) {
  const [data] = await once(socket, 'message', {
    signal: AbortSignal.timeout(5_000)
  })
  return JSON.parse(String(data))
}
