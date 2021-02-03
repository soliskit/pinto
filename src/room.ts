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
    console.log(`join-room: ${roomId} ${userId}`)
    if (!roomId || !userId) {
      return
    }
    socket.join(roomId)
    socket.to(roomId).broadcast.emit('user-connected', userId)
    socket.on('disconnect', () => {
      socket.to(roomId).broadcast.emit('user-disconnected', userId)
    })
  })
})

peerServer.on('connection', (client: Client) => {
  clients.add(client)
  console.dir(`Client connected ${client.getId()}`)
})

peerServer.on('disconnect', (client: Client) => {
  console.dir(`Client disconnected ${client.getId()}: ${clients.delete(client)}`)
})

server.listen(PORT)