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
    /** Join answers held by the heldJoinAnswer test init, oldest first.
     *  Only server answers that actually arrived are held; ack errors
     *  (timeout, disconnect flush) are delivered immediately */
    heldJoinAnswers: { answer: unknown[]; release: () => void }[]
    /** Releases the oldest held join answer; throws when none is held */
    releaseJoinAnswer: () => void
    /** The room page's socket, stashed by the heldJoinAnswer test init */
    roomSocket: ReturnType<typeof io>
    /** Join-room attempts tagged by the heldJoinAnswer test init, in
     *  emission order; the outcome records the ack resolving in either
     *  direction. Harness metadata only, never transmitted */
    joinAttempts: {
      id: number
      outcome?: { answer: unknown[] } | { error: string }
    }[]
    /** Events the room page's socket sent, when a test registers
     *  onAnyOutgoing before a reconnect flush */
    outgoingPackets: string[]
    /** The socket id of a replacement connection, when a test records it */
    reconnectedAs: string | undefined
    /** Ids announced to the room page's own user-connected test listener */
    announcedPeers: string[]
    /** Callers whose calls the room page received (recordRoomCalls init) */
    incomingCalls: string[]
    /** Callers whose incoming calls the room page closed (recordRoomCalls) */
    closedCalls: string[]
    /** Callers whose incoming calls the room page answered (recordRoomCalls) */
    answeredCalls: string[]
    /** Incoming calls the room page answered (recordRoomCalls) */
    answeredConns: import('peerjs').MediaConnection[]
    /** Streams received on the room page's outgoing calls, by sender (recordRoomCalls) */
    outgoingStreams: { peer: string; stream: MediaStream }[]
    /** The room page's outgoing call connections (recordRoomCalls) */
    outgoingConns: import('peerjs').MediaConnection[]
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
