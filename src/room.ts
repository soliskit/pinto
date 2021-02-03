
import http from 'http'
import https from 'https'
import cors, { CorsOptions } from 'cors'
import express, { Application } from 'express'
import { ExpressPeerServer } from 'peer'
import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { Server as SocketServer, ServerOptions, Socket } from 'socket.io'

declare type MyWebSocket = WebSocket & EventEmitter
declare interface IClient {
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
const allowedList = new Set([
  'https://web-player.vercel.app',
  'https://www.pintopinto.org',
  'http://localhost:5000'
])
const corsOptions: CorsOptions = {
  origin: (origin: any, callback: any) => {
    if (!origin || allowedList.has(origin)) {
      return callback(null, true)
    } else {
      return callback(Error('Not allowed by CORS'))
    }
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept']
}
const generateClientId = (): string => {
  return Math.round(Math.random() * 99).toString(10)
}

/* eslint-disable */
type HTTPServer = http.Server | https.Server
function RoomServer(server: HTTPServer) {
  const app = express()
  const io = new SocketServer(server, {
    cors: {
      origin: ["http://localhost:5000", "https://web-player.vercel.app", "https://www.pintopinto.org"],
      methods: ["GET", "POST"],
      allowedHeaders: ["origin", "x-requested-with", "content-type"]
    }
  })
  io.on("connection", (socket: Socket) => {
    socket.on("join-room", (roomId: string, userId: string) => {
      console.log(`join-room: ${roomId} ${userId}`)
      if(!roomId || !userId) {
        return
      }
      socket.join(roomId)
      socket.to(roomId).broadcast.emit("user-connected", userId)
      socket.on("disconnect", () => {
        socket.to(roomId).broadcast.emit("user-disconnected", userId)
      })
    })
  })
  return app
}
/* eslint-enable */

const app = express()
const server = http.createServer(app)
const peerServer = ExpressPeerServer(server, {
  key: KEY,
  allow_discovery: true,
  generateClientId: generateClientId
})

const clients: Set<IClient> = new Set()

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
const roomServer = RoomServer(server)
peerServer.use(roomServer)

app.get('/test', (request, response, next) => {
  console.dir(request.originalUrl)
  response.status(200).type('html').send('Test Success!')
  next()
})

peerServer.on('connection', (client: IClient) => {
  clients.add(client)
  console.dir(`Client connected ${client.getId()}`)
})

peerServer.on('disconnect', (client: IClient) => {
  console.dir(`Client disconnected ${client.getId()}: ${clients.delete(client)}`)
})

server.listen(PORT)