// @ts-check
import { element } from './element.js'
import { ordinal } from './ordinal.js'

/**
 * PeerJS leaves peerConnection unset before negotiation and clears it on
 * cleanup; _payload carries the offer the connection was created from.
 * @typedef {Omit<import('peerjs').MediaConnection, 'peerConnection'> & { peerConnection?: RTCPeerConnection | null, _payload?: unknown }} MediaConnection
 */

const DEFAULT_PHOTO = '/no-video.svg'
// One final literal slash in the address is link formatting, not part of
// the name; an encoded slash (%2F) is not stripped and stays invalid
const roomName = decodeURIComponent(
  location.pathname.slice('/room/'.length).replace(/\/$/, '')
)

const errorBox = element('error', HTMLDivElement)
const title = element('title', HTMLHeadingElement)
const status = element('status', HTMLHeadingElement)
const attendees = element('attendees', HTMLDivElement)
const muteButton = element('mute', HTMLButtonElement)
const cameraButton = element('camera', HTMLButtonElement)
const removePhotoButton = element('remove-photo', HTMLButtonElement)
const callButton = element('call', HTMLButtonElement)
const selfLabel = element('self-label', HTMLLabelElement)
const selfVideo = element('self', HTMLVideoElement)
const photoInput = element('photo', HTMLInputElement)

const PHOTO_CANVAS_WIDTH = 400
const PHOTO_CANVAS_HEIGHT = 300
const PHOTO_MAX_SIDE = 288
const PHOTO_REDRAW_INTERVAL_MS = 1000
// After a shown connection error the app retries on its own a bounded number
// of times, then stops and keeps the error shown; recovery is then a reload
const PEER_RECONNECT_MAX_ATTEMPTS = 3

// While the camera is off, peers see a photo drawn on a canvas
const canvas = document.createElement('canvas')
canvas.width = PHOTO_CANVAS_WIDTH
canvas.height = PHOTO_CANVAS_HEIGHT
const context = /** @type {CanvasRenderingContext2D} */ (
  canvas.getContext('2d')
)
const photoTrack = canvas.captureStream().getVideoTracks()[0]
const photo = new Image()
photo.src = DEFAULT_PHOTO

// Like the photo track, a silent track stands in until the mic is captured
const silentTrack = new AudioContext()
  .createMediaStreamDestination()
  .stream.getAudioTracks()[0]
/** What peers receive: one video track (camera or photo) and one audio track (microphone or silence) */
const outgoing = new MediaStream([photoTrack, silentTrack])
/** @type {MediaStreamTrack | undefined} */
let cameraTrack
/** @type {MediaStreamTrack | undefined} */
let micTrack
/** Per-device request versions retire grants after toggles or teardown */
let cameraRequest = 0
let micRequest = 0
let cameraOn = false
let muted = false
let joined = false
/** @type {Map<string, { call: MediaConnection, video: HTMLVideoElement }>} */
const calls = new Map()
/** Closed calls awaiting the server's room-departure cause, at most one per member.
 * @type {Map<string, string>} */
const closedRoomCalls = new Map()
/** Peer ids the server says are in the room; only these are called or answered */
const roomPeers = new Set()
/** False until the server answers our join with the room roster */
let rosterLoaded = false
/** Increments on every Join and Leave, retiring older join attempts */
let joinSerial = 0
/** Increments when the room connection session changes or ends; work from an
 *  older session is dropped on sight */
let roomEpoch = 0
/**
 * Admission phase: leave (outside the room), pending (Join clicked, roster
 * answer in flight), joined (roster answered), lost (room connection down;
 * a fresh Join click starts over), blocked (another tab holds this room
 * name), unsupported (no Web Locks API)
 * @type {'leave' | 'pending' | 'joined' | 'lost' | 'blocked' | 'unsupported'}
 */
let roomPhase = 'leave'
// Set when the room transport has spent its six attempts; a fresh Join
// click re-opens it, and the next open connection clears it
let roomTransportDead = false
/** Calls that arrived while the roster answer was still on its way */
const earlyCalls = /** @type {MediaConnection[]} */ ([])

/**
 * One timing from the server config, or the fallback when the value is
 * missing or not a positive finite number of milliseconds.
 * @param {unknown} configJson
 * @param {'joinRetryMs' | 'requestTimeoutMs' | 'reconnectDelayMs' | 'transportRetryDelayMs' | 'transportRetryDelayMaxMs'} key
 * @param {number} fallback
 */
