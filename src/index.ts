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
const PORT = Number(process.env.PORT) || 9000
const KEY = process.env.KEY || 'pinto'
const clients: Set<Client> = new Set()
const allowedList = new Set([
  'http://localhost:5000',
  `https://${process.env.VERCEL_URL}`,
  'https://www.pintopinto.org'
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
  },
  pingTimeout: 10000,
  upgradeTimeout: 20000
}
const generateClientId = (): string => {
  return Math.round(Math.random() * 99).toString(10)
}

const app = express()
const server = http.createServer(app)
const peerServer = ExpressPeerServer(server, {
  key: KEY,
  allow_discovery: true,
  generateClientId: generateClientId,
  alive_timeout: 120000,
  expire_timeout: 12000
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
  socket.on('join-room', (roomId: string, userId: string) => {
    if (!userId) {
      console.error('Missing userId')
      return
    } else if (!roomId) {
      console.error('Missing roomId')
      return
    }
    console.log(`User: ${userId} joined: ${roomId} with ${clients.size} users`)

    socket.join(roomId)
    socket.to(roomId).broadcast.emit('user-connected', userId)

    socket.on('disconnecting', (reason) => {
      console.dir(reason)
      console.log(`User: ${userId} - disconnecting - left: [${Array.from(socket.rooms).join(', ')}]`)
    })
    socket.on('disconnect', (reason) => {
      console.dir(reason)
      console.log(`User disconnected: ${userId}`)
      socket.to(roomId).broadcast.emit('user-disconnected', userId)
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