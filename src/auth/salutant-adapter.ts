// Salutant sign-in adapter. Isolated first slice: nothing in src/index.ts
// imports or mounts this module. It verifies Salutant's signed proofs and
// owns pending states, redemptions and sessions, following the locally
// reviewed reference flow in soliskit/salutant's stub app. The fake store
// is test-only; production persistence needs its own approved design.

// Each key namespace has one record shape. Callers cannot choose an
// unrelated return type for a read, and writes use the same key contract.
export interface StoreRecords {
  [key: `state:${string}`]: PendingState
  [key: `redemption:${string}`]: Redemption
  [key: `session:${string}`]: Session
}
export type StoreKey = keyof StoreRecords
export type StorePrefix = 'state:' | 'redemption:' | 'session:'

export interface StoreTxn {
  get<K extends StoreKey>(key: K): StoreRecords[K] | undefined
  set<K extends StoreKey>(key: K, value: StoreRecords[K]): void
  delete(key: StoreKey): void
  keysWithPrefix<P extends StorePrefix>(prefix: P): `${P}${string}`[]
}

// Transaction contract: fn runs against a staged view; its writes commit
// atomically only when fn returns, and a throw rolls every staged write
// back. Reads never alias stored state: mutating a value returned by get
// does not change the store unless it is written back with set. The fake
// in the test suite models this; production atomicity is a required design
// condition, not established by this slice.
export interface AdapterStore {
  transact<T>(fn: (txn: StoreTxn) => T): T
}

export type KeyJwk = JsonWebKey & { kid?: string }

export interface JwksResponse {
  keys: KeyJwk[]
  epoch: number
}

export interface AdapterConfig {
  keyCacheMs: number
  clockSkewMs: number
  exchangeWindowMs: number
  completionWindowMs: number
  sessionTtlMs: number
}

// Bracketed values: local proposals, not approved production settings
// (Salutant Open item 2). Adopted settings: 5-minute key cache and
// 1-minute clock tolerance (R12, R4). Session TTL: 30 days from sign-in,
// absolute; activity does not extend it.
export const DEFAULT_CONFIG: AdapterConfig = {
  keyCacheMs: 5 * 60_000,
  clockSkewMs: 60_000,
  exchangeWindowMs: 60_000,
  completionWindowMs: 60_000,
  sessionTtlMs: 30 * 24 * 60 * 60_000
}

interface PendingState {
  stateId: string
  cookieHmac: string
  createdAtMs: number
  verifiedSub: string | null
  verifiedJti?: string
  verifiedEpoch?: number
  verifiedAtMs?: number
  consumed: boolean
}

interface Redemption {
  jti: string
  redeemedAtMs: number
  // null at exchange; filled with the session id when the sign-in completes
  sessionId: string | null
}

interface Session {
  sessionId: string
  sub: string
  epoch: number
  createdAtMs: number
}

interface JwksCache {
  fetchedAtMs: number
  keys: Map<string, CryptoKey>
  epoch: number
}

interface ProofClaims {
  iss?: unknown
  aud?: unknown
  sub?: unknown
  nonce?: unknown
  jti?: unknown
  exp?: unknown
  nbf?: unknown
  iat?: unknown
  epoch?: unknown
}

