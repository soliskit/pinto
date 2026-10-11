# Pinto

Pinto is a browser-based video calling app built with WebRTC. Share a room link, talk with friends, and switch between camera video and a photo.

WebRTC lets browsers send video straight to each other. A STUN server tells a browser its public address. A TURN server relays the call when a direct link is blocked. One small Node server does all the work:

- serves the web client: plain HTML, CSS, and JavaScript, with no build step
- runs a [PeerJS](https://peerjs.com/) server, which helps browsers set up WebRTC connections with each other
- runs a [Socket.IO](https://socket.io/) server, which sends live updates and tracks who is in each room
- gives browsers STUN and TURN servers, from Twilio when you set it up

## Requirements

- [Node.js](https://nodejs.org) `22.18` or newer in the 22 line (npm comes with it). Node runs the TypeScript source directly, so nothing needs building

## Getting started

Install the dependencies:

```bash
npm install
```

Start the development server. It restarts on every server change. After you edit a file in `public/`, refresh the browser:

```bash
PORT=4000 npm run dev
```

Open [http://localhost:4000](http://localhost:4000). Type a room name, or press **Open** for a random one, then share the room link. Without `PORT`, the server listens on 443.

## How a call works

1. The room page fetches `/config` for the PeerJS key and the STUN and TURN servers.
2. It connects to the PeerJS server, which gives it a random peer id, and to Socket.IO.
3. **Join** emits `join-room` with the room name and peer id. The server tells everyone already in the room with `user-connected`, and they call the new peer.
4. Video and audio then usually flow directly between browsers, or through a TURN server when a direct link is blocked. **Leave** or closing the tab sends `user-disconnected` to the room.

With your camera off, others see a placeholder. Click your own preview to show a photo instead.

## Project layout

| Path                        | What it is                                                 |
| --------------------------- | ---------------------------------------------------------- |
| `src/index.ts`              | The server: static files, `/config`, PeerJS, and Socket.IO  |
| `src/ice-servers.ts`        | Fetches STUN and TURN servers from Twilio, with a fallback |
| `public/`                   | The web client, served as is                               |
| `public/home.js`            | Home page: clock and room name form                        |
| `public/room.js`            | Room page: camera, microphone, calls, and controls          |
| `public/element.js`         | Finds an element by id and checks its type                 |
| `public/ordinal.js`         | 1st, 2nd, 3rd for the room page's count of people          |
| `types/client-globals.d.ts` | Types for the `Peer` and `io` globals the room page loads  |
| `test/`                     | Tests, described under [Testing](#testing)                 |
| `tsconfig.json`             | Type check settings for the server and the tests           |
| `tsconfig.client.json`      | Type check settings for the client in `public/`            |
| `eslint.config.mjs`         | ESLint settings, run by `npm run lint`                     |
| `render.yaml`               | Render Blueprint, see [Deployment](#deployment)            |

## Configuration

| Variable             | Default | Purpose                                                          |
| -------------------- | ------- | ---------------------------------------------------------------- |
| `PORT`               | `443`   | Port the HTTP server listens on                                  |
| `KEY`                | `pinto` | PeerJS key; the PeerJS API lives under `/<KEY>`                  |
| `TWILIO_ACCOUNT_SID` |         | With `TWILIO_AUTH_TOKEN`, enables Twilio's STUN and TURN servers |
| `TWILIO_AUTH_TOKEN`  |         | Twilio auth token                                                |

Without Twilio credentials, browsers get a public STUN server only. That works for most home networks. Calls between people on strict corporate or mobile networks need a TURN relay.

## Endpoints

| Path                          | Description                                                           |
| ----------------------------- | --------------------------------------------------------------------- |
| `/`                           | Home page                                                             |
| `/room/<name>`                | Room page                                                             |
| `/config`                     | `{ key, iceServers }` for the client                                  |
| `/<KEY>/id`                   | New PeerJS client id                                                  |
| `/peerjs`                     | PeerJS WebSocket                                                      |
| `/socket.io`                  | Socket.IO, with `join-room`, `user-connected`, and `user-disconnected` |
| `/vendor/peerjs.min.js`       | PeerJS browser client, served from `node_modules`                     |
| `/socket.io/socket.io.min.js` | Socket.IO browser client, served by Socket.IO                         |

## Writing TypeScript and JavaScript

The server is TypeScript, and Node strips the types at startup. Only syntax that can be erased works, so import types with `import type` and avoid `enum`, `namespace`, and parameter properties. `tsconfig.json` enforces this with `verbatimModuleSyntax` and `erasableSyntaxOnly`.

The client is plain JavaScript with types in JSDoc comments, checked by `tsconfig.client.json`. Start each file with `// @ts-check` and describe types in comments, for example `/** @param {string} peerId */`.

`npm run typecheck` checks both.

## Testing

```bash
npm test
```

Node's built-in test runner runs every `test/*.test.ts` file. Like the server, the tests are TypeScript that Node runs directly. To run one file, use `node --test test/room.test.ts`.

| File                       | What it tests                                                                  |
| -------------------------- | ------------------------------------------------------------------------------ |
| `test/server.test.ts`      | The server in its own process: pages, `/config`, PeerJS, and Socket.IO rooms    |
| `test/ice-servers.test.ts` | Getting servers from Twilio, caching them, and falling back, with `fetch` faked |
| `test/ordinal.test.ts`     | `ordinal()`                                                                    |
| `test/element.test.ts`     | `element()`, in the browser                                                    |
| `test/home.test.ts`        | The home page clock and room name form                                         |
| `test/room.test.ts`        | The room page: controls, photos, calls between pages, and reconnecting          |
| `test/helpers.ts`          | Starts the server and Chromium for the tests                                   |

The browser tests drive Chromium through [Playwright](https://playwright.dev), with a fake camera and microphone, and make real calls between pages. Install Chromium for Playwright once:

```bash
npx playwright install chromium
```

To use a Chromium you already have, set `CHROMIUM_PATH` to its executable.

GitHub Actions runs the type check, lint, and tests on every push and on pull requests from forks. The workflow is `.github/workflows/test.yml`.

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

`render.yaml` sets the app up as a free Render web service.

1. Sign in at [render.com](https://render.com) with GitHub.
2. Choose **New**, then **Blueprint**, and pick this repo. Render reads `render.yaml`, installs production dependencies and runs `npm start`.
3. Open the `onrender.com` address Render gives you. It uses HTTPS, which browsers require for camera access.

Every push to `main` deploys again. A free service sleeps after 15 minutes without traffic, and the next visit takes about a minute to wake it. An active call keeps it awake.

To add TURN relays, set `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` under the service's **Environment** tab. Twilio charges for TURN usage.

### Other hosts

Any host that runs Node 22.18 or newer as one long-running process works.

## License

[GPL 3.0](LICENSE.md)
