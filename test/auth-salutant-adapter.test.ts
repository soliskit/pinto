// Fake tests for the isolated Salutant sign-in adapter. Fakes only: an
// in-test Ed25519 key pair, a controllable clock, a fake JWKS fetch with
// injectable failure and a settable epoch, and an in-memory store with
// injectable write failures. No real address, code, proof or secret
// appears here (R10). Test definitions: the first-slice preparation.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  fixedDigestEqual,
  SalutantSignInAdapter,
  type AdapterConfig,
  type AdapterStore,
  type JwksResponse,
  type StoreTxn,
  type StoreKey,
  type StorePrefix,
  type StoreRecords
} from '../src/auth/salutant-adapter.ts'

/** Fails the test with the field named when a flow response lacks it */
function required<T>(value: T | null | undefined, field: string): T {
  assert.ok(value, `required field missing: ${field}`)
  return value
}

const APP_ORIGIN = 'https://app.example.test'
const SERVICE_ORIGIN = 'https://salutant.example.test'
const encoder = new TextEncoder()
// Fixed test constant for the state HMAC key, not a secret.
const HMAC_KEY = new Uint8Array(32).fill(7)
const DAY_MS = 24 * 60 * 60_000

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function encodeJson(value: unknown): string {
  return toBase64Url(encoder.encode(JSON.stringify(value)))
}

// Atomic in-memory store, test-only. Reads hand back copies; writes are
// staged and commit only when the transaction returns, so a throw leaves
// no partial state. It models the required atomicity but cannot prove it
// for any production store.
class FakeStore implements AdapterStore {
  private data = new Map<StoreKey, StoreRecords[StoreKey]>()
  failOnSetPrefix: string | null = null
  failOnDelete = false
  failTransact = false

  transact<T>(fn: (txn: StoreTxn) => T): T {
    if (this.failTransact) {
      this.failTransact = false
      throw new Error('store unavailable')
    }
    const shadow = new Map<StoreKey, StoreRecords[StoreKey]>()
    for (const [key, value] of this.data)
      shadow.set(key, structuredClone(value))
    const failOnSetPrefix = this.failOnSetPrefix
    this.failOnSetPrefix = null
    const failOnDelete = this.failOnDelete
    this.failOnDelete = false
    const txn: StoreTxn = {
      // Both maps are private and receive values only through typed set.
      // Cloning preserves the key's record shape; the assertion expresses
      // that key/value correlation, which Map's union value type loses.
      get: <K extends StoreKey>(key: K): StoreRecords[K] | undefined => {
        const value = shadow.get(key)
        return value === undefined
          ? undefined
          : (structuredClone(value) as StoreRecords[K])
      },
      set: (key, value) => {
        if (failOnSetPrefix && key.startsWith(failOnSetPrefix)) {
          throw new Error('write failed')
        }
        shadow.set(key, structuredClone(value))
      },
      delete: (key) => {
        if (failOnDelete) throw new Error('delete failed')
        shadow.delete(key)
      },
      keysWithPrefix: <P extends StorePrefix>(prefix: P) =>
        [...shadow.keys()].filter((key): key is `${P}${string}` =>
          key.startsWith(prefix)
        )
    }
    const result = fn(txn)
    this.data = shadow
    return result
  }

  keysWithPrefix(prefix: string): string[] {
    return [...this.data.keys()].filter((key) => key.startsWith(prefix))
  }
}

interface ServiceKey {
  pair: CryptoKeyPair
  publicJwk: JsonWebKey & { kid?: string }
}

async function mintServiceKey(kid = 'k1'): Promise<ServiceKey> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify'
  ])
  const publicJwk: JsonWebKey & { kid?: string } =
    await crypto.subtle.exportKey('jwk', pair.publicKey)
  publicJwk.kid = kid
  return { pair, publicJwk }
}

async function signProof(
  pair: CryptoKeyPair,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'EdDSA', kid: 'k1' }
): Promise<string> {
  const headerPart = encodeJson(header)
  const payloadPart = encodeJson(claims)
  const signature = await crypto.subtle.sign(
    'Ed25519',
    pair.privateKey,
    encoder.encode(`${headerPart}.${payloadPart}`)
  )
  return `${headerPart}.${payloadPart}.${toBase64Url(new Uint8Array(signature))}`
}

interface JwksHold {
  entered: boolean
  open: () => void
}

function makeJwks(publicJwk: JsonWebKey, epoch = 1) {
  const control = {
    epoch,
    fail: false,
    fetches: 0,
    hold: null as JwksHold | null
  }
  const fetchJwks = async (): Promise<JwksResponse> => {
    control.fetches++
    if (control.hold) {
      const hold = control.hold
      control.hold = null
      hold.entered = true
      await new Promise<void>((resolve) => {
        hold.open = resolve
      })
    }
    if (control.fail) throw new Error('jwks unavailable')
    return { keys: [structuredClone(publicJwk)], epoch: control.epoch }
  }
  return { fetchJwks, control }
}