interface VerifiedClaims {
  iss: string
  aud: string
  sub: string
  nonce: string
  jti: string
  exp: number
  nbf: number
  iat: number
  epoch: number
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  let base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  while (base64.length % 4 !== 0) base64 += '='
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function randomId(byteCount = 16): string {
  const bytes = new Uint8Array(byteCount)
  globalThis.crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

// Fixed-iteration compare over equal-length byte strings. Callers reject
// inputs that do not decode to the fixed digest length before comparing.
// Fixed iteration only; no runtime timing guarantee is claimed.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export class SalutantSignInAdapter {
  private readonly origin: string
  private readonly completeUrl: string
  private readonly serviceOrigin: string
  private readonly fetchJwks: () => Promise<JwksResponse>
  private readonly store: AdapterStore
  private readonly clock: () => number
  private readonly config: AdapterConfig
  private jwksCache: JwksCache | null = null
  private jwksInflight: Promise<JwksCache> | null = null
  // Highest epoch ever observed, kept independently of the key cache so a
  // cleared or rebuilt cache can never erase the comparison history.
  private lastObservedEpoch: number | null = null
  private stateKey: CryptoKey | null = null
  private readonly keyReady: Promise<void>

  constructor(options: {
    origin: string
    completePath?: string
    serviceOrigin: string
    fetchJwks: () => Promise<JwksResponse>
    store: AdapterStore
    stateHmacKeyBytes: Uint8Array
    clock?: () => number
    config?: Partial<AdapterConfig>
  }) {
    this.origin = options.origin
    this.completeUrl =
      options.origin + (options.completePath ?? '/auth/complete')
    this.serviceOrigin = options.serviceOrigin
    this.fetchJwks = options.fetchJwks
    this.store = options.store
    this.clock = options.clock ?? (() => Date.now())
    this.config = { ...DEFAULT_CONFIG, ...options.config }
    this.validateConfig(this.config)
    this.keyReady = this.importStateKey(options.stateHmacKeyBytes)
  }

  // Overrides exist so tests can shrink the bracketed windows; they must
  // never widen the adopted bounds (5-minute key cache, 1-minute clock
  // tolerance, 30-day absolute session lifetime) into silent policy.
  private validateConfig(config: AdapterConfig): void {
    for (const [name, value] of Object.entries(config)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`bad config: ${name}`)
      }
    }
    if (config.keyCacheMs > DEFAULT_CONFIG.keyCacheMs) {
      throw new Error('bad config: keyCacheMs beyond the adopted bound')
    }
    if (config.clockSkewMs > DEFAULT_CONFIG.clockSkewMs) {
      throw new Error('bad config: clockSkewMs beyond the adopted bound')
    }
    if (config.sessionTtlMs > DEFAULT_CONFIG.sessionTtlMs) {
      throw new Error('bad config: sessionTtlMs beyond the adopted bound')
    }
  }

  private async importStateKey(keyBytes: Uint8Array): Promise<void> {
    this.stateKey = await globalThis.crypto.subtle.importKey(
      'raw',
      keyBytes as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
  }

  async ready(): Promise<void> {
    await this.keyReady
  }

  private async hmac(message: string): Promise<string> {
    if (!this.stateKey) throw new Error('adapter not ready')
    const sig = await globalThis.crypto.subtle.sign(
      'HMAC',
      this.stateKey,
      textEncoder.encode(message)
    )
    return toBase64Url(new Uint8Array(sig))
  }

  // Step 1: the person opens the app's sign-in page (top-level GET). Sets an
  // anonymous pre-auth cookie and creates a server-side pending state bound
  // to a keyed hash of its value. The service URL carries only the app
  // origin and the state id; no token, code or proof goes in a URL.
  async startSignIn(): Promise<{
    pageUrl: string
    stateId: string
    cookieValue: string
    setCookie: string
  }> {
    const cookieValue = randomId(24)
    const cookieHmac = await this.hmac(`pre:${cookieValue}`)
    const stateId = randomId(24)
    this.store.transact((txn) => {
      txn.set(`state:${stateId}`, {
        stateId,
        cookieHmac,
        createdAtMs: this.clock(),
        verifiedSub: null,
        consumed: false
      } satisfies PendingState)
    })
    return {
      pageUrl: `${this.serviceOrigin}/?app=${encodeURIComponent(this.origin)}&state=${encodeURIComponent(stateId)}`,
      stateId,
      cookieValue,
      setCookie: `pre=${cookieValue}; Path=/; Secure; HttpOnly; SameSite=Lax`
    }
  }

  // Key cache: at most 5 minutes, then refresh or fail closed (R12). The
  // epoch rides the same response; a refresh that sees a higher epoch drops
  // earlier sessions (R14). Concurrent callers share one in-flight refresh,
  // and the cached epoch never regresses below the highest observed.
  private async jwks(): Promise<JwksCache> {
    const now = this.clock()
    if (
      this.jwksCache &&
      now - this.jwksCache.fetchedAtMs < this.config.keyCacheMs
    ) {
      return this.jwksCache
    }
    if (this.jwksInflight) return this.jwksInflight
    this.jwksInflight = this.refreshJwks(now).finally(() => {
      this.jwksInflight = null
    })
    return this.jwksInflight
  }

  private async refreshJwks(fetchedAtMs: number): Promise<JwksCache> {
    const fresh = await this.fetchJwks() // a failure here fails closed
    const keys = new Map<string, CryptoKey>()
    for (const jwk of fresh.keys) {
      if (typeof jwk.kid !== 'string') continue
      // Ed25519 keys only; any other key type or curve is unusable here.
      if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') continue
      try {
        keys.set(
          jwk.kid,
          await globalThis.crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'Ed25519' },
            false,
            ['verify']
          )
        )
      } catch {
        continue // malformed key material is unusable
      }
    }
    if (
      this.lastObservedEpoch !== null &&
      fresh.epoch > this.lastObservedEpoch
    ) {
      this.dropSessionsBefore(fresh.epoch)
    }
    this.lastObservedEpoch =
      this.lastObservedEpoch === null
        ? fresh.epoch
        : Math.max(this.lastObservedEpoch, fresh.epoch)
    // A stale or regressed response can lower the advertised epoch but never
    // the accepted one: an already-observed raise is not forgotten.
    const cache: JwksCache = {
      fetchedAtMs,
      keys,
      epoch: this.lastObservedEpoch
    }
    this.jwksCache = cache
    return cache
  }

  private async jwksWithOneRetry(kid: string): Promise<JwksCache> {
    let cache = await this.jwks()
    if (!cache.keys.has(kid)) {
      this.jwksCache = null // unknown key id: one forced refresh, then reject
      cache = await this.jwks()
    }
    return cache
  }

  private async verifyProofSignature(
    proof: string,
    publicKey: CryptoKey
  ): Promise<ProofClaims> {
    const parts = proof.split('.')
    if (parts.length !== 3) throw new Error('bad proof shape')
    const signed = textEncoder.encode(`${parts[0]}.${parts[1]}`)
    const signature = fromBase64Url(parts[2])
    const ok = await globalThis.crypto.subtle.verify(
      'Ed25519',
      publicKey,
      signature as BufferSource,
      signed
    )
    if (!ok) throw new Error('bad signature')
    return JSON.parse(
      textDecoder.decode(fromBase64Url(parts[1]))
    ) as ProofClaims
  }

  // Step 2: bounded exchange. The code page's script POSTs the proof here
  // cross-origin. Verifies everything and binds the verified address to the
  // pending state, but creates no session: a cross-site POST carries no
  // SameSite=Lax cookie, so the browser is not yet authenticated.
  async handleExchange(
    input: { proof: string; state: string },
    corsOrigin: string | null
  ): Promise<{
    status: number
    acao: string | null
    body: { error?: string; completeUrl?: string }
  }> {
    if (corsOrigin !== this.serviceOrigin) {
      return { status: 403, acao: null, body: { error: 'bad_origin' } }
    }
    let claims: VerifiedClaims
    try {
      const parts = input.proof.split('.')
      if (parts.length !== 3) throw new Error('bad proof shape')
      const header = JSON.parse(
        textDecoder.decode(fromBase64Url(parts[0]))
      ) as {
        alg?: unknown
        kid?: unknown
      }
      // The key id is a header parameter: it must be present and a string
      // before any key lookup (a missing or wrongly typed kid is rejected,
      // distinct from a well-formed but unknown one).
      if (typeof header.kid !== 'string') throw new Error('bad key id')
      if (header.alg !== 'EdDSA') throw new Error('bad algorithm')
      const cache = await this.jwksWithOneRetry(header.kid)
      const publicKey = cache.keys.get(header.kid)
      if (!publicKey) throw new Error('unknown key')
      const raw = await this.verifyProofSignature(input.proof, publicKey)
      // Required claims must be present and typed; a signed proof that
      // omits or mistypes one is rejected, not waved through by
      // comparisons against undefined (R4).
      const wellFormed =
        typeof raw.iss === 'string' &&
        typeof raw.aud === 'string' &&
        typeof raw.sub === 'string' &&
        raw.sub.length > 0 &&
        typeof raw.nonce === 'string' &&
        typeof raw.jti === 'string' &&
        raw.jti.length > 0 &&
        typeof raw.exp === 'number' &&
        typeof raw.nbf === 'number' &&
        typeof raw.iat === 'number' &&
        typeof raw.epoch === 'number'
      if (!wellFormed) throw new Error('bad proof')
      claims = raw as VerifiedClaims
      const now = this.clock()
      const skew = this.config.clockSkewMs
      // The bounded exchange window runs from proof issuance, not from
      // state creation: a resend must still be able to complete a sign-in.
      if (now - claims.iat * 1000 >= this.config.exchangeWindowMs) {
        throw new Error('outside exchange window')
      }
      const bad =
        claims.iss !== this.serviceOrigin ||
        claims.aud !== this.origin ||
        claims.epoch !== cache.epoch ||
        claims.exp * 1000 < now - skew ||
        claims.nbf * 1000 > now + skew ||
        claims.iat * 1000 > now + skew ||
        claims.nonce !== input.state
      if (bad) throw new Error('bad proof')
    } catch {
      return {
        status: 400,
        acao: this.serviceOrigin,
        body: { error: 'bad_proof' }
      }
    }

    // Replay protection and the state binding are one atomic step: the
    // proof id is checked against the redemption record first, the pending
    // state is validated second, and only when both pass are the redemption
    // recorded and the state marked verified, together. A valid proof with
    // a bad state is rejected but not consumed.
    const verdict = this.store.transact((txn) => {
      // Check-to-commit: compare against the latest observed epoch, not
      // only the cache snapshot the signature was verified against, so a
      // raise observed in between cannot leave a stale state committed.
      if (
        this.lastObservedEpoch !== null &&
        claims.epoch !== this.lastObservedEpoch
      ) {
        return 'stale_epoch'
      }
      if (txn.get(`redemption:${claims.jti}`)) return 'replayed'
      const pending = txn.get(`state:${input.state}`)
      if (!pending || pending.consumed || pending.verifiedSub)
        return 'bad_state'
      txn.set(`redemption:${claims.jti}`, {
        jti: claims.jti,
        redeemedAtMs: this.clock(),
        sessionId: null
      } satisfies Redemption)
      pending.verifiedSub = claims.sub
      pending.verifiedJti = claims.jti
      pending.verifiedEpoch = claims.epoch
      pending.verifiedAtMs = this.clock() // the completion window starts at verification
      txn.set(`state:${input.state}`, pending)
      return 'ok'
    })
    if (verdict !== 'ok') {
      return {
        status: 400,
        acao: this.serviceOrigin,
        body: { error: verdict }
      }
    }
    return {
      status: 200,
      acao: this.serviceOrigin,
      body: { completeUrl: this.completeUrl }
    }
  }

  // Step 3: top-level GET navigation. The SameSite=Lax pre-auth cookie
  // travels on this request, binding the browser to the pending state the
  // exchange verified. Completion re-reads the current epoch through the
  // key path: an unreadable epoch fails closed, and a visible epoch raise
  // since exchange ends the sign-in with no session.
  async handleComplete(cookieHeader: string | null): Promise<{
    status: number
    body: { error?: string; sessionId?: string; sub?: string }
    setCookie?: string
  }> {
    const pre = cookieHeader?.match(/(?:^|;\s*)pre=([^;]+)/)?.[1]
    if (!pre) return { status: 401, body: { error: 'no_session' } }
    let epoch: number
    try {
      epoch = (await this.jwks()).epoch
    } catch {
      return { status: 503, body: { error: 'unavailable' } }
    }
    return this.completeWithCookie(pre, epoch)
  }

  private async completeWithCookie(
    pre: string,
    currentEpoch: number
  ): Promise<{
    status: number
    body: { error?: string; sessionId?: string; sub?: string }
    setCookie?: string
  }> {
    const cookieHmac = await this.hmac(`pre:${pre}`)
    const now = this.clock()
    return this.store.transact((txn) => {
      // Check-to-commit: the latest observed epoch wins over the snapshot
      // captured before the cookie hash, so a raise observed in between
      // ends this sign-in instead of minting a stale session.
      const effectiveEpoch = Math.max(
        currentEpoch,
        this.lastObservedEpoch ?? currentEpoch
      )
      const pending = txn
        .keysWithPrefix('state:')
        .map((key) => txn.get(key))
        .find(
          (p): p is PendingState =>
            p !== undefined &&
            fixedDigestEqual(p.cookieHmac, cookieHmac) &&
            !p.consumed &&
            p.verifiedAtMs !== undefined &&
            now - p.verifiedAtMs < this.config.completionWindowMs
        )
      if (!pending || pending.verifiedSub === null) {
        return { status: 401, body: { error: 'no_verified_signin' } }
      }
      const verifiedSub = pending.verifiedSub
      if (pending.verifiedEpoch !== effectiveEpoch) {
        return { status: 401, body: { error: 'stale_epoch' } }
      }
      // One atomic step: write the session and consume the state together,
      // session first, so a partial failure can never leave a consumed
      // state without a committed session. A store failure aborts the
      // transaction, leaving the state verified but unconsumed.
      const sessionId = randomId(24)
      txn.set(`session:${sessionId}`, {
        sessionId,
        sub: verifiedSub,
        epoch: pending.verifiedEpoch ?? effectiveEpoch,
        createdAtMs: now
      } satisfies Session)
      // Link the redemption record to the session it produced (R4).
      if (pending.verifiedJti !== undefined) {
        const redemptionKey = `redemption:${pending.verifiedJti}` as const
        const redemption = txn.get(redemptionKey)
        if (redemption) txn.set(redemptionKey, { ...redemption, sessionId })
      }
      pending.consumed = true
      txn.set(`state:${pending.stateId}`, pending)
      return {
        status: 200,
        body: { sessionId, sub: verifiedSub },
        setCookie: `sess=${sessionId}; Path=/; Secure; HttpOnly; SameSite=Lax`
      }
    })
  }

  // Session check: only a live, unexpired, current-epoch session passes.
  // Expiry is 30 days from creation, absolute; activity does not extend it.
  // The epoch is re-read through the key path, fresh within the adopted
  // 5-minute cache bound: an unreadable epoch source fails closed, and a
  // visible raise ends the earlier-epoch session at check time.
  async getSession(sessionId: string): Promise<Session | undefined> {
    let currentEpoch: number
    try {
      currentEpoch = (await this.jwks()).epoch
    } catch {
      return undefined // fail closed: the epoch source is unreadable
    }
    return this.store.transact((txn) => {
      // Check-to-commit: compare against the latest observed epoch, not
      // only the snapshot captured before the store read.
      const effectiveEpoch = Math.max(
        currentEpoch,
        this.lastObservedEpoch ?? currentEpoch
      )
      const key = `session:${sessionId}` as const
      const session = txn.get(key)
      if (!session) return undefined
      if (this.clock() - session.createdAtMs >= this.config.sessionTtlMs) {
        return undefined
      }
      if (session.epoch !== effectiveEpoch) {
        txn.delete(key)
        return undefined
      }
      return session
    })
  }

  // Sign-out ends the current device's session only. A failed delete
  // surfaces an error and the session remains valid; no silent sign-out.
  signOut(sessionId: string): { status: number; body: { error?: string } } {
    try {
      this.store.transact((txn) => {
        txn.delete(`session:${sessionId}`)
      })
    } catch {
      return { status: 500, body: { error: 'sign_out_failed' } }
    }
    return { status: 200, body: {} }
  }

  // R12/R14: on epoch change or emergency revoke, drop sessions issued
  // before the new epoch and clear the cached keys. The raised epoch stays
  // remembered even though the cache is cleared.
  dropSessionsBefore(epoch: number): void {
    this.store.transact((txn) => {
      for (const key of txn.keysWithPrefix('session:')) {
        const session = txn.get(key)
        if (session && session.epoch < epoch) txn.delete(key)
      }
    })
    this.lastObservedEpoch =
      this.lastObservedEpoch === null
        ? epoch
        : Math.max(this.lastObservedEpoch, epoch)
    this.jwksCache = null
  }
}

// Fixed-length digest compare: both sides must decode to one HMAC-SHA-256
// digest (32 bytes) before the fixed-iteration loop runs; anything that
// fails to decode or decodes to another length is rejected first.
// Functional tests cover the refusals and the length guard. Fixed
// iteration only; no runtime timing guarantee is claimed.
const HMAC_DIGEST_BYTES = 32

export function fixedDigestEqual(
  aBase64Url: string,
  bBase64Url: string
): boolean {
  let a: Uint8Array
  let b: Uint8Array
  try {
    a = fromBase64Url(aBase64Url)
    b = fromBase64Url(bBase64Url)
  } catch {
    return false
  }
  if (a.length !== HMAC_DIGEST_BYTES || b.length !== HMAC_DIGEST_BYTES) {
    return false
  }
  return timingSafeEqual(a, b)
}
