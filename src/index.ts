import cors, { CorsOptions } from 'cors'
import express, { Request, Response, NextFunction, Application } from 'express'
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
// eslint-disable-next-line no-unused-vars
const allowedList = new Set(['https://web-player.vercel.app', 'https://www.pintopinto.org', 'http://localhost:5000'])
const corsOptions: CorsOptions = {
  origin: (origin: any, callback: any) => {
    return callback(null, true)
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept']
}
const socketOptions: Partial<ServerOptions> = {
  path: `/${KEY}.io`,
  serveClient: false,
  transports: ['websocket', 'polling'],
  cors: corsOptions
}
const generateClientId = (): string => {
  return Math.round(Math.random() * 99).toString(10)
}

const clients: Set<IClient> = new Set()
const app = express()
app.use(cors(corsOptions))
const server = app.listen(PORT)
const socketServer = new SocketServer(server, socketOptions)
const peerServer = ExpressPeerServer(server, { key: KEY })
socketServer.attach(server)

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
  console.dir(`GET / - Request: ${request}`)
  console.dir(`GET / - Response: ${response}`)
  response.redirect(301, `./${KEY}`)
  next()
})

// GET:- Retrieve a new user ID
app.get(`/${KEY}/id`, (request: Request, response: Response, next: NextFunction) => {
  const lastGeneratedId = generateClientId()
  console.dir(`Last Generated Id: ${lastGeneratedId}`)
  response.status(200).json(lastGeneratedId)
  next()
})

// GET:- Client handshake request
app.get('/peerjs', (request: Request, response: Response, next: NextFunction) => {
  const { key, id, token } = request.params
  console.dir(`Key: ${key}`)
  console.dir(`ID: ${id}`)
  console.dir(`Token: ${token}`)
  response.status(200).json('Client handshake request recieved')
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
  socketServer.on('connection', (socket: Socket) => {
    console.dir(socket)
  })
})

peerServer.on('disconnect', (client: IClient) => {
  console.dir(`Client disconnected ${client.getId()}: ${clients.delete(client)}`)
  socketServer.on('disconnect', (socket: Socket) => {
    console.dir(socket)
  })
})