import cors, { CorsOptions } from 'cors'
import express, { Request, Response, NextFunction, Application } from 'express'
import { ExpressPeerServer } from 'peer'
import { EventEmitter } from 'events'
import WebSocketLib from 'ws'

declare type MyWebSocket = WebSocketLib & EventEmitter
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
const whitelist = new Set(['https://web-player.vercel.app', 'https://www.pintopinto.org', 'https://pintopinto.herokuapp.com'])
const corsOptions: CorsOptions = {
  origin: (origin: any, callback: any) => {
    if (whitelist.has(origin)) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept']
}
const generateClientId = (): string => {
  return Math.round(Math.random() * 99).toString(10)
}

const clients: Set<IClient> = new Set()
const app = express()
const server = app.listen(PORT)
const peerServer = ExpressPeerServer(server, { key: KEY })
app.use(cors(corsOptions))

peerServer.on('mount', (app: Application) => {
  let url: string
  if (app.settings.env === 'development') {
    url = `http://localhost:${PORT}/${KEY}`
  } else {
    url = `https://pintopinto.herokuapp.com/${KEY}`
  }
  console.log(`Started ExpressPeerServer on port: ${PORT} --- ${url}`)
})

app.use(`/${KEY}`, peerServer)

// GET:- Redirect to welcome page
app.get('/', (request: Request, response: Response, next: NextFunction) => {
  response.redirect(301, `./${KEY}`)
  next()
})

// GET:- Retrieve a new user ID
app.get(`/${KEY}/id`, (request: Request, response: Response, next: NextFunction) => {
  response.status(200).json(generateClientId())
  next()
})

// GET:- List of all connected peers
app.get(`/${KEY}/peers`, (request: Request, response: Response, next: NextFunction) => {
  if (clients.size === 0) {
    response.status(200).json('[]')
  } else {
    response.status(200).json(clients.size)
  }
  next()
})

peerServer.on('connection', (client: IClient) => {
  clients.add(client)
  console.dir(`Client connected ${client.getId()}`)
})

peerServer.on('disconnect', (client: IClient) => {
  console.dir(`Client disconnected ${client.getId()}: ${clients.delete(client)}`)
})