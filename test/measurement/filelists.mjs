// The settled production file lists for Pinto's measurement. Settling a list
// scopes measurement only; anything the rule leaves out is reported, never
// dropped silently.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

export const root = fileURLToPath(new URL('../..', import.meta.url))

// Server pipeline: the executable TypeScript under src/ that Node runs directly.
export function serverFiles() {
  return ['src/index.ts', 'src/ice-servers.ts'].map((rel) => ({
    rel,
    abs: join(root, rel),
    url: 'file://' + join(root, rel)
  }))
}

// Browser pipeline: the JavaScript the pages load under public/.
export function browserFiles() {
  return ['public/element.js', 'public/home.js', 'public/ordinal.js', 'public/room.js'].map(
    (rel) => ({ rel, abs: join(root, rel), servedPath: '/' + rel.slice('public/'.length) })
  )
}

// Third-party scripts the pages load, served from the installed packages.
// Each is compared against the installed package at the locked version; a
// mismatch fails the run. They are named in the inventory, never counted as
// Pinto's own code.
export function thirdPartyFiles() {
  const peerjs = fileURLToPath(import.meta.resolve('peerjs/dist/peerjs.min.js'))
  // socket.io does not export its client dist through its exports map; the
  // server package serves it from this fixed location at the locked version.
  const socketio = join(root, 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js')
  return [
    { name: 'peerjs', servedPath: '/vendor/peerjs.min.js', packageFile: peerjs },
    { name: 'socket.io', servedPath: '/socket.io/socket.io.min.js', packageFile: socketio }
  ]
}

export function readFile(abs) {
  return readFileSync(abs, 'utf8')
}
