// Measurement-only own-source identity for Node module reload URLs.
import { realpathSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
/** @typedef {{url: string, source: string, sha256: string}} SourceBinding */
/** @param {{abs: string}[]} files */
export function scopedSourceBindings(files) {
  return new Map(
    files.map((f) => {
      const physical = realpathSync(f.abs)
      const source = readFileSync(physical, 'utf8')
      return [
        physical,
        {
          url: pathToFileURL(physical).href,
          source,
          sha256: createHash('sha256').update(source).digest('hex')
        }
      ]
    })
  )
}
/**
 * @template {{url?: unknown, source?: unknown}} Entry
 * @param {Entry} entry
 * @param {Map<string, SourceBinding>} bindings
 */
export function normalizeOwnNodeEntry(entry, bindings) {
  let u, physical
  try {
    u = new URL(String(entry.url))
    if (u.protocol !== 'file:') return null
    physical = realpathSync(fileURLToPath(u))
  } catch {
    return null
  }
  const binding = bindings.get(physical)
  if (!binding) return null
  // The raw Node V8 format has no script source. Caller must bind the disk
  // snapshot to clean pinned production source; a supplied source must match.
  const currentHash = createHash('sha256')
    .update(readFileSync(physical, 'utf8'))
    .digest('hex')
  if (currentHash !== binding.sha256)
    throw new Error('source changed during measurement for ' + physical)
  const source = entry.source === undefined ? binding.source : entry.source
  // A non-string source threw a TypeError from update() before; say it here.
  if (typeof source !== 'string')
    throw new TypeError(
      'source conflict for ' + physical + ': source is not a string'
    )
  const hash = createHash('sha256').update(source).digest('hex')
  if (hash !== binding.sha256)
    throw new Error('source conflict for ' + physical)
  return { ...entry, url: binding.url, source }
}