function configTiming(configJson, key, fallback) {
  if (typeof configJson !== 'object' || configJson === null) return fallback
  if (!('timings' in configJson)) return fallback
  const timings = configJson.timings
  if (typeof timings !== 'object' || timings === null) return fallback
  if (!(key in timings)) return fallback
  const value = /** @type {unknown} */ (Reflect.get(timings, key))
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

// The whole /config exchange - request and response body - is bounded.
// 10 s leaves room for the server's own 5 s relay-fetch fallback plus
// network margin; it is a budget, not a delivery guarantee for every
// network.
const CONFIG_REQUEST_TIMEOUT_MS = 10_000
const configController = new AbortController()
const configTimer = setTimeout(() => {
  configController.abort()
}, CONFIG_REQUEST_TIMEOUT_MS)
/** @type {unknown} */
let configJson
try {
  const configResponse = await fetch('/config', {
    signal: configController.signal
  })
  if (!configResponse.ok) {
    throw Error(
      `Connection settings could not be loaded (${String(configResponse.status)}).`
    )
  }
  configJson = await configResponse.json()
} catch (error) {
  // Only this controller's own timeout is relabeled; every other failure
  // (HTTP status, bad JSON, network) keeps its original error.
  if (configController.signal.aborted) {
    throw Error(
      'Connection settings could not be loaded (no answer within 10 seconds).',
      { cause: error }
    )
  }
  throw error
} finally {
  clearTimeout(configTimer)
}
const config = /** @type {{ iceServers: RTCIceServer[] }} */ (configJson)
// Test suites can ask the server for shortened timings; production serves
// none and the page keeps the fallback values.
const JOIN_RETRY_DELAY_MS = configTiming(configJson, 'joinRetryMs', 2_000)
const REQUEST_TIMEOUT_MS = configTiming(configJson, 'requestTimeoutMs', 5_000)
const PEER_RECONNECT_DELAY_MS = configTiming(
  configJson,
  'reconnectDelayMs',
  5_000
)
const TRANSPORT_RETRY_DELAY_MS = configTiming(
  configJson,
  'transportRetryDelayMs',
  1_000
)
const TRANSPORT_RETRY_DELAY_MAX_MS = configTiming(
  configJson,
  'transportRetryDelayMaxMs',
  5_000
)
const secure = location.protocol === 'https:'
/**
 * PeerJS call can return undefined while disconnected or without a stream.
 * @type {Omit<import('peerjs').Peer, 'call'> & { call: (peerId: string, stream: MediaStream) => MediaConnection | undefined }}
 */
const peer = new Peer({
  host: location.hostname,
  port: Number(location.port) || (secure ? 443 : 80),
  secure,
  path: '/',
  config: { iceServers: config.iceServers }
})

/* Retained signaling accounting (issue #150): the pairing library stores
 * messages per connection ID until a call is answered, unbounded and with
 * no sender check on replay. This ledger accounts for that store in three
 * classes - live, pending and unknown - drains the real store before any
 * charge is forgotten, and replays only messages from the call's own
 * peer. The served-bundle tripwire in room.test.ts pins the library
 * internals this relies on. */

/** The approved starting limits; qualify before raising any of them */
const RETENTION_LIMITS = {
  perConnectionMessages: 128,
  perConnectionBytes: 64 * 1024,
  pendingCalls: 40,
  pendingAggregateBytes: 2 * 1024 * 1024,
  unknownMessages: 512,
  unknownBytes: 256 * 1024,
  tombstones: 256,
  liveOfferBytes: 64 * 1024,
  liveOffers: 40,
  liveOfferAggregateBytes: 2 * 1024 * 1024
}

/**
 * The library's parsed server message.
 * @typedef {object} SignalingMessage
 * @property {string} type
 * @property {unknown} payload
 * @property {unknown} src
 */

/**
 * One ledger entry per physical connection ID - the key the pairing
 * library stores retained messages under.
 * @typedef {object} RetentionEntry
 * @property {string | null} source sender this entry is bound to
 * @property {MediaConnection | null} pendingCall the owned unanswered call
 * @property {number} pendingGeneration join serial owning that call
 * @property {number} offerBytes held OFFER charge
 * @property {boolean} offerLive true once the call was answered (class L)
 * @property {number} retainedCount charged library-store messages
 * @property {number} retainedBytes charged library-store bytes
 * @property {{ messages: SignalingMessage[], count: number, bytes: number } | null} stash
 *   pre-OFFER messages the wrapper owns until the call is answered
 */

/** @type {Map<string, RetentionEntry>} */
const retentionLedger = new Map()
/** Retired connection IDs, oldest first, capped by the FIFO limit */
const retentionTombstones = /** @type {string[]} */ ([])
/** True after a hook or accounting failure: Join and calls are refused */
let retentionBroken = false

/**
 * The library internals this ledger hooks, verified at startup and pinned
 * by the served-bundle tripwire: _getMessages returns the store for a
 * connection ID and deletes it, getConnection looks a live connection up
 * by peer ID and connection ID, and the socket's message event reaches
 * the library's own listener first because it was registered in the
 * constructor.
 */
const peerHooks =
  /** @type {{ _getMessages?: (connectionId: string) => SignalingMessage[], getConnection?: (peerId: string, connectionId: string) => MediaConnection | null, socket?: { on?: unknown } | null }} */ (
    /** @type {unknown} */ (peer)
  )

/** Reads the fail-closed flag without type narrowing, for re-checks after calls that may have set it */
function isRetentionBroken() {
  return retentionBroken
}

/** The charged size of a signaling message: its serialized JSON form */
function retainedSize(/** @type {SignalingMessage} */ message) {
  return JSON.stringify(message).length
}

/** @param {string} connectionId */
function tombstone(connectionId) {
  retentionTombstones.push(connectionId)
  while (retentionTombstones.length > RETENTION_LIMITS.tombstones) {
    retentionTombstones.shift()
  }
}

/**
 * Current aggregate charges by class, computed from the ledger so no
 * running total can drift from the entries it counts.
 */
function retentionTotals() {
  let pendingCalls = 0
  let pendingBytes = 0
  let unknownMessages = 0
  let unknownBytes = 0
  let liveOffers = 0
  let liveOfferBytes = 0
  for (const entry of retentionLedger.values()) {
    const messageCount = entry.retainedCount + (entry.stash?.count ?? 0)
    const totalBytes =
      entry.offerBytes + entry.retainedBytes + (entry.stash?.bytes ?? 0)
    if (entry.offerLive) {
      liveOffers++
      liveOfferBytes += entry.offerBytes
    } else if (entry.pendingCall && entry.pendingGeneration === joinSerial) {
      pendingCalls++
      pendingBytes += totalBytes
    } else {
      unknownMessages += messageCount
      unknownBytes += totalBytes
    }
  }
  return {
    pendingCalls,
    pendingBytes,
    unknownMessages,
    unknownBytes,
    liveOffers,
    liveOfferBytes
  }
}

/**
 * Drains the actual library store for a connection ID and releases the
 * charges that accounted for it. Drain-before-forget: even a null
 * connection lookup never drops a charge before this runs.
 * @returns {SignalingMessage[]} the drained messages
 */
function drainLibraryStore(/** @type {string} */ connectionId) {
  const getMessages = peerHooks._getMessages
  if (typeof getMessages !== 'function') {
    throw Error('the pairing library message store cannot be drained')
  }
  const drained = /** @type {SignalingMessage[]} */ (
    getMessages.call(peer, connectionId)
  )
  const entry = retentionLedger.get(connectionId)
  if (entry) {
    entry.retainedCount = 0
    entry.retainedBytes = 0
  }
  return drained
}

/**
 * Terminal path for a ledger entry: drains the real store, drops the
 * wrapper stash, releases every charge and records the tombstone.
 */
function drainAndForget(/** @type {string} */ connectionId) {
  drainLibraryStore(connectionId)
  const entry = retentionLedger.get(connectionId)
  if (entry) {
    entry.stash = null
    entry.offerBytes = 0
    retentionLedger.delete(connectionId)
  }
  tombstone(connectionId)
}

/** Every terminal admission path drains all accounting it owned */
function drainAllRetention() {
  for (const connectionId of [...retentionLedger.keys()]) {
    drainAndForget(connectionId)
  }
}

/**
 * Stops admission after a hook or accounting failure: never a silent
 * fallback. When unknown retention cannot be ruled out the Peer is
 * destroyed so nothing unaccounted keeps arriving.
 * @param {unknown} error
 */
function retentionFailClosed(/** @type {unknown} */ error) {
  console.error(error)
  retentionBroken = true
  let drainFailed = false
  for (const peerId of [...calls.keys()]) {
    try {
      removeCall(peerId)
    } catch (removeError) {
      console.error(removeError)
      drainFailed = true
    }
  }
  for (const call of earlyCalls.splice(0)) {
    try {
      call.close()
    } catch (closeError) {
      console.error(closeError)
    }
  }
  for (const connectionId of [...retentionLedger.keys()]) {
    try {
      drainAndForget(connectionId)
    } catch (drainError) {
      console.error(drainError)
      drainFailed = true
      break
    }
  }
  if (drainFailed) {
    // Unknown retention could not be ruled out: destroy the Peer so
    // nothing unaccounted keeps arriving
    try {
      peer.destroy()
    } catch (destroyError) {
      console.error(destroyError)
    }
  }
  showError(
    'Connection problem',
    'Pinto cannot account for the messages the pairing library stores, so joining and answering are disabled.'
  )
  render()
}

/**
 * Closes a call the wrapper owns and releases everything charged for its
 * connection ID. Unanswered calls emit no close event, so every closure
 * goes through here.
 */
function retireCallFully(/** @type {MediaConnection} */ call) {
  // No longer waiting: later retirement sweeps must not close it twice
  const earlyIndex = earlyCalls.indexOf(call)
  if (earlyIndex >= 0) earlyCalls.splice(earlyIndex, 1)
  try {
    call.close()
  } catch (error) {
    console.error(error)
  }
  drainAndForget(call.connectionId)
}

/**
 * Refuses a legitimate caller under pressure: the refusal is shown, not
 * hidden.
 */
function refuseCallUnderPressure(
  /** @type {MediaConnection} */ call,
  /** @type {string} */ reason
) {
  retireCallFully(call)
  showError('Connection problem', reason)
}

/**
 * A cross-source collision on one connection ID refuses both ownerships
 * and drains the connection: charges are never split by sender.
 */
function refuseCollision(/** @type {string} */ connectionId) {
  const entry = retentionLedger.get(connectionId)
  if (entry?.pendingCall) {
    refuseCallUnderPressure(
      entry.pendingCall,
      'A call could not be admitted because its signaling channel was contested.'
    )
    return
  }
  drainAndForget(connectionId)
}

/**
 * Charges the OFFER a kept call holds until the wrapper retires its
 * references. Class L once answered, class P while it waits. The entry
 * already counts toward its class totals; only the OFFER bytes are new.
 * @returns {boolean} false when the charge does not fit and the call was
 *   refused instead
 */
function chargeOffer(
  /** @type {RetentionEntry} */ entry,
  /** @type {MediaConnection} */ call,
  /** @type {number} */ bytes
) {
  if (bytes > RETENTION_LIMITS.liveOfferBytes) {
    refuseCallUnderPressure(
      call,
      'A call was refused because its offer is larger than the message limit.'
    )
    return false
  }
  if (entry.offerLive) {
    const totals = retentionTotals()
    if (
      totals.liveOffers > RETENTION_LIMITS.liveOffers ||
      totals.liveOfferBytes + bytes > RETENTION_LIMITS.liveOfferAggregateBytes
    ) {
      refuseCallUnderPressure(
        call,
        'A call was refused because too many calls are already held.'
      )
      return false
    }
  } else {
    // Under pressure the oldest waiting call is refused, never hidden
    for (;;) {
      const totals = retentionTotals()
      if (
        totals.pendingCalls <= RETENTION_LIMITS.pendingCalls &&
        totals.pendingBytes + bytes <= RETENTION_LIMITS.pendingAggregateBytes
      ) {
        break
      }
      const oldest = [...retentionLedger.values()].find(
        (each) =>
          each.pendingCall &&
          !each.offerLive &&
          each.pendingGeneration === joinSerial &&
          each.pendingCall !== call
      )
      if (!oldest?.pendingCall) {
        refuseCallUnderPressure(
          call,
          'A call was refused because too many calls are still waiting.'
        )
        return false
      }
      refuseCallUnderPressure(
        oldest.pendingCall,
        'The oldest waiting call was refused to make room for a newer one.'
      )
    }
  }
  entry.offerBytes = bytes
  return true
}

/**
 * Charges a message the library retained for a connection ID, bounded by
 * the per-connection and class limits.
 * @returns {boolean} false when the charge does not fit
 */
function chargeRetained(
  /** @type {RetentionEntry} */ entry,
  /** @type {string} */ connectionId,
  /** @type {number} */ bytes
) {
  const ownedNow = Boolean(
    entry.pendingCall && entry.pendingGeneration === joinSerial
  )
  const stashCount = entry.stash?.count ?? 0
  const stashBytes = entry.stash?.bytes ?? 0
  if (
    entry.retainedCount + stashCount + 1 >
      RETENTION_LIMITS.perConnectionMessages ||
    entry.retainedBytes + stashBytes + bytes >
      RETENTION_LIMITS.perConnectionBytes
  ) {
    if (ownedNow && entry.pendingCall) {
      refuseCallUnderPressure(
        entry.pendingCall,
        'A call was refused because its stored messages grew past the limit.'
      )
    } else {
      drainAndForget(connectionId)
    }
    return false
  }
  entry.retainedCount++
  entry.retainedBytes += bytes
  if (!ownedNow && !entry.offerLive) {
    // Unknown traffic stays bounded: the oldest unknown entry is evicted,
    // drained before it is forgotten
    for (;;) {
      const totals = retentionTotals()
      if (
        totals.unknownMessages <= RETENTION_LIMITS.unknownMessages &&
        totals.unknownBytes <= RETENTION_LIMITS.unknownBytes
      ) {
        break
      }
      const oldestUnknown = [...retentionLedger.entries()].find(
        ([, each]) =>
          !each.offerLive &&
          (!each.pendingCall || each.pendingGeneration !== joinSerial)
      )
      if (!oldestUnknown) break
      drainAndForget(oldestUnknown[0])
    }
  }
  return true
}

/**
 * Extracts pre-OFFER messages inside the call callback, before the
 * library's own replay can deliver them without a sender check. They are
 * owned by this call until answer time.
 */
function adoptCallStash(/** @type {MediaConnection} */ call) {
  const connectionId = call.connectionId
  const drained = drainLibraryStore(connectionId)
  let entry = retentionLedger.get(connectionId)
  if (!entry) {
    entry = {
      source: null,
      pendingCall: null,
      pendingGeneration: 0,
      offerBytes: 0,
      offerLive: false,
      retainedCount: 0,
      retainedBytes: 0,
      stash: null
    }
    retentionLedger.set(connectionId, entry)
  }
  if (entry.source && entry.source !== call.peer) {
    refuseCollision(connectionId)
    try {
      call.close()
    } catch (error) {
      console.error(error)
    }
    return
  }
  entry.source = call.peer
  entry.pendingCall = call
  entry.pendingGeneration = joinSerial
  if (drained.length === 0) return
  let bytes = 0
  for (const message of drained) bytes += retainedSize(message)
  entry.stash = { messages: drained, count: drained.length, bytes }
  if (
    drained.length > RETENTION_LIMITS.perConnectionMessages ||
    bytes > RETENTION_LIMITS.perConnectionBytes
  ) {
    refuseCallUnderPressure(
      call,
      'A call was refused because its stored messages grew past the limit.'
    )
  }
}

/**
 * Removes the stash's ownership reference first, so re-entry can never
 * replay twice.
 * @returns {SignalingMessage[]} the owned messages, once
 */
function takeOwnedStashOnce(
  /** @type {RetentionEntry} */ entry,
  /** @type {MediaConnection} */ call
) {
  if (!entry.stash || entry.pendingCall !== call) return []
  const messages = entry.stash.messages
  entry.stash = null
  return messages
}

/**
 * The post-library socket listener: the library's own listener was
 * registered in its constructor, so by the time a message reaches here
 * the library has already delivered or retained it, and the ledger
 * accounts for exactly that outcome.
 */
function observeSignaling(/** @type {SignalingMessage} */ message) {
  if (retentionBroken) return
  try {
    const payload = message.payload
    if (!payload || typeof payload !== 'object') return
    const connectionId = /** @type {{ connectionId?: unknown }} */ (payload)
      .connectionId
    if (typeof connectionId !== 'string') return
    const source = typeof message.src === 'string' ? message.src : null
    const getConnection = peerHooks.getConnection
    if (typeof getConnection !== 'function') {
      throw Error('the pairing library connection lookup is missing')
    }

    if (message.type === 'OFFER') {
      // A refused or retired connection leaves nothing behind; the drain
      // is defensive because close already dropped the library store
      const offerType = /** @type {{ type?: unknown }} */ (payload).type
      const connection = source
        ? getConnection.call(peer, source, connectionId)
        : null
      if (offerType === 'data' || !connection) {
        drainAndForget(connectionId)
        return
      }
      const entry = retentionLedger.get(connectionId)
      if (!entry) {
        // The call callback binds every kept call; a missing entry here
        // means accounting already failed somewhere upstream
        throw Error('an admitted call has no retention ledger entry')
      }
      if (entry.source !== source) {
        refuseCollision(connectionId)
        return
      }
      chargeOffer(
        entry,
        /** @type {MediaConnection} */ (connection),
        retainedSize(message)
      )
      return
    }

    // Any other message: delivered to a live negotiated connection (no new
    // charge) or retained by the library store (charged here)
    const connection = source
      ? getConnection.call(peer, source, connectionId)
      : null
    if (
      connection &&
      /** @type {{ peerConnection?: RTCPeerConnection | null }} */ (connection)
        .peerConnection
    ) {
      return
    }
    // Messages alone never claim a connection ID: only a call does. A
    // stranger's messages under a waiting call's ID share its budget and
    // are filtered out of its replay, never a reason to refuse the call;
    // refusing here would let anyone poison a known connection ID
    let entry = retentionLedger.get(connectionId)
    if (!entry) {
      entry = {
        source: null,
        pendingCall: null,
        pendingGeneration: 0,
        offerBytes: 0,
        offerLive: false,
        retainedCount: 0,
        retainedBytes: 0,
        stash: null
      }
      retentionLedger.set(connectionId, entry)
    }
    chargeRetained(entry, connectionId, retainedSize(message))
  } catch (error) {
    retentionFailClosed(error)
  }
}

// Missing library hooks refuse Join and calls with a shown error from the
// start; there is no unaccounted fallback. Deferred one microtask so the
// module finishes evaluating first: the error surface is declared later
// in this file, and no message can arrive before the socket opens
queueMicrotask(() => {
  if (
    typeof peerHooks._getMessages === 'function' &&
    typeof peerHooks.getConnection === 'function' &&
    typeof peerHooks.socket?.on === 'function'
  ) {
    const peerSocket =
      /** @type {{ on: (event: string, listener: (message: SignalingMessage) => void) => void }} */ (
        peerHooks.socket
      )
    peerSocket.on('message', (message) => {
      observeSignaling(message)
    })
  } else {
    retentionBroken = true
    showError(
      'Connection problem',
      'Pinto cannot account for the messages the pairing library stores, so joining and answering are disabled.'
    )
    render()
  }
})
// One tab holds a room at a time within a storage partition, under the same
// normalized name the server joins by (src/index.ts trims and lowercases)
const roomKey = roomName.trim().toLowerCase()
// Widened for feature detection: lib types assume Web Locks always exist
const nav = /** @type {Omit<Navigator, 'locks'> & { locks?: LockManager }} */ (
  navigator
)
const roomLockSupported = typeof nav.locks !== 'undefined'
/** Releases the held room lock; null while no lock is held */
let releaseRoomLock = /** @type {(() => void) | null} */ (null)

/**
 * Takes the Web Lock for this room name. Resolves true while held, false
 * when another tab holds it.
 * @returns {Promise<boolean>}
 */
function captureRoomLock() {
  return new Promise((resolve) => {
    navigator.locks
      .request(`eyeson-${roomKey}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false)
          return
        }
        resolve(true)
        // The lock is held until this promise settles
        return /** @type {Promise<void>} */ (
          new Promise((_resolve) => {
            releaseRoomLock = () => {
              releaseRoomLock = null
              _resolve()
            }
          })
        )
      })
      .catch(() => {
        resolve(false)
      })
  })
}

// The room connection makes at most six transport attempts; running out is
// terminal for this room session and shows the connection error
const socket = io({
  reconnectionAttempts: 6,
  reconnectionDelay: TRANSPORT_RETRY_DELAY_MS,
  reconnectionDelayMax: TRANSPORT_RETRY_DELAY_MAX_MS
})

/** Draws the photo centered, at most 288px on its longest side */
function drawPhoto() {
  if (!photo.complete || !photo.naturalWidth) return
  const scale = Math.min(
    1,
    PHOTO_MAX_SIDE / photo.width,
    PHOTO_MAX_SIDE / photo.height
  )
  const width = photo.width * scale
  const height = photo.height * scale
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(
    photo,
    (canvas.width - width) / 2,
    (canvas.height - height) / 2,
    width,
    height
  )
}

/** @param {string} src */
function setPhoto(src) {
  if (photo.src.startsWith('blob:')) URL.revokeObjectURL(photo.src)
  photo.src = src
  render()
}

/**
 * Sends a different video track to everyone, without renegotiating calls.
 *
 * @param {MediaStreamTrack} track
 */
function sendVideo(track) {
  for (const current of outgoing.getVideoTracks()) outgoing.removeTrack(current)
  outgoing.addTrack(track)
  selfVideo.srcObject = new MediaStream([track])
  for (const { call } of calls.values()) {
    const sender = call.peerConnection
      ?.getSenders()
      .find((each) => each.track?.kind === 'video')
    void sender?.replaceTrack(track).catch((/** @type {unknown} */ error) => {
      if (calls.get(call.peer)?.call !== call) return
      showError(
        'Call connection',
        `A media update failed. This call ended: ${errorReason(error)}`,
        call.connectionId
      )
      removeCall(call.peer)
    })
  }
}

/**
 * Sends an audio track to every call: the microphone or silence.
 *
 * @param {MediaStreamTrack} track
 */
function sendAudio(track) {
  for (const current of outgoing.getAudioTracks()) outgoing.removeTrack(current)
  outgoing.addTrack(track)
  for (const { call } of calls.values()) {
    const sender = call.peerConnection
      ?.getSenders()
      .find((each) => each.track?.kind === 'audio')
    void sender?.replaceTrack(track).catch((/** @type {unknown} */ error) => {
      if (calls.get(call.peer)?.call !== call) return
      showError(
        'Call connection',
        `A media update failed. This call ended: ${errorReason(error)}`,
        call.connectionId
      )
      removeCall(call.peer)
    })
  }
}

/** The message from a failed camera or microphone request */
/** @param {unknown} error */
const errorReason = (error) =>
  error instanceof Error ? error.message : String(error)

/** Stops all capture and puts the placeholder tracks back */
function stopCapture() {
  cameraRequest++
  micRequest++
  if (cameraTrack) cameraTrack.stop()
  cameraTrack = undefined
  if (micTrack) micTrack.stop()
  sendVideo(photoTrack)
  sendAudio(silentTrack)
}

/** Captures the camera when it is wanted, stops it when it is not */
async function applyCamera() {
  const request = ++cameraRequest
  const serial = joinSerial
  if (cameraOn) {
    if (!cameraTrack || cameraTrack.readyState === 'ended') {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: true
        })
        if (serial !== joinSerial || request !== cameraRequest) {
          // Leave, a new Join or a toggle retired this request
          media.getVideoTracks()[0].stop()
          return
        }
        cameraTrack = media.getVideoTracks()[0]
        cameraTrack.addEventListener('ended', showEndedCamera)
      } catch (error) {
        if (serial !== joinSerial || request !== cameraRequest) return
        cameraOn = false
        showError(
          'Camera and microphone',
          `Pinto can't reach your camera or microphone: ${errorReason(error)}`
        )
        render()
        return
      }
    }
    sendVideo(cameraTrack)
  } else {
    sendVideo(photoTrack)
    if (cameraTrack) cameraTrack.stop()
    cameraTrack = undefined
  }
}

