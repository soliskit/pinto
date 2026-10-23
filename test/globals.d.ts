declare global {
  const Peer: typeof import('peerjs').Peer
  interface Window {
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
    }
  }
}

export {}