// Gates a Web Crypto method so a test can observe a call, run a concurrent
// step, then release it. Restored in finally in every user.
function gateSubtleMethod(method: 'sign' | 'verify') {
  const subtle = globalThis.crypto.subtle
  const original = Reflect.get(subtle, method) as (
    ...args: unknown[]
  ) => Promise<unknown>
  const bound = original.bind(subtle)
  const ownDescriptor = Object.getOwnPropertyDescriptor(subtle, method)
  let called = false
  let openGate: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    openGate = resolve
  })
  const gated = (...args: unknown[]) => {
    called = true
    return gate.then(() => bound(...args))
  }
  Object.defineProperty(subtle, method, {
    configurable: true,
    writable: true,
    value: gated
  })
  return {
    async waitForCall(): Promise<void> {
      for (let i = 0; i < 10_000 && !called; i++) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      if (!called) throw new Error(`timed out waiting for ${method} call`)
    },
    open(): void {
      openGate()
    },
    restore(): void {
      if (ownDescriptor) {
        Object.defineProperty(subtle, method, ownDescriptor)
      } else {
        // The original was inherited; remove only the injected own value.
        Reflect.deleteProperty(subtle, method)
      }
    }
  }
}

async function makeAdapter(
  options: {
    store?: FakeStore
    now?: { value: number }
    key?: ServiceKey
    jwks?: ReturnType<typeof makeJwks>
    config?: Partial<AdapterConfig>
  } = {}
) {
  const store = options.store ?? new FakeStore()
  const now = options.now ?? { value: 1_700_000_000_000 }
  const key = options.key ?? (await mintServiceKey())
  const jwks = options.jwks ?? makeJwks(key.publicJwk)
  const adapter = new SalutantSignInAdapter({
    origin: APP_ORIGIN,
    serviceOrigin: SERVICE_ORIGIN,
    fetchJwks: jwks.fetchJwks,
    store,
    stateHmacKeyBytes: HMAC_KEY,
    clock: () => now.value,
    config: options.config
  })
  await adapter.ready()
  return { adapter, store, now, key, jwks }
}

type Context = Awaited<ReturnType<typeof makeAdapter>>

function validClaims(
  stateId: string,
  nowMs: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const nowSec = Math.floor(nowMs / 1000)
  return {
    iss: SERVICE_ORIGIN,
    aud: APP_ORIGIN,
    sub: 'subject-1',
    nonce: stateId,
    jti: `proof-${stateId}`,
    iat: nowSec - 1,
    nbf: nowSec - 1,
    exp: nowSec + 300,
    epoch: 1,
    ...overrides
  }
}

async function driveValidExchange(ctx: Context) {
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value)
  )
  const exchange = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  return { start, proof, exchange }
}

async function driveValidSignIn(ctx: Context) {
  const { start, exchange } = await driveValidExchange(ctx)
  assert.equal(exchange.status, 200)
  const complete = await ctx.adapter.handleComplete(`pre=${start.cookieValue}`)
  return { start, exchange, complete }
}

// Valid path

void test('valid sign-in end to end', async () => {
  const ctx = await makeAdapter()
  const { start, exchange, complete } = await driveValidSignIn(ctx)
  assert.equal(exchange.acao, SERVICE_ORIGIN)
  assert.equal(complete.status, 200)
  assert.equal(complete.body.sub, 'subject-1')
  assert.ok(complete.body.sessionId)
  const session = await ctx.adapter.getSession(complete.body.sessionId)
  assert.equal(session?.sub, 'subject-1')
  assert.equal(session.epoch, 1)
  assert.equal(ctx.store.keysWithPrefix('session:').length, 1)
  assert.equal(
    complete.setCookie,
    `sess=${complete.body.sessionId}; Path=/; Secure; HttpOnly; SameSite=Lax`
  )
  // The redemption record links the proof id, its time and the session it
  // produced (R4).
  const redemption = ctx.store.transact((txn) =>
    txn.get(`redemption:proof-${start.stateId}`)
  )
  assert.ok(redemption)
  assert.ok(redemption.redeemedAtMs > 0)
  assert.equal(redemption.sessionId, complete.body.sessionId)
})

// Cookie and state refusals

void test('missing pre-auth cookie at completion', async () => {
  const ctx = await makeAdapter()
  await driveValidExchange(ctx)
  const complete = await ctx.adapter.handleComplete(null)
  assert.equal(complete.status, 401)
  assert.equal(ctx.store.keysWithPrefix('session:').length, 0)
})

void test('pre-auth cookie present, code step never verified', async () => {
  const ctx = await makeAdapter()
  const start = await ctx.adapter.startSignIn()
  const complete = await ctx.adapter.handleComplete(`pre=${start.cookieValue}`)
  assert.equal(complete.status, 401)
  assert.equal(ctx.store.keysWithPrefix('session:').length, 0)
})