/**
 * Shows the camera as off when its capture ended without the controls: the
 * device went away, or something else stopped the track. Peers get the photo
 * again. A track the controls stopped is already forgotten, so it never
 * counts here.
 */
function showEndedCamera() {
  if (cameraTrack?.readyState !== 'ended') return
  cameraTrack = undefined
  cameraOn = false
  sendVideo(photoTrack)
  render()
}

/** Captures the microphone when it is wanted, stops it when it is not */
async function applyMic() {
  const request = ++micRequest
  const serial = joinSerial
  if (muted) {
    if (micTrack) micTrack.stop()
    sendAudio(silentTrack)
    return
  }
  if (!micTrack || micTrack.readyState === 'ended') {
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (serial !== joinSerial || request !== micRequest) {
        // Leave, a new Join or a toggle retired this request
        media.getAudioTracks()[0].stop()
        return
      }
      micTrack = media.getAudioTracks()[0]
    } catch (error) {
      if (serial !== joinSerial || request !== micRequest) return
      muted = true
      showError(
        'Camera and microphone',
        `Pinto can't reach your camera or microphone: ${errorReason(error)}`
      )
      render()
      return
    }
  }
  sendAudio(micTrack)
}

/** @param {MediaConnection} call */
function addCall(call) {
  closedRoomCalls.delete(call.peer)
  removeCall(call.peer)
  const video = document.createElement('video')
  video.autoplay = true
  video.playsInline = true
  video.setAttribute('aria-label', 'Remote video')
  calls.set(call.peer, { call, video })
  call.on('stream', (stream) => {
    video.srcObject = stream
    attendees.append(video)
    render()
  })
  call.on('close', () => {
    if (calls.get(call.peer)?.call !== call) return
    closedRoomCalls.set(call.peer, call.connectionId)
    removeCall(call.peer)
  })
  call.on('iceStateChanged', (state) => {
    if (calls.get(call.peer)?.call !== call) return
    if (state === 'connected' || state === 'completed') {
      clearError(`${call.connectionId}:waiting`)
    } else if (state === 'disconnected') {
      showError(
        'Call connection',
        'A call was interrupted. Waiting for its connection to recover.',
        `${call.connectionId}:waiting`
      )
    }
  })
  call.on('error', (error) => {
    console.error(error)
    if (calls.get(call.peer)?.call !== call) return
    if (error.type !== 'negotiation-failed') return
    showError(
      'Call connection',
      'A call connection failed. The call ended.',
      call.connectionId
    )
    removeCall(call.peer)
  })
}

