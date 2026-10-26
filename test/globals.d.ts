declare global {
  const Peer: typeof import('peerjs').Peer
  const io: typeof import('socket.io-client').io
  interface Window {
    /** Capture requests held by the gatedCapture test init, oldest first */
    captureGate: {
      constraints: MediaStreamConstraints | undefined
      resolve: (stream: MediaStream) => void
      reject: (reason?: unknown) => void
    }[]
    /** The ungated getUserMedia, saved by the gatedCapture test init */
    realGetUserMedia: (
      constraints?: MediaStreamConstraints
    ) => Promise<MediaStream>
    /** Releases a join answer held by the heldJoinAnswer test init */
    releaseJoinAnswer: () => void
    recorded: {
      /** The camera and microphone stream room.js got */
      media?: MediaStream
      /** Every stream any getUserMedia call returned, oldest first */
      mediaStreams: MediaStream[]
      peerConnections: RTCPeerConnection[]
      /** WebSockets to the PeerJS server, and the messages they received */
      peerSockets: WebSocket[]
      peerMessages: string[]
    }
    caller: {
      peer: InstanceType<typeof Peer>
      stream: MediaStream
      /** Ids of the calls answered with a stream */
      answered: Set<string>
      /** Ids of the calls closed without one */
      closed: Set<string>
      /** Its Socket.IO connection, once it joins a room */
      socket?: ReturnType<typeof io>
    }
  }
}

export {}
