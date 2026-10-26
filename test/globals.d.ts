declare global {
  const Peer: typeof import('peerjs').Peer
  const io: typeof import('socket.io-client').io
  interface Window {
    /** Releases a join answer held by the heldJoinAnswer test init */
    releaseJoinAnswer: () => void
    recorded: {
      /** The camera and microphone stream room.js got */
      media?: MediaStream
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