/** @param {string} peerId */
function removeCall(peerId) {
  const entry = calls.get(peerId)
  if (!entry) return
  calls.delete(peerId)
  clearError(`${entry.call.connectionId}:waiting`)
  entry.call.close()
  // The wrapper retires its references: the held OFFER charge goes with
  // them, and the drain runs before the accounting is removed
  drainAndForget(entry.call.connectionId)
  entry.video.remove()
  render()
}

// One entry per kind of problem, so concurrent problems all stay visible
/** @type {Map<string, { heading: HTMLHeadingElement, message: HTMLHeadingElement }>} */
const errorEntries = new Map()

/**
 * @param {string} heading
 * @param {string} message
 * @param {string} key
 */
function showError(heading, message, key = heading) {
  let entry = errorEntries.get(key)
  if (!entry) {
    const box = document.createElement('div')
    const headingElement = document.createElement('h1')
    const messageElement = document.createElement('h2')
    box.append(headingElement, messageElement)
    errorBox.append(box)
    entry = { heading: headingElement, message: messageElement }
    errorEntries.set(key, entry)
  }
  entry.heading.textContent = heading
  entry.message.textContent = message
  errorBox.hidden = false
}

/** Clears only the warning whose cause has recovered. */
function clearError(/** @type {string} */ key) {
  const entry = errorEntries.get(key)
  entry?.heading.parentElement?.remove()
  errorEntries.delete(key)
  errorBox.hidden = errorEntries.size === 0
}

