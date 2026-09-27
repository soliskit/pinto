# Pinto

WebRTC signal server for [Pinto Pinto](https://github.com/soliskit/pinto-meet). It runs a [PeerJS](https://peerjs.com/) server and a [Socket.IO](https://socket.io/) server on one Express 5 app, so browsers can find each other and join rooms.

## Requirements

- [Node.js](https://nodejs.org) `22.18` or newer in the 22 line (npm comes with it). Node runs the TypeScript source directly, so there is no build step
- [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli), only needed to run the Procfile locally or to deploy

## Getting started

Install dependencies:

```bash
npm install
```

Start the development server. Node restarts it whenever a file it loads changes:

```bash
npm run dev
```

The server listens on [http://localhost:443](http://localhost:443) by default. Set `PORT` to use another one.

### Writing TypeScript

Node strips the types at startup instead of compiling them, so only syntax that can be erased works: import types with `import type`, and avoid `enum`, `namespace` and parameter properties. `tsconfig.json` enforces this with `verbatimModuleSyntax` and `erasableSyntaxOnly`, so `npm run typecheck` flags anything Node can't run.

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

| Command             | Description                                              |
| ------------------- | -------------------------------------------------------- |
| `npm run dev`       | Run with `node --watch`                                  |
| `npm start`         | Run the server                                           |
| `npm run typecheck` | Type check with `tsc` (no output files)                  |
| `npm run lint`      | Lint with ESLint                                         |
| `npm run format`    | Format files with Prettier                               |
| `npm run prod`      | Run the Procfile locally with `heroku local` on port 443 |
| `npm run logs`      | Tail the Heroku app logs                                 |

## Deployment

The app deploys to Heroku with the Node.js buildpack. There is no build step: the `web` process in `Procfile` runs `src/index.ts` directly. `app.json` holds the defaults for review apps.

## License

[GPL 3.0](LICENSE.md)
