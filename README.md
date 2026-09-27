# Pinto Pinto

Video calls in the browser. One small Node server does everything:

- serves the web client, plain HTML, CSS and JavaScript with no build step
- runs a [PeerJS](https://peerjs.com/) server so browsers can connect to each other directly over WebRTC
- runs a [Socket.IO](https://socket.io/) server that tracks who is in each room
- hands browsers STUN and TURN servers, from Twilio when configured

## Requirements

- [Node.js](https://nodejs.org) `22.18` or newer in the 22 line (npm comes with it). Node runs the TypeScript source directly, so there is no build step
- [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli), only needed to run the Procfile locally or to deploy

## Getting started

Install dependencies:

```bash
npm install
```

Start the development server. Node restarts it whenever a server file changes; refresh the browser after editing files in `public/`:

```bash
PORT=4000 npm run dev
```

Open [http://localhost:4000](http://localhost:4000). Type a room name, or press **Open** to get a random one, and share the room link. Without `PORT` the server listens on 443.

## How a call works

1. The room page fetches `/config` for the PeerJS key and the STUN and TURN servers.
2. It connects to the PeerJS server, which gives it a random peer id, and to Socket.IO.
3. **Join Now** emits `join-room` with the room name and peer id. The server tells everyone already in the room with `user-connected`, and they call the new peer.
4. Video and audio then flow directly between browsers. **End** or closing the tab sends `user-disconnected` to the room.

While the camera is off, peers see a placeholder image. Click your own preview to show a photo instead.

## Project layout

| Path                        | What it is                                                 |
| --------------------------- | ---------------------------------------------------------- |
| `src/index.ts`              | The server: static files, `/config`, PeerJS and Socket.IO  |
| `src/ice-servers.ts`        | Fetches STUN and TURN servers from Twilio, with a fallback |
| `public/`                   | The web client, served as is                               |
| `public/home.js`            | Home page: clock and room name form                        |
| `public/room.js`            | Room page: camera, microphone, calls and controls          |
| `types/client-globals.d.ts` | Types for the `Peer` and `io` globals the room page loads  |

## Configuration

| Variable             | Default | Purpose                                                          |
| -------------------- | ------- | ---------------------------------------------------------------- |
| `PORT`               | `443`   | Port the HTTP server listens on                                  |
| `KEY`                | `pinto` | PeerJS key; the PeerJS API lives under `/<KEY>`                  |
| `TWILIO_ACCOUNT_SID` |         | With `TWILIO_AUTH_TOKEN`, enables Twilio's STUN and TURN servers |
| `TWILIO_AUTH_TOKEN`  |         | Twilio auth token                                                |

Without Twilio credentials, browsers get a public STUN server only. That works for most home networks, but calls between people behind strict corporate or mobile networks need a TURN relay to connect.

## Endpoints

| Path                          | Description                                                           |
| ----------------------------- | --------------------------------------------------------------------- |
| `/`                           | Home page                                                             |
| `/room/<name>`                | Room page                                                             |
| `/config`                     | `{ key, iceServers }` for the client                                  |
| `/<KEY>/id`                   | New PeerJS client id                                                  |
| `/peerjs`                     | PeerJS WebSocket                                                      |
| `/socket.io`                  | Socket.IO, with `join-room`, `user-connected` and `user-disconnected` |
| `/vendor/peerjs.min.js`       | PeerJS browser client, served from `node_modules`                     |
| `/socket.io/socket.io.min.js` | Socket.IO browser client, served by Socket.IO                         |

## Writing TypeScript and JavaScript

The server is TypeScript that Node runs by stripping the types at startup, so only syntax that can be erased works: import types with `import type`, and avoid `enum`, `namespace` and parameter properties. `tsconfig.json` enforces this with `verbatimModuleSyntax` and `erasableSyntaxOnly`.

The client is plain JavaScript with types in JSDoc comments, checked by `tsconfig.client.json`. Start each file with `// @ts-check` and describe types in comments, for example `/** @param {string} peerId */`.

`npm run typecheck` checks both.

## Scripts

| Command             | Description                                              |
| ------------------- | -------------------------------------------------------- |
| `npm run dev`       | Run with `node --watch`                                  |
| `npm start`         | Run the server                                           |
| `npm run typecheck` | Type check the server and the client (no output files)   |
| `npm run lint`      | Lint with ESLint                                         |
| `npm run format`    | Format files with Prettier                               |
| `npm run prod`      | Run the Procfile locally with `heroku local` on port 443 |
| `npm run logs`      | Tail the Heroku app logs                                 |

## Deployment

### Render (free)

`render.yaml` describes the app as a free Render web service.

1. Sign in at [render.com](https://render.com) with GitHub.
2. Choose **New**, then **Blueprint**, and pick this repo. Render reads `render.yaml`, installs production dependencies and runs `npm start`.
3. Open the `onrender.com` address Render gives you. It is HTTPS, which browsers require for camera access.

Every push to `main` deploys again. Free services sleep after 15 minutes without traffic, and the next visit takes about a minute to wake them. An active call keeps the service awake.

To add TURN relays later, set `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` under the service's **Environment** tab. Twilio bills for TURN usage.

### Other hosts

Any host that runs Node 22.18 or newer as a single long running process works. `Procfile` and `app.json` are there for Heroku.

## License

[GPL 3.0](LICENSE.md)