function render() {
  document.title = `Pinto | ${roomName}`
  // Only a confirmed admission shows membership: during a pending join the
  // toggle already reads joined so a second click can Leave, but the title
  // waits for the server's roster answer
  title.textContent =
    roomPhase === 'joined' ? `You are in ${roomName}` : `Join ${roomName}`
  status.textContent =
    roomPhase === 'pending'
      ? 'Joining...'
      : roomPhase === 'joined'
        ? `${ordinal(attendees.childElementCount + 1)} in the room`
        : roomPhase === 'lost'
          ? 'Connection lost - press Join to rejoin'
          : roomPhase === 'blocked'
            ? 'This room is open in another tab'
            : roomPhase === 'unsupported'
              ? 'This browser cannot join a room'
              : 'Press Join to start the call'
  muteButton.textContent = muted ? 'Unmute' : 'Mute'
  muteButton.disabled = false
  cameraButton.textContent = cameraOn ? 'Turn Off Camera' : 'Turn On Camera'
  cameraButton.disabled = false
  photoInput.disabled = cameraOn
  selfLabel.title = cameraOn
    ? ''
    : 'Choose a photo to show instead of your video'
  removePhotoButton.hidden = cameraOn || !photo.src.startsWith('blob:')
  callButton.textContent = joined ? 'Leave' : 'Join'
  callButton.classList.toggle('end', joined)
  // Leaving does not require an open pairing connection,
  // so Leave stays usable while pairing is down
  callButton.disabled =
    (!joined && !peer.open) ||
    roomPhase === 'blocked' ||
    roomPhase === 'unsupported'
}