void test('wrong pre-auth cookie at completion', async () => {
  const ctx = await makeAdapter()
  const other = await ctx.adapter.startSignIn()
  const { exchange } = await driveValidExchange(ctx)
  assert.equal(exchange.status, 200)
  const complete = await ctx.adapter.handleComplete(`pre=${other.cookieValue}`)
  assert.equal(complete.status, 401)
  assert.equal(ctx.store.keysWithPrefix('session:').length, 0)
})

void test('unknown state id at exchange', async () => {
  const ctx = await makeAdapter()
  const stateId = 'unknown-state-id'
  const proof = await signProof(
    ctx.key.pair,
    validClaims(stateId, ctx.now.value)
  )
  const exchange = await ctx.adapter.handleExchange(
    { proof, state: stateId },
    SERVICE_ORIGIN
  )
  assert.equal(exchange.status, 400)
  assert.equal(exchange.body.error, 'bad_state')
})

void test('altered state id at exchange leaves the pending record untouched', async () => {
  const ctx = await makeAdapter()
  const start = await ctx.adapter.startSignIn()
  const altered = `${start.stateId}x`
  const proof = await signProof(
    ctx.key.pair,
    validClaims(altered, ctx.now.value)
  )
  const exchange = await ctx.adapter.handleExchange(
    { proof, state: altered },
    SERVICE_ORIGIN
  )
  assert.equal(exchange.status, 400)
  const retry = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value)
  )
  const valid = await ctx.adapter.handleExchange(
    { proof: retry, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(valid.status, 200)
})

void test('reused or already-consumed state at exchange', async () => {
  const ctx = await makeAdapter()
  const { start } = await driveValidSignIn(ctx)
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value, { jti: 'proof-second' })
  )
  const exchange = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(exchange.status, 400)
  assert.equal(exchange.body.error, 'bad_state')
})

// Invalid claims (R4's check list), each its own case

const claimCases: [string, (nowSec: number) => Record<string, unknown>][] = [
  ['wrong issuer', () => ({ iss: 'https://evil.example.test' })],
  ['wrong audience', () => ({ aud: 'https://other.example.test' })],
  ['expired', (nowSec) => ({ exp: nowSec - 120 })],
  ['not yet valid', (nowSec) => ({ nbf: nowSec + 120 })],
  [
    'issued-at in the future beyond tolerance',
    (nowSec) => ({ iat: nowSec + 120 })
  ],
  ['epoch below the published epoch', () => ({ epoch: 0 })],
  [
    'nonce that does not match the supplied state',
    () => ({ nonce: 'other-state' })
  ]
]

for (const [name, overrides] of claimCases) {
  void test(`invalid proof: ${name}`, async () => {
    const ctx = await makeAdapter()
    const start = await ctx.adapter.startSignIn()
    const nowSec = Math.floor(ctx.now.value / 1000)
    const proof = await signProof(
      ctx.key.pair,
      validClaims(start.stateId, ctx.now.value, overrides(nowSec))
    )
    const exchange = await ctx.adapter.handleExchange(
      { proof, state: start.stateId },
      SERVICE_ORIGIN
    )
    assert.equal(exchange.status, 400)
    assert.equal(exchange.body.error, 'bad_proof')
  })
}

void test('invalid proof: altered payload', async () => {
  const ctx = await makeAdapter()
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value)
  )
  const parts = proof.split('.')
  const flipped = parts[1].charAt(5) === 'A' ? 'B' : 'A'
  const altered = `${parts[0]}.${parts[1].slice(0, 5) + flipped + parts[1].slice(6)}.${parts[2]}`
  const exchange = await ctx.adapter.handleExchange(
    { proof: altered, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(exchange.status, 400)
})

void test('invalid proof: algorithm other than EdDSA', async () => {
  const ctx = await makeAdapter()
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value),
    { alg: 'ES256', kid: 'k1' }
  )
  const exchange = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(exchange.status, 400)
})

void test('unknown key id after one forced refresh', async () => {
  const ctx = await makeAdapter()
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value),
    { alg: 'EdDSA', kid: 'k-unknown' }
  )
  const exchange = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(exchange.status, 400)
  assert.equal(ctx.jwks.control.fetches, 2) // one forced refresh, then reject
})

// Missing or wrongly typed required claims

const requiredClaims: [string, unknown][] = [
  ['iss', 123],
  ['aud', 123],
  ['sub', 123],
  ['nonce', 123],
  ['jti', 123],
  ['exp', 'soon'],
  ['nbf', 'soon'],
  ['iat', 'soon'],
  ['epoch', 'one']
]

for (const [name, wrongType] of requiredClaims) {
  void test(`missing or wrongly typed claim: ${name}`, async () => {
    const ctx = await makeAdapter()
    const start = await ctx.adapter.startSignIn()
    const missing = { ...validClaims(start.stateId, ctx.now.value) }
    Reflect.deleteProperty(missing, name)
    const wrong = validClaims(start.stateId, ctx.now.value, {
      [name]: wrongType
    })
    for (const claims of [missing, wrong]) {
      const proof = await signProof(ctx.key.pair, claims)
      const exchange = await ctx.adapter.handleExchange(
        { proof, state: start.stateId },
        SERVICE_ORIGIN
      )
      assert.equal(exchange.status, 400, JSON.stringify(claims))
    }
  })
}

