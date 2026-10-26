// @ts-check
import { element } from './element.js'
import { ordinal } from './ordinal.js'

/** @typedef {import('peerjs').MediaConnection} MediaConnection */

const DEFAULT_PHOTO = '/no-video.svg'
const roomName = decodeURIComponent(location.pathname.slice('/room/'.length))

const errorBox = element('error', HTMLDivElement)
const errorTitle = element('error-title', HTMLHeadingElement)
const errorMessage = element('error-message', HTMLHeadingElement)
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
const PEER_RECONNECT_DELAY_MS = 5000

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

/** What peers receive: one video track (camera or photo) and the mic */
const outgoing = new MediaStream([photoTrack])
/** @type {MediaStreamTrack | undefined} */
let cameraTrack
let mediaReady = false
let cameraOn = false
let muted = false
let joined = false
/** @type {Map<string, { call: MediaConnection, video: HTMLVideoElement }>} */
const calls = new Map()
/** Peer ids the server says are in the room; only these are called or answered */
const roomPeers = new Set()
/** False until the server answers our join with the room roster */
let rosterLoaded = false
/** Increments on every Join and Leave, retiring older join attempts */
let joinSerial = 0
/** Calls that arrived while the roster answer was still on its way */
const earlyCalls = /** @type {MediaConnection[]} */ ([])

/** @type {{ key: string, iceServers: RTCIceServer[] }} */
const config = await (await fetch('/config')).json()
const secure = location.protocol === 'https:'
const peer = new Peer({
  host: location.hostname,
  port: Number(location.port) || (secure ? 443 : 80),
  secure,
  path: '/',
  key: config.key,
  config: { iceServers: config.iceServers }
})
const socket = io()

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
      .find((sender) => sender.track?.kind === 'video')
    sender?.replaceTrack(track)
  }
}

/** @param {MediaConnection} call */
function addCall(call) {
  removeCall(call.peer)
  const video = document.createElement('video')
  video.autoplay = true
  video.playsInline = true
  calls.set(call.peer, { call, video })
  call.on('stream', (stream) => {
    video.srcObject = stream
    attendees.append(video)
    render()
  })
  call.on('close', () => {
    if (calls.get(call.peer)?.call === call) removeCall(call.peer)
  })
  call.on('error', (error) => console.error(error))
}

/** @param {string} peerId */
function removeCall(peerId) {
  const entry = calls.get(peerId)
  if (!entry) return
  calls.delete(peerId)
  entry.call.close()
  entry.video.remove()
  render()
}

/**
 * @param {string} heading
 * @param {string} message
 */
function showError(heading, message) {
  errorTitle.textContent = heading
  errorMessage.textContent = message
  errorBox.hidden = false
}

function render() {
  document.title = `Pinto | ${roomName}`
  title.textContent = joined ? `You are in ${roomName}` : `Join ${roomName}`
  status.textContent = joined
    ? `${ordinal(attendees.childElementCount + 1)} in the room`
    : 'Press Join to start the call'
  muteButton.textContent = muted ? 'Unmute' : 'Mute'
  cameraButton.textContent = cameraOn ? 'Turn Off Camera' : 'Turn On Camera'
  cameraButton.disabled = !cameraTrack
  photoInput.disabled = cameraOn
  selfLabel.title = cameraOn
    ? ''
    : 'Choose a photo to show instead of your video'
  removePhotoButton.hidden = cameraOn || !photo.src.startsWith('blob:')
  callButton.textContent = joined ? 'Leave' : 'Join'
  callButton.classList.toggle('end', joined)
  callButton.disabled = !peer.open || !mediaReady
}

photo.addEventListener('load', drawPhoto)
// A canvas only produces frames when painted, so keep painting for peers
// who join later
setInterval(drawPhoto, PHOTO_REDRAW_INTERVAL_MS)
selfVideo.srcObject = new MediaStream([photoTrack])

muteButton.addEventListener('click', () => {
  muted = !muted
  for (const track of outgoing.getAudioTracks()) track.enabled = !muted
  render()
})

cameraButton.addEventListener('click', () => {
  if (!cameraTrack) return
  cameraOn = !cameraOn
  sendVideo(cameraOn ? cameraTrack : photoTrack)
  render()
})

photoInput.addEventListener('change', () => {
  const file = photoInput.files?.[0]
  if (file) setPhoto(URL.createObjectURL(file))
  photoInput.value = ''
})

removePhotoButton.addEventListener('click', () => setPhoto(DEFAULT_PHOTO))

callButton.addEventListener('click', () => {
  if (joined) {
    joinSerial++
    for (const peerId of calls.keys()) removeCall(peerId)
    roomPeers.clear()
    rosterLoaded = false
    for (const call of earlyCalls.splice(0)) call.close()
    // A fresh connection leaves the room, and the server tells the others
    socket.disconnect().connect()
  } else {
    const serial = ++joinSerial
    let attempts = 0
    const tryJoin = () => {
      if (serial !== joinSerial) return
      socket
        .timeout(5_000)
        .emit(
          'join-room',
          roomName,
          peer.id,
          (
            /** @type {Error | null} */ error,
            /** @type {string[] | null} */ members
          ) => {
            if (serial !== joinSerial) return
            // A refusal or a lost answer usually means the room still has
            // our id from a previous connection; try again until it clears
            if (error || members === null) {
              if (attempts++ < 4) {
                // 5 attempts in all, about 2 seconds apart
                setTimeout(tryJoin, 2_000)
                return
              }
              // Still refused: back to not joined, with Join available
              joined = false
              for (const call of earlyCalls.splice(0)) call.close()
              render()
              return
            }
            for (const peerId of members) roomPeers.add(peerId)
            rosterLoaded = true
            // Calls that beat the roster answer get decided now
            for (const call of earlyCalls.splice(0)) answerIfMember(call)
          }
        )
    }
    tryJoin()
  }
  joined = !joined
  render()
})

peer.on('open', render)
/** Answers a call from a room member and closes any other */
function answerIfMember(/** @type {MediaConnection} */ call) {
  if (!roomPeers.has(call.peer)) {
    call.close()
    return
  }
  call.answer(outgoing)
  addCall(call)
}

peer.on('call', (call) => {
  if (!joined) {
    call.close()
    return
  }
  // Members can hear about us and call before our roster answer arrives;
  // those calls wait for it instead of being refused by mistake
  if (!rosterLoaded) {
    earlyCalls.push(call)
    return
  }
  answerIfMember(call)
})
peer.on('disconnected', () => {
  setTimeout(() => {
    if (peer.disconnected && !peer.destroyed) peer.reconnect()
  }, PEER_RECONNECT_DELAY_MS)
})
peer.on('error', (error) =>
  showError('Connection problem', `${error.type}: ${error.message}`)
)

socket.on('user-connected', (peerId) => {
  roomPeers.add(peerId)
  addCall(peer.call(peerId, outgoing))
})
socket.on('user-disconnected', (peerId) => {
  roomPeers.delete(peerId)
  removeCall(peerId)
})

render()

try {
  const media = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true
  })
  cameraTrack = media.getVideoTracks()[0]
  for (const track of media.getAudioTracks()) {
    track.enabled = !muted
    outgoing.addTrack(track)
  }
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error)
  showError(
    'Camera and microphone',
    `Pinto can't reach your camera or microphone: ${reason}`
  )
} finally {
  mediaReady = true
  render()
}