photo.addEventListener('load', drawPhoto)
photo.addEventListener('error', () => {
  showError(
    'Photo',
    "Pinto can't show that photo: the file could not be decoded. The last photo shown stays on the call."
  )
})
// A canvas only produces frames when painted, so keep painting for peers
// who join later. A track stopped from script fires no ended event, so the
// same tick also looks for a camera that ended
setInterval(() => {
  drawPhoto()
  showEndedCamera()
}, PHOTO_REDRAW_INTERVAL_MS)
selfVideo.srcObject = new MediaStream([photoTrack])

muteButton.addEventListener('click', () => {
  void (async () => {
    muted = !muted
    if (joined) await applyMic()
    render()
  })()
})

cameraButton.addEventListener('click', () => {
  void (async () => {
    cameraOn = !cameraOn
    if (joined) await applyCamera()
    render()
  })()
})

photoInput.addEventListener('change', () => {
  const file = photoInput.files?.[0]
  if (file) setPhoto(URL.createObjectURL(file))
  photoInput.value = ''
})

removePhotoButton.addEventListener('click', () => {
  setPhoto(DEFAULT_PHOTO)
})

/**
 * Retires the current admission: buffered join-room packets for the old
 * session drop before any flush, every call and early call closes, and
 * capture stops. Runs synchronously inside the connection's own dispatch.
 * Idempotent: Leave's own reset already does this work, and a second pass
 * finds empty lists.
 * @param {'leave' | 'lost'} phase
 */
function retireAdmission(phase) {
  roomEpoch++
  // A retired admission gives up the room lock: another tab may serve
  // the room while this page waits for its fresh Join click
  releaseRoomLock?.()
  // This touches socket.io's internal buffer; the served-bundle tripwire
  // in room.test.ts pins what it relies on
  socket.sendBuffer = socket.sendBuffer.filter(
    (packet) =>
      /** @type {{ data: unknown[] }} */ (packet).data[0] !== 'join-room'
  )
  for (const peerId of calls.keys()) removeCall(peerId)
  closedRoomCalls.clear()
  roomPeers.clear()
  rosterLoaded = false
  for (const call of earlyCalls.splice(0)) retireCallFully(call)
  // Ending the call ends the camera and microphone capture too
  stopCapture()
  // A terminal admission releases every remaining retention charge,
  // unknown-source entries included, each drained before it is forgotten
  drainAllRetention()
  roomPhase = phase
  joined = false
  render()
}

// A new room connection session begins: nothing from an older one may act
// on it, and rejoining takes a fresh Join click - no automatic readmission.
// The disconnect listener has already retired any older Pending or Joined
// admission synchronously, so a Pending phase here belongs only to a fresh
// Join clicked during the outage: its buffered emit rides this connection
// and must stay live
socket.on('connect', () => {
  roomTransportDead = false
  if (roomPhase !== 'pending') roomEpoch++
})

// The room connection ended outside the user's intent: retire admission
// synchronously, before any buffered packet for the old session can flush
socket.on('disconnect', () => {
  // Leave already retired admission; a blocked or unsupported page has none
  if (roomPhase !== 'pending' && roomPhase !== 'joined') return
  retireAdmission('lost')
  showError(
    'Connection problem',
    'The connection to the room was lost. Press Join to rejoin.'
  )
})

