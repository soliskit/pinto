import http from 'http'
import cors, { CorsOptions } from 'cors'
import express, { Application } from 'express'
import { ExpressPeerServer } from 'peer'
import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { Server as SocketServer, ServerOptions, Socket } from 'socket.io'

declare type MyWebSocket = WebSocket & EventEmitter
declare interface Client {
  getId(): string
  getToken(): string
  getSocket(): MyWebSocket | null
  setSocket(socket: MyWebSocket | null): void
  getLastPing(): number
  setLastPing(lastPing: number): void
  send(data: any): void
}
const PORT = Number(process.env.PORT) || 443
const KEY = process.env.KEY || 'pinto'
const clients: Set<Client> = new Set()
const allowedList = new Set([
  'http://localhost:5000',
  `https://${process.env.VERCEL_URL}`,
  'https://pintopinto.org',
  'https://meet.pintopinto.org'
])
const corsOptions: CorsOptions = {
  origin: (origin: any, callback: any) => {
    if (!origin || allowedList.has(origin)) {
      return callback(null, true)
    } else {
      return callback(Error(`Not allowed by CORS: Origin - ${origin}`))
    }
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept']
}
const socketOptions: Partial<ServerOptions> = {
  path: `/${KEY}.io`,
  serveClient: false,
  cors: {
    origin: Array.from(allowedList),
    methods: ['GET', 'POST'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept']
  }
}
const generateClientId = (): string => {
  return Math.round(Math.random() * 99).toString(10)
}

const app = express()
const server = http.createServer(app)
const peerServer = ExpressPeerServer(server, {
  key: KEY,
  allow_discovery: true,
  generateClientId: generateClientId
})
const io = new SocketServer(server, socketOptions)

peerServer.on('mount', (app: Application) => {
  let url: string
  if (app.settings.env === 'development') {
    url = `http://localhost:${PORT}`
  } else if (process.env.HEROKU_APP_NAME) {
    url = `https://${process.env.HEROKU_APP_NAME}.herokuapp.com`
  } else {
    url = 'https://pintopinto.herokuapp.com'
  }
  console.log(`Started ExpressPeerServer on port: ${PORT} --- ${url}`)
})

app.use(cors(corsOptions))
app.use(peerServer)
io.listen(server)

io.on('connection', (socket: Socket) => {
  console.dir('client namespace connect')
  console.log(`${socket.id} - connected: ${socket.connected}`)
  socket.on('error', (error) => {
    console.error('Socket.io Error')
    console.error(error)
  })
  socket.on('disconnecting', () => {
    console.log(`${socket.id} - disconnecting: ${Array.from(socket.rooms.values()).pop()}`)
  })
  socket.on('join-room', (roomId: string, userId: string) => {
    if (!roomId || !userId) {
      throw Error('Missing roomId or userId')
    }
    console.log(`${socket.id} - user: ${userId} - joined: ${roomId}`)

    socket.join(roomId)
    socket.to(roomId).emit('user-connected', userId)

    socket.on('disconnect', (reason) => {
      console.dir(reason)
      console.log(`${socket.id} - user: ${userId} - disconnected: ${socket.disconnected}`)
      socket.to(roomId).emit('user-disconnected', userId)
      switch (reason) {
        case 'server namespace disconnect':
          console.log('Socket manually disconnected by server')
          break
        case 'client namespace disconnect':
          console.log('Socket manually disconnected by client')
          break
        case 'server shutting down':
          console.log('Server is shutting down')
          break
        case 'ping timeout':
          console.error('Client failed to send PONG packet within timeout range')
          break
        case 'transport close':
          console.error('User lost connection or network was changed')
          break
        case 'transport error':
          console.error('Connection encountered server error')
          break
        default:
          console.error('Socket disconnected for unknown reason')
      }
    })
  })
})

peerServer.on('connection', (client: Client) => {
  clients.add(client)
  console.log(`PeerClient connected: ${client.getId()}`)
})

peerServer.on('disconnect', (client: Client) => {
  clients.delete(client)
  console.log(`PeerClient disconnected: ${client.getId()}`)
})

server.listen(PORT)