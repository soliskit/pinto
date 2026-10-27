# Pinto

Browser video calls, with camera and photo controls.

Share a room link and talk with friends. Pinto uses WebRTC to send audio and video between browsers.

The Node server serves the app and helps browsers connect. A STUN server finds a browser's public address. A TURN server relays a call when browsers cannot connect directly. The server:

- serves plain HTML, CSS, and JavaScript, with no build step
- uses [PeerJS](https://peerjs.com/) to help browsers set up calls
- uses [Socket.IO](https://socket.io/) for room updates
- gives browsers connection settings, including Twilio relays when configured

## Run locally

- [Node.js](https://nodejs.org) `22.18` or newer in the 22 line (npm comes with it). Node runs the TypeScript source directly, so nothing needs building

### Start the server

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
3. **Join** sends the room name and peer id. The server rejects an id already held by another connection in the same room, returns the room roster, and tells existing members about the newcomer. The page answers calls only from that roster.
4. Media usually flows directly between browsers, or through a TURN relay when a direct link is blocked. **Leave** stops capture and reconnects the room socket; when the server sees a disconnect, it tells the room which ids that connection owned.

Before joining, the camera and microphone buttons choose how you join; they do not start capture. Join requests the chosen devices. Camera off and Mute stop the affected track. With the camera off, others see a placeholder or the photo chosen through your preview. These source behaviors do not establish physical indicators or audible sound on real devices.

## Project layout

| Path                        | What it is                                                 |
| --------------------------- | ---------------------------------------------------------- |
| `src/index.ts`              | The server: static files, `/config`, PeerJS, and Socket.IO |
| `src/ice-servers.ts`        | Fetches STUN and TURN servers from Twilio, with a fallback |
| `public/`                   | The web client, served as is                               |
| `public/home.js`            | Home page: clock and room name form                        |
| `public/room.js`            | Room page: camera, microphone, calls, and controls         |
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

Without both Twilio settings, or if the request to Twilio fails, the server returns Google's public STUN server. A direct connection may work without a relay. Networks that block it need a TURN relay.

## Endpoints

| Path                          | Description                                                            |
| ----------------------------- | ---------------------------------------------------------------------- |
| `/`                           | Home page                                                              |
| `/room/<name>`                | Room page                                                              |
| `/config`                     | `{ key, iceServers }` for the client                                   |
| `/<KEY>/id`                   | New PeerJS client id                                                   |
| `/peerjs`                     | PeerJS WebSocket                                                       |
| `/socket.io`                  | Socket.IO, with `join-room`, `user-connected`, and `user-disconnected` |
| `/vendor/peerjs.min.js`       | PeerJS browser client, served from `node_modules`                      |
| `/socket.io/socket.io.min.js` | Socket.IO browser client, served by Socket.IO                          |

## Writing TypeScript and JavaScript

The server is TypeScript, and Node strips the types at startup. Only syntax that can be erased works, so import types with `import type` and avoid `enum`, `namespace`, and parameter properties. `tsconfig.json` enforces this with `verbatimModuleSyntax` and `erasableSyntaxOnly`.

The client is plain JavaScript with types in JSDoc comments, checked by `tsconfig.client.json`. Start each file with `// @ts-check` and describe types in comments, for example `/** @param {string} peerId */`.

`npm run typecheck` checks both.

## Testing

```bash
npm test
```

Node's built-in test runner runs every `test/*.test.ts` file. Like the server, the tests are TypeScript that Node runs directly. To run one file, use `node --test test/room.test.ts`.

| File                       | What it tests                                                                   |
| -------------------------- | ------------------------------------------------------------------------------- |
| `test/server.test.ts`      | The server in its own process: pages, `/config`, PeerJS, and Socket.IO rooms    |
| `test/ice-servers.test.ts` | Getting servers from Twilio, caching them, and falling back, with `fetch` faked |
| `test/ordinal.test.ts`     | `ordinal()`                                                                     |
| `test/element.test.ts`     | `element()`, in the browser                                                     |
| `test/home.test.ts`        | The home page clock and room name form                                          |
| `test/room.test.ts`        | The room page: controls, photos, calls between pages, and reconnecting          |
| `test/helpers.ts`          | Starts the server and Chromium for the tests                                    |

The browser tests drive Chromium through [Playwright](https://playwright.dev), with a fake camera and microphone, and make real calls between pages. Install Chromium for Playwright once:

```bash
npx playwright install chromium
```

To use a Chromium you already have, set `CHROMIUM_PATH` to its executable.

GitHub Actions runs type checks, lint and the regular suite on pushes to `main` and on pull requests. `.github/workflows/test.yml` also runs a WebKit trial of the home and element tests on main pushes only; it does not test camera or microphone calls. The slow workflow runs the three capture and call-access checks when `src/`, `public/` or `test/` changes, and always reports a result job.

## Scripts

| Command             | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `npm run dev`       | Run with `node --watch`                                |
| `npm start`         | Run the server                                         |
| `npm test`          | Run the regular tests                                  |
| `npm run test:slow` | Run the capture and call-access diagnostics             |
| `npm run typecheck` | Type check the server and the client (no output files) |
| `npm run lint`      | Lint with ESLint                                       |
| `npm run format`    | Format files with Prettier                             |

## Deployment

### Render (free)

`render.yaml` sets the app up as a free Render web service.

1. Sign in at [render.com](https://render.com) with GitHub.
2. Choose **New**, then **Blueprint**, and pick this repo. Render reads `render.yaml`, installs production dependencies and runs `npm start`.
3. Open the `onrender.com` address Render gives you. It uses HTTPS, which browsers require for camera access.

The Render service automatically deployed the October 26 capture-fix merge. That observation is not a guarantee for every future push. Render's October 21 documentation check in the [Evidence Record](docs/evidence-record.md) describes free-service sleep and wake-up behavior; neither wake-up time nor the effect on a live call was measured there.

To add TURN relays, set `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` under the service's **Environment** tab. Twilio charges for TURN usage.

### Other hosts

Other hosts need to run Node 22.18 or newer in the 22 line as one long-running process.

## License

[MIT](LICENSE.md)

## Contributing

See [Writing commits and pull requests](docs/contributing.md) for the message standard, optional per-clone editor setup and required description review.