// Six transport attempts came and went: terminal for this room session
socket.io.on('reconnect_failed', () => {
  if (roomPhase === 'pending' || roomPhase === 'joined') retireAdmission('lost')
  // The connection error shows in every phase, so an exhaustion during a
  // silent phase is not mistaken for a page that can still join
  roomTransportDead = true
  showError(
    'Connection problem',
    'The connection to the room could not be restored. Press Join to try again.'
  )
})

callButton.addEventListener('click', () => {
  if (joined) {
    joinSerial++
    roomPhase = 'leave'
    releaseRoomLock?.()
    // Leaving retires every Join attempt, so a join-room packet still
    // buffered for the next connection must not be sent: the server
    // entry it would create would outlive the Leave. The packet's
    // acknowledgement stays registered and still resolves, on the
    // disconnect or on its own timeout, so nothing is left waiting.
    // This touches socket.io's internal buffer; the served-bundle
    // tripwire in room.test.ts pins what it relies on
    socket.sendBuffer = socket.sendBuffer.filter(
      (packet) =>
        /** @type {{ data: unknown[] }} */ (packet).data[0] !== 'join-room'
    )
    for (const peerId of calls.keys()) removeCall(peerId)
    closedRoomCalls.clear()
    roomPeers.clear()
    rosterLoaded = false
    for (const call of earlyCalls.splice(0)) retireCallFully(call)
    // Ending the call ends the camera and microphone capture too
    stopCapture()
    // Leaving releases every remaining retention charge with the admission
    drainAllRetention()
    // A fresh connection leaves the room, and the server tells the others
    socket.disconnect().connect()
  } else {
    if (retentionBroken) {
      showError(
        'Connection problem',
        'Pinto cannot account for the messages the pairing library stores, so joining is disabled.'
      )
      render()
      return
    }
    // Joining needs a live pairing connection: refuse while it is down
    // rather than show a room membership that cannot call or be called
    if (!peer.open || peer.disconnected) {
      showError(
        'Connection problem',
        'The connection to the server is down, so joining is unavailable.',
        'pairing'
      )
      render()
      return
    }
    const serial = ++joinSerial
    const epoch = roomEpoch
    roomPhase = 'pending'
    // A terminal room transport (six attempts spent) is re-opened by the
    // fresh Join click, which starts a brand-new session
    if (roomTransportDead) socket.connect()
    let attempts = 0
    const tryJoin = () => {
      // A Leave, a newer Join or a new room session retires this attempt
      if (serial !== joinSerial || epoch !== roomEpoch) return
      socket
        .timeout(REQUEST_TIMEOUT_MS)
        .emit(
          'join-room',
          roomName,
          peer.id,
          (
            /** @type {Error | null} */ error,
            /** @type {string[] | string | null} */ members
          ) => {
            if (serial !== joinSerial || epoch !== roomEpoch) return
            if (typeof members === 'string') {
              // A refusal that carries a reason - the room name is
              // outside the room-name rule - cannot succeed by retrying:
              // show the reason, back to not joined, with Join available
              joined = false
              roomPhase = 'leave'
              releaseRoomLock?.()
              // Retire requests this attempt still has waiting
              joinSerial++
              roomEpoch++
              // A join that never happened must not leave capture running
              stopCapture()
              for (const call of earlyCalls.splice(0)) retireCallFully(call)
              drainAllRetention()
              showError('Cannot join', members)
              render()
              return
            }
            // A refusal or a lost answer usually means the room still has
            // our id from a previous connection; try again until it clears
            if (error || members === null) {
              if (attempts++ < 4) {
                // 5 attempts in all, spaced by JOIN_RETRY_DELAY_MS
                setTimeout(tryJoin, JOIN_RETRY_DELAY_MS)
                return
              }
              // Still refused: back to not joined, with Join available
              joined = false
              roomPhase = 'leave'
              releaseRoomLock?.()
              // Retire requests this attempt still has waiting
              joinSerial++
              roomEpoch++
              // A join that never happened must not leave capture running
              stopCapture()
              for (const call of earlyCalls.splice(0)) retireCallFully(call)
              drainAllRetention()
              render()
              return
            }
            for (const peerId of members) roomPeers.add(peerId)
            rosterLoaded = true
            roomPhase = 'joined'
            render()
            // Calls that beat the roster answer get decided now, each on
            // its own: one call that fails must not abandon the rest
            for (const call of earlyCalls.splice(0)) {
              try {
                answerIfMember(call)
              } catch (error) {
                showError(
                  'Connection problem',
                  `A waiting call could not be answered: ${errorReason(error)}`
                )
                // A call that fails here belongs to no list; retire it so
                // it cannot outlive the room. Retiring must not abandon
                // the calls still waiting either
                retireCallFully(call)
              }
            }
          }
        )
    }
    void (async () => {
      // The room lock comes first: a second tab with this room name never
      // starts admission at all. A tab already holding the lock (a fresh
      // Join after a loss) does not ask for it again
      const held = releaseRoomLock ? true : await captureRoomLock()
      if (serial !== joinSerial || epoch !== roomEpoch) {
        // Retired while the lock was being taken; don't keep the room
        if (held) releaseRoomLock?.()
        return
      }
      if (!held) {
        joined = false
        roomPhase = 'blocked'
        // Retire requests this attempt still has waiting
        joinSerial++
        // A join that never happened must not leave capture running
        stopCapture()
        showError(
          'Room in use',
          'This room is open in another tab or window. Close it there first.'
        )
        const retryLink = document.createElement('a')
        retryLink.href = location.href
        retryLink.textContent = 'Try again'
        errorBox.append(retryLink)
        render()
        return
      }
      tryJoin()
      // Capture starts here, only for what the buttons ask for
      void applyMic()
      void applyCamera()
    })()
  }
  joined = !joined
  render()
})

