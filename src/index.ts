import http from 'http'
import cors, { CorsOptions } from 'cors'
import express, { Application } from 'express'
import { ExpressPeerServer } from 'peer'
import { EventEmitter } from 'events'
import WebSocket from 'ws'

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
const peerEndpoint = [
  '/',
  `/${KEY}/id`,
  `/${KEY}/peers`,
  '/peerjs',
  `/${KEY}/:userId/:userToken/offer`,
  `/${KEY}/:userId/:userToken/candidate`,
  `/${KEY}/:userId/:userToken/answer`,
  `/${KEY}/:userId/:userToken/leave`
]
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
    url = `http://localhost:${PORT}/${KEY}`
  } else {
    url = `https://pintopinto.herokuapp.com/${KEY}`
  }
  console.log(`Started ExpressPeerServer on port: ${PORT} --- ${url}`)
})

app.use(cors(corsOptions))
app.use(peerEndpoint, peerServer)

peerServer.on('connection', (client: IClient) => {
  clients.add(client)
  console.dir(`Client connected ${client.getId()}`)
})

peerServer.on('disconnect', (client: IClient) => {
  console.dir(`Client disconnected ${client.getId()}: ${clients.delete(client)}`)
})

server.listen(PORT)