void test('header key id missing or wrongly typed is rejected before key lookup', async () => {
  const ctx = await makeAdapter()
  const start = await ctx.adapter.startSignIn()
  for (const header of [{ alg: 'EdDSA' }, { alg: 'EdDSA', kid: 123 }]) {
    const proof = await signProof(
      ctx.key.pair,
      validClaims(start.stateId, ctx.now.value),
      header
    )
    const exchange = await ctx.adapter.handleExchange(
      { proof, state: start.stateId },
      SERVICE_ORIGIN
    )
    assert.equal(exchange.status, 400, JSON.stringify(header))
  }
  assert.equal(ctx.jwks.control.fetches, 0) // rejected before any key lookup
})

void test('wrong Origin header on the exchange', async () => {
  const ctx = await makeAdapter()
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value)
  )
  const exchange = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    'https://evil.example.test'
  )
  assert.equal(exchange.status, 403)
  assert.equal(exchange.acao, null)
})

// Replay and concurrency

void test('duplicate redemption of one valid proof', async () => {
  const ctx = await makeAdapter()
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value)
  )
  const first = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  const second = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(first.status, 200)
  assert.equal(second.status, 400)
  assert.equal(second.body.error, 'replayed')
})

void test('many parallel redemptions of one valid proof give one success', async () => {
  const ctx = await makeAdapter()
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value)
  )
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      ctx.adapter.handleExchange(
        { proof, state: start.stateId },
        SERVICE_ORIGIN
      )
    )
  )
  assert.equal(results.filter((r) => r.status === 200).length, 1)
})

void test('many parallel completions against one verified state give one session', async () => {
  const ctx = await makeAdapter()
  const { start, exchange } = await driveValidExchange(ctx)
  assert.equal(exchange.status, 200)
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      ctx.adapter.handleComplete(`pre=${start.cookieValue}`)
    )
  )
  assert.equal(results.filter((r) => r.status === 200).length, 1)
  assert.equal(ctx.store.keysWithPrefix('session:').length, 1)
})

void test('valid proof with a bad state is rejected but not consumed', async () => {
  const ctx = await makeAdapter()
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value)
  )
  // Mark the state consumed behind the adapter's back, then restore it.
  ctx.store.transact((txn) => {
    const pending = txn.get(`state:${start.stateId}`)
    if (!pending) throw new Error('pending state missing in test')
    pending.consumed = true
    txn.set(`state:${start.stateId}`, pending)
  })
  const failed = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(failed.status, 400)
  assert.equal(failed.body.error, 'bad_state')
  assert.equal(ctx.store.keysWithPrefix('redemption:').length, 0)
  ctx.store.transact((txn) => {
    const pending = txn.get(`state:${start.stateId}`)
    if (!pending) throw new Error('pending state missing in test')
    pending.consumed = false
    txn.set(`state:${start.stateId}`, pending)
  })
  const retry = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(retry.status, 200)
})

// Windows (bracketed values, not approved production settings)

void test('exchange outside the exchange window', async () => {
  const ctx = await makeAdapter()
  const start = await ctx.adapter.startSignIn()
  const nowSec = Math.floor(ctx.now.value / 1000)
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value, { iat: nowSec - 61 })
  )
  const exchange = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(exchange.status, 400)
})

void test('completion outside the completion window', async () => {
  const ctx = await makeAdapter()
  const { start, exchange } = await driveValidExchange(ctx)
  assert.equal(exchange.status, 200)
  ctx.now.value += 61_000
  const complete = await ctx.adapter.handleComplete(`pre=${start.cookieValue}`)
  assert.equal(complete.status, 401)
  assert.equal(ctx.store.keysWithPrefix('session:').length, 0)
})

// Storage and key failures (R5, R12)

void test('state store write failure at start fails closed', async () => {
  const ctx = await makeAdapter()
  ctx.store.failOnSetPrefix = 'state:'
  await assert.rejects(ctx.adapter.startSignIn())
  assert.equal(ctx.store.keysWithPrefix('state:').length, 0)
})

void test('redemption store failure at exchange fails closed', async () => {
  const ctx = await makeAdapter()
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value)
  )
  ctx.store.failOnSetPrefix = 'redemption:'
  await assert.rejects(
    ctx.adapter.handleExchange({ proof, state: start.stateId }, SERVICE_ORIGIN)
  )
  assert.equal(ctx.store.keysWithPrefix('redemption:').length, 0)
  const complete = await ctx.adapter.handleComplete(`pre=${start.cookieValue}`)
  assert.equal(complete.status, 401) // state never marked verified
})

