import http from 'node:http'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { ExpressPeerServer, type IClient } from 'peer'
import { Server as SocketServer, type Socket } from 'socket.io'
import { WebSocketServer } from 'ws'
import { getIceServers } from './ice-servers.ts'

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

io.on('connection', (socket: Socket) => {
  console.log(`${socket.id} - connected`)

  socket.on('join-room', (roomId: unknown, userId: unknown, reply: unknown) => {
    if (
      typeof roomId !== 'string' ||
      typeof userId !== 'string' ||
      !roomId ||
      !userId
    ) {
      console.error(`${socket.id} - join-room needs a roomId and userId`)
      return
    }
    let members = rooms.get(roomId)
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
      rooms.set(roomId, members)
    }
    const firstJoin = !members.has(userId)
    if (firstJoin) {
      console.log(`${socket.id} - user: ${userId} - joined: ${roomId}`)
      members.set(userId, socket.id)
      socket.join(roomId)
    }
    // Every valid join, first or repeat, learns who is in the room, so
    // every member id a page calls or answers comes from the server
    if (typeof reply === 'function') {
      reply([...members.keys()].filter((id) => id !== userId))
    }
    if (firstJoin) {
      socket.to(roomId).emit('user-connected', userId)
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

server.listen(PORT, () => {
  console.log(`Pinto listening on http://localhost:${PORT}`)
})
