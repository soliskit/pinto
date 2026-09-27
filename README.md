# Pinto

WebRTC signal server for [Pinto Pinto](https://github.com/soliskit/pinto-meet). It runs a [PeerJS](https://peerjs.com/) server and a [Socket.IO](https://socket.io/) server on one Express 5 app, so browsers can find each other and join rooms.

## Requirements

- [Node.js](https://nodejs.org) `22.x` (npm comes with it)
- [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli), only needed to run the Procfile locally or to deploy

## Getting started

Install dependencies:

```bash
npm install
```

Start the development server. It compiles once, then Nodemon restarts it whenever a file in `src` changes:

```bash
npm run dev
```

The server listens on [http://localhost:443](http://localhost:443) by default. Set `PORT` to use another one.

## Configuration

| Variable          | Default | Purpose                                                                               |
| ----------------- | ------- | ------------------------------------------------------------------------------------- |
| `PORT`            | `443`   | Port the HTTP server listens on                                                       |
| `KEY`             | `pinto` | PeerJS key. Also sets the PeerJS path (`/<KEY>`) and the Socket.IO path (`/<KEY>.io`) |
| `VERCEL_URL`      |         | Preview host of the client, added to the CORS allow list                              |
| `HEROKU_APP_NAME` |         | Used for the URL printed at startup on Heroku review apps                             |

Requests are accepted from `http://localhost:4000`, `https://pintopinto.org`, `https://meet.pintopinto.org` and `https://$VERCEL_URL`. Edit `allowedList` in `src/index.ts` to change that.

## Endpoints

| Path           | Description                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `/<KEY>/id`    | New PeerJS client id                                                                                                                       |
| `/<KEY>/peers` | Connected PeerJS ids (discovery is on)                                                                                                     |
| `/<KEY>.io`    | Socket.IO. Clients emit `join-room` with a room id and peer id; the server broadcasts `user-connected` and `user-disconnected` to the room |

## Scripts

| Command         | Description                                              |
| --------------- | -------------------------------------------------------- |
| `npm run dev`   | Build, then run with Nodemon and ts-node                 |
| `npm run build` | Compile TypeScript into `build/`                         |
| `npm start`     | Run the compiled server                                  |
| `npm run lint`  | Lint with ESLint                                         |
| `npm run prod`  | Run the Procfile locally with `heroku local` on port 443 |
| `npm run logs`  | Tail the Heroku app logs                                 |

## Deployment

The app deploys to Heroku with the Node.js buildpack. `npm run build` runs during the build and the `web` process in `Procfile` starts `build/index.js`. `app.json` holds the defaults for review apps.

## License

[GPL 3.0](LICENSE.md)