void test('session write failure at completion leaves the state unconsumed', async () => {
  const ctx = await makeAdapter()
  const { start, exchange } = await driveValidExchange(ctx)
  assert.equal(exchange.status, 200)
  ctx.store.failOnSetPrefix = 'session:'
  await assert.rejects(ctx.adapter.handleComplete(`pre=${start.cookieValue}`))
  assert.equal(ctx.store.keysWithPrefix('session:').length, 0)
  // The state is still verified but unconsumed: completion can succeed once
  // the store recovers. Never consumed without a committed session.
  const retry = await ctx.adapter.handleComplete(`pre=${start.cookieValue}`)
  assert.equal(retry.status, 200)
  assert.equal(ctx.store.keysWithPrefix('session:').length, 1)
})

void test('key refresh failure after cache expiry rejects every proof', async () => {
  const ctx = await makeAdapter()
  const first = await driveValidExchange(ctx)
  assert.equal(first.exchange.status, 200)
  ctx.now.value += 6 * 60_000 // past the 5-minute key cache
  ctx.jwks.control.fail = true
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value)
  )
  const exchange = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(exchange.status, 400)
  ctx.jwks.control.fail = false
  const recovered = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(recovered.status, 200)
})

void test('unknown key id with refresh unavailable', async () => {
  const ctx = await makeAdapter()
  ctx.jwks.control.fail = true
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value),
    { alg: 'EdDSA', kid: 'k-unknown' }
  )
  const exchange = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(exchange.status, 400)
})

void test('cached key younger than five minutes is reused', async () => {
  const ctx = await makeAdapter()
  await driveValidExchange(ctx)
  await driveValidExchange(ctx)
  assert.equal(ctx.jwks.control.fetches, 1)
})

// Epoch and sessions

void test('epoch raise rejects an earlier-epoch proof at exchange', async () => {
  const ctx = await makeAdapter()
  await driveValidExchange(ctx) // warms the key cache at epoch 1
  ctx.now.value += 6 * 60_000
  ctx.jwks.control.epoch = 2
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value) // still epoch 1
  )
  const exchange = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(exchange.status, 400)
})

void test('epoch raise visible at completion ends the sign-in with no session', async () => {
  // A longer completion window keeps the state eligible while the clock
  // advances past the 5-minute key cache, so completion sees the raise.
  const ctx = await makeAdapter({
    config: { completionWindowMs: 10 * 60_000 }
  })
  const { start, exchange } = await driveValidExchange(ctx) // verified at epoch 1
  assert.equal(exchange.status, 200)
  // The fake proves refusal on a visible raise only: production freshness
  // inside the adopted cache bound (R12) is unproved.
  ctx.now.value += 6 * 60_000
  ctx.jwks.control.epoch = 2
  const complete = await ctx.adapter.handleComplete(`pre=${start.cookieValue}`)
  assert.equal(complete.status, 401)
  assert.equal(complete.body.error, 'stale_epoch')
  assert.equal(ctx.store.keysWithPrefix('session:').length, 0)
})

void test('epoch source unreadable at completion fails closed', async () => {
  const ctx = await makeAdapter()
  const { start, exchange } = await driveValidExchange(ctx)
  assert.equal(exchange.status, 200)
  ctx.now.value += 6 * 60_000
  ctx.jwks.control.fail = true
  const complete = await ctx.adapter.handleComplete(`pre=${start.cookieValue}`)
  assert.equal(complete.status, 503)
  assert.equal(ctx.store.keysWithPrefix('session:').length, 0)
})

void test('dropSessionsBefore ends earlier-epoch sessions and clears the key cache', async () => {
  const ctx = await makeAdapter()
  const first = await driveValidSignIn(ctx)
  const firstSession = required(first.complete.body.sessionId, 'sessionId')
  const fetchesBefore = ctx.jwks.control.fetches
  ctx.jwks.control.epoch = 2
  ctx.adapter.dropSessionsBefore(2)
  assert.equal(await ctx.adapter.getSession(firstSession), undefined)
  // The cleared key cache forces a refresh on the next exchange, which now
  // publishes epoch 2, and an epoch-2 sign-in survives a repeat drop.
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value, { epoch: 2 })
  )
  const exchange = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(exchange.status, 200)
  assert.ok(ctx.jwks.control.fetches > fetchesBefore)
  const complete = await ctx.adapter.handleComplete(`pre=${start.cookieValue}`)
  assert.equal(complete.status, 200)
  const secondSession = required(complete.body.sessionId, 'sessionId')
  ctx.adapter.dropSessionsBefore(2)
  assert.ok(await ctx.adapter.getSession(secondSession))
})

