// Globals set by the scripts room.html loads before room.js
// PeerJS accepts structural option objects. Its exported declaration models
// that shape as a class, but PeerOptions is not a runtime export.
type BrowserPeerOptions = {
  [K in keyof import('peerjs').PeerOptions]: import('peerjs').PeerOptions[K]
}
type BrowserPeerConstructor = Omit<typeof import('peerjs').Peer, never> & {
  new (
    ...args:
      | []
      | [options: BrowserPeerOptions]
      | [id: string, options?: BrowserPeerOptions]
  ): import('peerjs').Peer
}
declare const Peer: BrowserPeerConstructor
declare const io: typeof import('socket.io-client').io
