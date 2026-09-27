# Pinto Pinto

Video calls in the browser. One small Node server does everything:

- serves the web client, plain HTML, CSS and JavaScript with no build step
- runs a [PeerJS](https://peerjs.com/) server so browsers can connect to each other directly over WebRTC
- runs a [Socket.IO](https://socket.io/) server that tracks who is in each room
- hands browsers STUN and TURN servers, from Twilio when configured

## Requirements

- [Node.js](https://nodejs.org) `22.18` or newer in the 22 line (npm comes with it). Node runs the TypeScript source directly, so there is no build step

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
| `public/element.js`         | Finds an element by id and checks its type                 |
| `public/ordinal.js`         | 1st, 2nd, 3rd for the room page's count of people          |
| `types/client-globals.d.ts` | Types for the `Peer` and `io` globals the room page loads  |
| `test/`                     | Tests, described under [Testing](#testing)                 |

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

## Testing

```bash
npm test
```

Node's built in test runner runs every `test/*.test.ts` file. Like the server, the tests are TypeScript that Node runs directly. To run one file, use `node --test test/room.test.ts`.

| File                       | What it tests                                                                  |
| -------------------------- | ------------------------------------------------------------------------------ |
| `test/server.test.ts`      | The server in its own process: pages, `/config`, PeerJS and Socket.IO rooms    |
| `test/ice-servers.test.ts` | Getting servers from Twilio, caching them and falling back, with `fetch` faked |
| `test/ordinal.test.ts`     | `ordinal()`                                                                    |
| `test/element.test.ts`     | `element()`, in the browser                                                    |
| `test/home.test.ts`        | The home page clock and room name form                                         |
| `test/room.test.ts`        | The room page: controls, photos, calls between pages and reconnecting          |
| `test/helpers.ts`          | Starts the server and Chromium for the tests                                   |

The browser tests drive Chromium through [Playwright](https://playwright.dev), with a fake camera and microphone, and make real calls between pages. Install Chromium for Playwright once:

```bash
npx playwright install chromium
```

To use a Chromium that is already installed instead, set `CHROMIUM_PATH` to its executable.

GitHub Actions runs the type check, lint and tests on every push, and on pull requests from forks, with `.github/workflows/test.yml`.

## Scripts

| Command             | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `npm run dev`       | Run with `node --watch`                                |
| `npm start`         | Run the server                                         |
| `npm test`          | Run the tests                                          |
| `npm run typecheck` | Type check the server and the client (no output files) |
| `npm run lint`      | Lint with ESLint                                       |
| `npm run format`    | Format files with Prettier                             |

## Deployment

### Render (free)

`render.yaml` describes the app as a free Render web service.

1. Sign in at [render.com](https://render.com) with GitHub.
2. Choose **New**, then **Blueprint**, and pick this repo. Render reads `render.yaml`, installs production dependencies and runs `npm start`.
3. Open the `onrender.com` address Render gives you. It is HTTPS, which browsers require for camera access.

Every push to `main` deploys again. Free services sleep after 15 minutes without traffic, and the next visit takes about a minute to wake them. An active call keeps the service awake.

To add TURN relays later, set `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` under the service's **Environment** tab. Twilio bills for TURN usage.

### Other hosts

Any host that runs Node 22.18 or newer as a single long running process works.

## License

[GPL 3.0](LICENSE.md)