void test('session expiry is absolute: activity does not extend it', async () => {
  const ctx = await makeAdapter()
  const { complete } = await driveValidSignIn(ctx)
  const sessionId = required(complete.body.sessionId, 'sessionId')
  const fetchesBefore = ctx.jwks.control.fetches
  ctx.now.value += 30 * DAY_MS - 60_000
  // The check consults the epoch path: the long-expired key cache forces a
  // refresh here, so the pass below is not masking a skipped freshness read.
  assert.ok(await ctx.adapter.getSession(sessionId)) // just before 30 days
  assert.ok(ctx.jwks.control.fetches > fetchesBefore)
  assert.ok(await ctx.adapter.getSession(sessionId)) // activity reads it again
  ctx.now.value += 120_000 // just past 30 days from creation
  assert.equal(await ctx.adapter.getSession(sessionId), undefined)
})

void test('sign-out ends only the current device', async () => {
  const ctx = await makeAdapter()
  const first = await driveValidSignIn(ctx)
  const second = await driveValidSignIn(ctx)
  const firstId = required(first.complete.body.sessionId, 'sessionId')
  const secondId = required(second.complete.body.sessionId, 'sessionId')
  const out = ctx.adapter.signOut(firstId)
  assert.equal(out.status, 200)
  assert.equal(await ctx.adapter.getSession(firstId), undefined)
  assert.ok(await ctx.adapter.getSession(secondId))
})

void test('sign-out failure surfaces an error and the session stays valid', async () => {
  const ctx = await makeAdapter()
  const { complete } = await driveValidSignIn(ctx)
  const sessionId = required(complete.body.sessionId, 'sessionId')
  ctx.store.failOnDelete = true
  const out = ctx.adapter.signOut(sessionId)
  assert.equal(out.status, 500)
  assert.equal(out.body.error, 'sign_out_failed')
  assert.ok(await ctx.adapter.getSession(sessionId))
})

// Protocol hygiene

void test('no tokens in URLs', async () => {
  const ctx = await makeAdapter()
  const { start, exchange } = await driveValidExchange(ctx)
  assert.equal(exchange.status, 200)
  const pageUrl = new URL(start.pageUrl)
  assert.deepEqual([...pageUrl.searchParams.keys()].sort(), ['app', 'state'])
  assert.equal(pageUrl.searchParams.get('app'), APP_ORIGIN)
  assert.equal(pageUrl.searchParams.get('state'), start.stateId)
  const completeUrl = new URL(
    required(exchange.body.completeUrl, 'completeUrl')
  )
  assert.equal(completeUrl.search, '')
  assert.equal(completeUrl.origin, APP_ORIGIN)
})

void test('cookie attributes', async () => {
  const ctx = await makeAdapter()
  const { start, complete } = await driveValidSignIn(ctx)
  assert.equal(
    start.setCookie,
    `pre=${start.cookieValue}; Path=/; Secure; HttpOnly; SameSite=Lax`
  )
  assert.match(required(complete.setCookie, 'complete.setCookie'), /^sess=/)
  for (const cookie of [
    required(start.setCookie, 'start.setCookie'),
    required(complete.setCookie, 'complete.setCookie')
  ]) {
    assert.ok(cookie.includes('Secure'))
    assert.ok(cookie.includes('HttpOnly'))
    assert.ok(cookie.includes('SameSite=Lax'))
    assert.ok(!cookie.includes('Domain')) // host-only
  }
})

void test('cookie compare rejects wrong and garbage values', async () => {
  // Functional refusals only. Fixed iteration; no runtime timing
  // guarantee is claimed or tested here.
  const ctx = await makeAdapter()
  const { exchange } = await driveValidExchange(ctx)
  assert.equal(exchange.status, 200)
  for (const header of ['pre=wrong-value', 'pre=', 'pre=%20']) {
    const complete = await ctx.adapter.handleComplete(header)
    assert.equal(complete.status, 401, header)
  }
})

// First-review correction coverage. Each case maps to an approved definition
// where one exists; the report to the owner flags every case that extends
// beyond the 42 approved definitions.

void test('empty subject is rejected', async () => {
  // Definition 18: subject validity is presence plus non-empty, consistently.
  const ctx = await makeAdapter()
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value, { sub: '' })
  )
  const exchange = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(exchange.status, 400)
})

void test('wrong JWK key type or curve is refused', async () => {
  // Definition 14: the published key itself must be Ed25519, not only the
  // proof's alg header.
  const wrongPairs = [
    await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    ),
    await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256'
      },
      true,
      ['sign', 'verify']
    )
  ]
  for (const wrong of wrongPairs) {
    const wrongJwk: JsonWebKey & { kid?: string } =
      await crypto.subtle.exportKey('jwk', wrong.publicKey)
    wrongJwk.kid = 'k1'
    const ctx = await makeAdapter({ jwks: makeJwks(wrongJwk) })
    const start = await ctx.adapter.startSignIn()
    const proof = await signProof(
      ctx.key.pair,
      validClaims(start.stateId, ctx.now.value)
    )
    const exchange = await ctx.adapter.handleExchange(
      { proof, state: start.stateId },
      SERVICE_ORIGIN
    )
    assert.equal(exchange.status, 400, String(wrongJwk.kty))
    assert.equal(ctx.jwks.control.fetches, 2) // refused after one refresh
  }
})