let reconnectAttempts = 0
peer.on('open', () => {
  clearError('pairing')
  reconnectAttempts = 0
  render()
})
/** Answers a call from a room member and closes any other */
function answerIfMember(/** @type {MediaConnection} */ call) {
  if (!roomPeers.has(call.peer)) {
    retireCallFully(call)
    return
  }
  // The library silently retires a waiting call when a duplicate offer
  // arrives for its connection id; never answer a call it no longer
  // tracks - answering one throws and abandons the calls behind it. The
  // replacement call owns the ledger entry now; release only if it does not
  if (peer.getConnection(call.peer, call.connectionId) !== call) {
    const entry = retentionLedger.get(call.connectionId)
    if (entry?.pendingCall === call) drainAndForget(call.connectionId)
    return
  }
  if (retentionBroken) {
    retireCallFully(call)
    return
  }
  const entry = retentionLedger.get(call.connectionId)
  if (!entry) {
    retentionFailClosed(
      Error('answering a call with no retention ledger entry')
    )
    retireCallFully(call)
    return
  }
  // Extract post-OFFER retention before answering: the library's own
  // answer() replay would deliver it without the sender check
  const retained = drainLibraryStore(call.connectionId)
  const stash = takeOwnedStashOnce(entry, call)
  entry.pendingCall = null
  entry.offerLive = true
  const totals = retentionTotals()
  if (
    totals.liveOffers > RETENTION_LIMITS.liveOffers ||
    totals.liveOfferBytes > RETENTION_LIMITS.liveOfferAggregateBytes
  ) {
    refuseCallUnderPressure(
      call,
      'A call was refused because too many calls are already held.'
    )
    return
  }
  call.answer(outgoing)
  // Source-filtered replay in arrival order: the stash, then what the
  // library retained after the offer. Both are already drained, so this
  // is the only delivery and it happens exactly once
  for (const message of [...stash, ...retained]) {
    if (message.src === call.peer) {
      // The messages came from the library's own store: its server-message
      // shape is what answer() itself would have replayed (the type is not
      // exported, so the cast goes through the call)
      const replayable =
        /** @type {{ handleMessage: (m: SignalingMessage) => void }} */ (
          /** @type {unknown} */ (call)
        )
      replayable.handleMessage(message)
    }
  }
  addCall(call)
}

peer.on('call', (call) => {
  if (retentionBroken) {
    retireCallFully(call)
    return
  }
  // Pre-OFFER messages are extracted before the library's own replay can
  // deliver them without a sender check; they wait for the answer
  adoptCallStash(call)
  // A collision or stash overflow above refused this call already
  if (
    isRetentionBroken() ||
    peer.getConnection(call.peer, call.connectionId) !== call
  ) {
    return
  }
  if (!joined) {
    retireCallFully(call)
    return
  }
  // A duplicate offer for a waiting call's connection id silently retires
  // that call in the library; stop tracking what it retired. The
  // replacement call owns the ledger entry now; release only if it does not
  for (let index = earlyCalls.length - 1; index >= 0; index--) {
    const waiting = earlyCalls[index]
    if (peer.getConnection(waiting.peer, waiting.connectionId) !== waiting) {
      earlyCalls.splice(index, 1)
      const entry = retentionLedger.get(waiting.connectionId)
      if (entry?.pendingCall === waiting) drainAndForget(waiting.connectionId)
    }
  }
  // Members can hear about us and call before our roster answer arrives;
  // those calls wait for it instead of being refused by mistake
  if (!rosterLoaded) {
    earlyCalls.push(call)
    return
  }
  answerIfMember(call)
})

peer.on(
  'connection',
  (/** @type {import('peerjs').DataConnection} */ connection) => {
    // The app never opens data connections: refuse the unsolicited inbound
    // path and drain anything stored under the connection ID. This runs
    // inside the library's own dispatch, before its replay, so the drain
    // leaves nothing for the closed connection to receive
    drainAndForget(connection.connectionId)
    try {
      connection.close()
    } catch (error) {
      console.error(error)
    }
  }
)
peer.on('disconnected', () => {
  setTimeout(() => {
    if (!peer.disconnected || peer.destroyed) return
    if (reconnectAttempts >= PEER_RECONNECT_MAX_ATTEMPTS) return
    reconnectAttempts += 1
    peer.reconnect()
  }, PEER_RECONNECT_DELAY_MS)
  // peer.open is already false here: redraw so Join disables while the
  // pairing connection is down (the open handler's render re-enables it)
  render()
})
peer.on('error', (/** @type {{ type?: string, message?: string }} */ error) => {
  showError(
    'Connection problem',
    `${String(error.type)}: ${error.message || 'No further error details are available.'}`,
    error.type === 'network' ? 'pairing' : 'Connection problem'
  )
})

socket.on('user-connected', (/** @type {string} */ peerId) => {
  // A page that considers itself outside the room must not call:
  // stray membership can still announce joiners to it
  if (!joined) return
  roomPeers.add(peerId)
  closedRoomCalls.delete(peerId)
  // Accounting failed closed: no new calls, with the reason shown
  if (retentionBroken) {
    showError(
      'Connection problem',
      'Pinto cannot account for the messages the pairing library stores, so the person who just joined cannot be called.'
    )
    return
  }
  // While the pairing connection is down, peer.call returns undefined and
  // addCall would throw; say why the joiner is not being called instead.
  if (peer.disconnected) {
    showError(
      'Connection problem',
      'The connection to the server is down, so the person who just joined cannot be called.',
      'pairing'
    )
    return
  }
  const call = peer.call(peerId, outgoing)
  if (!call) {
    showError(
      'Connection problem',
      'The call to the person who just joined could not be started.'
    )
    return
  }
  addCall(call)
})
socket.on(
  'user-disconnected',
  (/** @type {string} */ peerId, /** @type {unknown} */ reason) => {
    const connectionId =
      calls.get(peerId)?.call.connectionId ?? closedRoomCalls.get(peerId)
    closedRoomCalls.delete(peerId)
    // A normal Leave sends a namespace disconnect. Only transport failures
    // establish lost room connectivity; older servers supply no reason.
    if (
      connectionId &&
      (reason === 'ping timeout' ||
        reason === 'transport close' ||
        reason === 'transport error')
    ) {
      showError(
        'Call connection',
        "A call ended because the other person's room connection was lost. No automatic redial is attempted.",
        connectionId
      )
    }
    roomPeers.delete(peerId)
    removeCall(peerId)
  }
)

if (!roomLockSupported) {
  roomPhase = 'unsupported'
  // A distinct error from the same-name-tab Blocked state; no unlocked
  // fallback, Join stays disabled
  showError(
    'Browser not supported',
    'Pinto needs the Web Locks API to keep one tab per room, and this browser does not have it. Joining is disabled.'
  )
}
render()
