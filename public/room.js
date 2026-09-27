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

// While the camera is off, peers see a photo drawn on a canvas
const canvas = document.createElement('canvas')
canvas.width = 400
canvas.height = 300
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
  const scale = Math.min(1, 288 / photo.width, 288 / photo.height)
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
  document.title = `Pinto Pinto | ${roomName}`
  title.textContent = joined ? `Joined | ${roomName}` : `Join room: ${roomName}`
  status.textContent = joined
    ? `${ordinal(attendees.childElementCount + 1)} in the room`
    : 'Choose Join Now to begin call'
  muteButton.textContent = muted ? 'Unmute' : 'Mute'
  cameraButton.textContent = cameraOn ? 'Stop Video' : 'Start Video'
  cameraButton.disabled = !cameraTrack
  photoInput.disabled = cameraOn
  selfLabel.title = cameraOn ? '' : 'Choose a photo to show instead of video'
  removePhotoButton.hidden = cameraOn || !photo.src.startsWith('blob:')
  callButton.textContent = joined ? 'End' : 'Join Now'
  callButton.classList.toggle('end', joined)
  callButton.disabled = !peer.open || !mediaReady
}

photo.addEventListener('load', drawPhoto)
// A canvas only produces frames when painted, so keep painting for peers
// who join later
setInterval(drawPhoto, 1000)
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
    for (const peerId of calls.keys()) removeCall(peerId)
    // A fresh connection leaves the room, and the server tells the others
    socket.disconnect().connect()
  } else {
    socket.emit('join-room', roomName, peer.id)
  }
  joined = !joined
  render()
})

peer.on('open', render)
peer.on('call', (call) => {
  if (!joined) {
    call.close()
    return
  }
  call.answer(outgoing)
  addCall(call)
})
peer.on('disconnected', () => {
  setTimeout(() => {
    if (peer.disconnected && !peer.destroyed) peer.reconnect()
  }, 5000)
})
peer.on('error', (error) =>
  showError('Peer', `${error.type}: ${error.message}`)
)

socket.on('user-connected', (peerId) => addCall(peer.call(peerId, outgoing)))
socket.on('user-disconnected', removeCall)

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
  showError('Camera', `Camera and microphone are unavailable: ${reason}`)
} finally {
  mediaReady = true
  render()
}