void test('config beyond the adopted bounds is rejected', () => {
  const base = {
    origin: APP_ORIGIN,
    serviceOrigin: SERVICE_ORIGIN,
    fetchJwks: (): Promise<JwksResponse> =>
      Promise.resolve({ keys: [], epoch: 1 }),
    store: new FakeStore(),
    stateHmacKeyBytes: HMAC_KEY
  }
  const badConfigs: Partial<AdapterConfig>[] = [
    { keyCacheMs: 6 * 60_000 },
    { clockSkewMs: 61_000 },
    { sessionTtlMs: 31 * DAY_MS },
    { exchangeWindowMs: 0 },
    { completionWindowMs: Number.NaN }
  ]
  for (const config of badConfigs) {
    assert.throws(
      () => new SalutantSignInAdapter({ ...base, config }),
      JSON.stringify(config)
    )
  }
  // Within-bounds overrides stay accepted for test-only window adjustment.
  assert.ok(
    new SalutantSignInAdapter({
      ...base,
      config: { completionWindowMs: 10 * 60_000 }
    })
  )
})

void test('state write failure at exchange rolls back the staged redemption', async () => {
  // Definitions 27-29's atomicity condition across two writes, not one.
  const ctx = await makeAdapter()
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value)
  )
  ctx.store.failOnSetPrefix = 'state:'
  await assert.rejects(
    ctx.adapter.handleExchange({ proof, state: start.stateId }, SERVICE_ORIGIN)
  )
  // All or none: the staged redemption is gone with the failed state write.
  assert.equal(ctx.store.keysWithPrefix('redemption:').length, 0)
  const complete = await ctx.adapter.handleComplete(`pre=${start.cookieValue}`)
  assert.equal(complete.status, 401) // state never marked verified
})

void test('state write failure at completion rolls back the staged session', async () => {
  const ctx = await makeAdapter()
  const { start, exchange } = await driveValidExchange(ctx)
  assert.equal(exchange.status, 200)
  ctx.store.failOnSetPrefix = 'state:'
  await assert.rejects(ctx.adapter.handleComplete(`pre=${start.cookieValue}`))
  // All or none: the staged session and redemption update are gone too.
  assert.equal(ctx.store.keysWithPrefix('session:').length, 0)
  const redemption = ctx.store.transact((txn) =>
    txn.get(`redemption:proof-${start.stateId}`)
  )
  assert.equal(redemption?.sessionId, null)
  // The state is still verified but unconsumed: completion can recover.
  const retry = await ctx.adapter.handleComplete(`pre=${start.cookieValue}`)
  assert.equal(retry.status, 200)
})

void test('session check ends the session on a visible epoch raise', async () => {
  // The settled epoch-ends-all rule applied at check time, within the
  // adopted 5-minute cache bound.
  const ctx = await makeAdapter()
  const { complete } = await driveValidSignIn(ctx)
  const sessionId = required(complete.body.sessionId, 'sessionId')
  ctx.now.value += 6 * 60_000 // past the key cache: the check re-reads it
  ctx.jwks.control.epoch = 2
  assert.equal(await ctx.adapter.getSession(sessionId), undefined)
})

void test('session check fails closed when the epoch source is unreadable', async () => {
  const ctx = await makeAdapter()
  const { complete } = await driveValidSignIn(ctx)
  const sessionId = required(complete.body.sessionId, 'sessionId')
  ctx.now.value += 6 * 60_000
  ctx.jwks.control.fail = true
  assert.equal(await ctx.adapter.getSession(sessionId), undefined)
})

void test('unknown-key forced refresh cannot erase the observed epoch', async () => {
  // Definitions 15 and 33: the forced refresh must still run the epoch
  // comparison even though it rebuilds the key cache from empty.
  const ctx = await makeAdapter()
  const { complete } = await driveValidSignIn(ctx)
  const sessionId = required(complete.body.sessionId, 'sessionId')
  ctx.jwks.control.epoch = 2 // a raise is published behind the warm cache
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value),
    { alg: 'EdDSA', kid: 'k-unknown' }
  )
  const exchange = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(exchange.status, 400) // still an unknown key
  // The forced refresh observed the raise and ended the earlier session.
  assert.equal(await ctx.adapter.getSession(sessionId), undefined)
})

