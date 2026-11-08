import http from 'node:http'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { ExpressPeerServer, type IClient } from 'peer'
import { Server as SocketServer, type Socket } from 'socket.io'
import { WebSocketServer } from 'ws'
import { getIceServers, missingTwilioSetting } from './ice-servers.ts'

const PORT = Number(process.env.PORT) || 443
const KEY = process.env.KEY || 'pinto'
const publicDir = fileURLToPath(new URL('../public/', import.meta.url))
const peerjsClient = fileURLToPath(
  import.meta.resolve('peerjs/dist/peerjs.min.js')
)

const app = express()
const server = http.createServer(app)
const io = new SocketServer(server)
const peerServer = ExpressPeerServer(server, {
  key: KEY,
  // By default PeerJS attaches a WebSocket server that answers every upgrade
  // request on `server` and rejects paths other than its own, which breaks
  // Socket.IO's WebSocket transport. Only hand it upgrades for its own path.
  createWebSocketServer: (options) => {
    const wss = new WebSocketServer({ noServer: true, path: options.path })
    server.on('upgrade', (req, socket, head) => {
      if (wss.shouldHandle(req)) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req)
        })
      }
    })
    return wss
  }
})

app.use((req, res, next) => {
  // Dot-only room names are invalid under the room-link rule; refuse them
  // before path normalization, static file handling or the room route can
  // redirect or serve anything for them
  let pathname: string
  try {
    pathname = decodeURIComponent(req.originalUrl.split('?')[0])
  } catch {
    next()
    return
  }
  const match = /^\/room\/(\.+)\/?$/.exec(pathname)
  if (match) {
    res.status(404).send(`"${match[1]}" is not a valid room name.`)
    return
  }
  next()
})
app.use(express.static(publicDir))
app.get('/vendor/peerjs.min.js', (_req, res) => {
  res.sendFile(peerjsClient)
})
app.get('/room/:roomId', (_req, res) => {
  res.sendFile('room.html', { root: publicDir })
})
app.get('/config', async (_req, res) => {
  res.json({ key: KEY, iceServers: await getIceServers() })
})
app.use(peerServer)

// Who is in each room: roomId -> (userId -> socket id that joined with it)
const rooms = new Map<string, Map<string, string>>()

// The room-name rule: names are trimmed and lowercased, then letters,
// numbers, spaces and dashes, up to 40 characters; anything else is
// refused with a shown reason. The home page applies the same trim and
// lowercase before navigating; enforcing the rule here holds raw
// Socket.IO clients to it too.
const ROOM_NAME_RULE = /^[a-z0-9 -]{1,40}$/
const ROOM_NAME_REASON =
  'Room names can use letters (A-Z), numbers, spaces and dashes, up to 40 characters.'

io.on('connection', (socket: Socket) => {
  console.log(`${socket.id} - connected`)

  socket.on('join-room', (roomId: unknown, userId: unknown, reply: unknown) => {
    // Malformed requests (a non-string name or a missing id) get no answer;
    // a well-formed name outside the rule is refused with its reason below.
    if (typeof roomId !== 'string' || typeof userId !== 'string' || !userId) {
      console.error(`${socket.id} - join-room needs a roomId and userId`)
      return
    }
    const room = roomId.trim().toLowerCase()
    if (!ROOM_NAME_RULE.test(room)) {
      // The refusal carries the reason so a client can show it. The same
      // name can never join, but the answered refusal keeps the
      // acknowledgement contract the duplicate-id refusal uses.
      console.error(`${socket.id} - join-room refused: name outside the rule`)
      if (typeof reply === 'function') reply(ROOM_NAME_REASON)
      return
    }
    let members = rooms.get(room)
    const owner = members?.get(userId)
    if (owner && owner !== socket.id) {
      // The id is in the room under another connection: joining with it
      // would let one person speak or leave as another. The refusal is
      // answered so a page can try again once the other connection is
      // really gone.
      console.error(`${socket.id} - join-room refused: id already in room`)
      if (typeof reply === 'function') reply(null)
      return
    }
    if (!members) {
      members = new Map()
      rooms.set(room, members)
    }
    const firstJoin = !members.has(userId)
    if (firstJoin) {
      console.log(`${socket.id} - user: ${userId} - joined: ${room}`)
      members.set(userId, socket.id)
      socket.join(room)
    }
    // Every valid join, first or repeat, learns who is in the room, so
    // every member id a page calls or answers comes from the server
    if (typeof reply === 'function') {
      reply([...members.keys()].filter((id) => id !== userId))
    }
    if (firstJoin) {
      socket.to(room).emit('user-connected', userId)
    }
  })

  socket.on('disconnect', (reason) => {
    for (const [roomId, members] of rooms) {
      for (const [userId, socketId] of members) {
        if (socketId === socket.id) {
          console.log(
            `${socket.id} - user: ${userId} - left: ${roomId} (${reason})`
          )
          members.delete(userId)
          socket.to(roomId).emit('user-disconnected', userId)
        }
      }
      if (members.size === 0) rooms.delete(roomId)
    }
  })
})

peerServer.on('connection', (client: IClient) => {
  console.log(`PeerClient connected: ${client.getId()}`)
})

peerServer.on('error', (error: Error) => {
  // Log only the type: the error text can repeat what a visitor sent
  console.log(`PeerServer error: ${error.name}`)
})

peerServer.on('disconnect', (client: IClient) => {
  console.log(`PeerClient disconnected: ${client.getId()}`)
})

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EACCES') {
    console.error(
      `Pinto cannot listen on port ${PORT}: permission denied. ` +
        `Set PORT to a port the server is permitted to use, for example PORT=3000.`
    )
    process.exit(1)
  }
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Pinto cannot listen on port ${PORT}: the port is already in use. ` +
        `Set PORT to a free port.`
    )
    process.exit(1)
  }
  throw error
})

const missingTwilio = missingTwilioSetting()
if (missingTwilio) {
  console.error(
    `Pinto cannot start: ${missingTwilio} is not set. ` +
      `Set both TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN, or unset both ` +
      `to use the public STUN server.`
  )
  process.exit(1)
}

server.listen(PORT, () => {
  console.log(`Pinto listening on http://localhost:${PORT}`)
})
