import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'

const PUBLIC_STUN = [{ urls: 'stun:stun.l.google.com:19302' }]
const TOKEN_URL = 'https://api.twilio.com/2010-04-01/Accounts/AC123/Tokens.json'

/** A Twilio token response, trimmed to the fields that matter */
function twilioToken(ttl: string, host = 'global') {
  return {
    ttl,
    ice_servers: [
      {
        url: `stun:${host}.stun.twilio.com:3478`,
        urls: `stun:${host}.stun.twilio.com:3478`
      },
      {
        url: `turn:${host}.turn.twilio.com:3478?transport=udp`,
        urls: `turn:${host}.turn.twilio.com:3478?transport=udp`,
        username: 'user',
        credential: 'secret'
      }
    ]
  }
}

let loads = 0

/**
 * Imports a fresh copy of the module, which reads the Twilio credentials and
 * starts with an empty cache when it loads.
 */
async function load(sid?: string, token?: string) {
  setEnv('TWILIO_ACCOUNT_SID', sid)
  setEnv('TWILIO_AUTH_TOKEN', token)
  const url = new URL(`../src/ice-servers.ts?load=${++loads}`, import.meta.url)
  const module: typeof import('../src/ice-servers.ts') = await import(url.href)
  return module.getIceServers
}

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** What the browser receives, since /config sends the servers as JSON */
function asJson(value: unknown) {
  return JSON.parse(JSON.stringify(value))
}

afterEach(() => {
  mock.restoreAll()
  mock.timers.reset()
  setEnv('TWILIO_ACCOUNT_SID', undefined)
  setEnv('TWILIO_AUTH_TOKEN', undefined)
})

test('without Twilio credentials, returns a public STUN server', async () => {
  const fetch = mock.method(globalThis, 'fetch')
  const getIceServers = await load()

  assert.deepEqual(await getIceServers(), PUBLIC_STUN)
  assert.equal(fetch.mock.callCount(), 0)
})

test('needs both the Twilio account SID and auth token', async () => {
  const fetch = mock.method(globalThis, 'fetch')

  assert.deepEqual(await (await load('AC123'))(), PUBLIC_STUN)
  assert.deepEqual(await (await load(undefined, 'token'))(), PUBLIC_STUN)
  assert.equal(fetch.mock.callCount(), 0)
})

test('asks Twilio for a token and returns its STUN and TURN servers', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () =>
    Response.json(twilioToken('86400'))
  )
  const getIceServers = await load('AC123', 'token')

  assert.deepEqual(asJson(await getIceServers()), [
    { urls: 'stun:global.stun.twilio.com:3478' },
    {
      urls: 'turn:global.turn.twilio.com:3478?transport=udp',
      username: 'user',
      credential: 'secret'
    }
  ])
  assert.equal(fetch.mock.callCount(), 1)
  const [url, init] = fetch.mock.calls[0].arguments
  assert.equal(url, TOKEN_URL)
  assert.equal(init?.method, 'POST')
  assert.deepEqual(init?.headers, {
    Authorization: `Basic ${Buffer.from('AC123:token').toString('base64')}`
  })
})

test('reuses the servers for half of their lifetime', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 })
  const tokens = [twilioToken('100', 'first'), twilioToken('100', 'second')]
  const fetch = mock.method(globalThis, 'fetch', async () =>
    Response.json(tokens[fetch.mock.callCount()])
  )
  const getIceServers = await load('AC123', 'token')

  const first = await getIceServers()
  assert.equal(first[0].urls, 'stun:first.stun.twilio.com:3478')

  mock.timers.tick(49_999)
  assert.equal(await getIceServers(), first)
  assert.equal(fetch.mock.callCount(), 1)

  mock.timers.tick(1)
  const second = await getIceServers()
  assert.equal(second[0].urls, 'stun:second.stun.twilio.com:3478')
  assert.equal(fetch.mock.callCount(), 2)
})

test('falls back to STUN when Twilio answers with an error', async () => {
  const error = mock.method(console, 'error', () => {})
  const fetch = mock.method(globalThis, 'fetch', async () =>
    Response.json({ message: 'Authenticate' }, { status: 401 })
  )
  const getIceServers = await load('AC123', 'wrong')

  assert.deepEqual(await getIceServers(), PUBLIC_STUN)
  const [message, cause] = error.mock.calls[0].arguments
  assert.equal(message, 'Could not get ICE servers from Twilio')
  assert.equal((cause as Error).message, 'Twilio responded with 401')

  // Failures are not cached, so the next call asks Twilio again
  await getIceServers()
  assert.equal(fetch.mock.callCount(), 2)
})

test('falls back to STUN when Twilio cannot be reached', async () => {
  const error = mock.method(console, 'error', () => {})
  mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed')
  })
  const getIceServers = await load('AC123', 'token')

  assert.deepEqual(await getIceServers(), PUBLIC_STUN)
  assert.equal(error.mock.callCount(), 1)
})