void test('a stale key response cannot regress the observed epoch', async () => {
  const key = await mintServiceKey()
  const ctx = await makeAdapter({ key, jwks: makeJwks(key.publicJwk, 2) })
  const warm = await ctx.adapter.startSignIn()
  const warmProof = await signProof(
    ctx.key.pair,
    validClaims(warm.stateId, ctx.now.value, { epoch: 2 })
  )
  const warmed = await ctx.adapter.handleExchange(
    { proof: warmProof, state: warm.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(warmed.status, 200) // observed epoch 2
  ctx.now.value += 6 * 60_000
  ctx.jwks.control.epoch = 1 // the next answer advertises a regressed epoch
  const start = await ctx.adapter.startSignIn()
  const proof = await signProof(
    ctx.key.pair,
    validClaims(start.stateId, ctx.now.value) // epoch 1
  )
  const exchange = await ctx.adapter.handleExchange(
    { proof, state: start.stateId },
    SERVICE_ORIGIN
  )
  assert.equal(exchange.status, 400) // the observed floor still rejects it
})

void test('digest compare rejects inputs that do not decode to 32 bytes', () => {
  // Definition 42: the fixed-length guard runs before the compare loop.
  const digest = toBase64Url(new Uint8Array(32).fill(1))
  assert.equal(fixedDigestEqual(digest, digest), true)
  assert.equal(
    fixedDigestEqual(digest, toBase64Url(new Uint8Array(32).fill(2))),
    false
  )
  assert.equal(fixedDigestEqual(toBase64Url(new Uint8Array(5)), digest), false)
  assert.equal(fixedDigestEqual('!!!', digest), false) // undecodable
})

// Definition 11 (approved November 7): epoch raise observed between epoch
// read and commit fails closed. One parameterized case with three variants,
// one per path. Each interleaves the raise between the path's awaited epoch
// read and its transaction, never inside the synchronous transaction.

const epochRaceVariants: [string, () => Promise<void>][] = [
  [
    'exchange',
    async () => {
      const ctx = await makeAdapter()
      // Warm the key cache at epoch 1 with a separate completed exchange.
      const warm = await driveValidExchange(ctx)
      assert.equal(warm.exchange.status, 200)
      const start = await ctx.adapter.startSignIn()
      const proof = await signProof(
        ctx.key.pair,
        validClaims(start.stateId, ctx.now.value)
      )
      const gate = gateSubtleMethod('verify')
      try {
        const pending = ctx.adapter.handleExchange(
          { proof, state: start.stateId },
          SERVICE_ORIGIN
        )
        await gate.waitForCall() // signature check in flight, cache snapshot 1
        ctx.adapter.dropSessionsBefore(2) // raise observed before commit
        gate.open()
        const exchange = await pending
        assert.equal(exchange.status, 400)
        assert.equal(exchange.body.error, 'stale_epoch')
        // No new redemption: only the warm-up exchange's is recorded.
        assert.equal(ctx.store.keysWithPrefix('redemption:').length, 1)
        // The state was never verified.
        const complete = await ctx.adapter.handleComplete(
          `pre=${start.cookieValue}`
        )
        assert.equal(complete.status, 401)
      } finally {
        gate.open() // release first so no promise stays parked
        gate.restore()
      }
    }
  ],
  [
    'completion',
    async () => {
      const ctx = await makeAdapter()
      const { start, exchange } = await driveValidExchange(ctx)
      assert.equal(exchange.status, 200) // verified at epoch 1, cache warm
      const gate = gateSubtleMethod('sign')
      try {
        const pending = ctx.adapter.handleComplete(`pre=${start.cookieValue}`)
        await gate.waitForCall() // cookie hash in flight, epoch snapshot 1
        ctx.adapter.dropSessionsBefore(2) // raise observed before commit
        gate.open()
        const complete = await pending
        assert.equal(complete.status, 401)
        assert.equal(complete.body.error, 'stale_epoch')
        assert.equal(ctx.store.keysWithPrefix('session:').length, 0)
        const redemption = ctx.store.transact((txn) =>
          txn.get(`redemption:proof-${start.stateId}`)
        )
        assert.equal(redemption?.sessionId, null)
      } finally {
        gate.open() // release first so no promise stays parked
        gate.restore()
      }
    }
  ],
  [
    'session check',
    async () => {
      const ctx = await makeAdapter()
      const { complete } = await driveValidSignIn(ctx)
      const sessionId = required(complete.body.sessionId, 'sessionId')
      ctx.now.value += 6 * 60_000 // cache expires: the check re-reads keys
      const hold: JwksHold = { entered: false, open: () => {} }
      ctx.jwks.control.hold = hold
      try {
        const pending = ctx.adapter.getSession(sessionId)
        for (let i = 0; i < 10_000 && !hold.entered; i++) {
          await new Promise((resolve) => setImmediate(resolve))
        }
        if (!hold.entered) {
          throw new Error('timed out waiting for the held key fetch')
        }
        ctx.adapter.dropSessionsBefore(2) // raise observed mid-read
        hold.open() // the in-flight read then answers with epoch 1
        assert.equal(await pending, undefined)
        assert.equal(ctx.store.keysWithPrefix('session:').length, 0)
      } finally {
        hold.open() // never leave a parked fetch
      }
      // Contract witness only: in the fake every raise path eagerly drops
      // earlier sessions, so this variant cannot discriminate the
      // in-transaction high-water line. That line is covered by static
      // review only; this test does not prove it, and any production
      // effect is unproved.
    }
  ]
]

for (const [path, run] of epochRaceVariants) {
  void test(
    `epoch raise observed between epoch read and commit fails closed: ${path}`,
    run
  )
}
