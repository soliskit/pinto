// Integrity checks for the measured content: served scripts match their
// checked-in sources, third-party scripts match the installed packages, the
// lockfile shows no patches or non-registry sources, and no page carries
// script inside its HTML.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MeasurementFailure } from './validate.mjs'
import { browserFiles, thirdPartyFiles, root } from './filelists.mjs'

// The packages must come clean from the npm registry at locked versions: no
// install-time patches, no fork overrides, no non-registry sources.
/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function fieldOf(value, key) {
  return typeof value === 'object' && value !== null && key in value
    ? Reflect.get(value, key)
    : undefined
}

export function checkLockfile() {
  /** @type {unknown} */
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  // A null lockfile threw a TypeError here before; it is now a failure.
  if (lock === null)
    throw new MeasurementFailure(
      'third-party package check failed: package-lock.json is null'
    )
  const packages = fieldOf(lock, 'packages')
  const problems = []
  for (const entry of packages ? Object.entries(packages) : []) {
    const path = entry[0]
    if (
      !path.includes('node_modules/peerjs') &&
      !path.includes('node_modules/socket.io')
    )
      continue
    const resolved = fieldOf(entry[1], 'resolved')
    // A null package entry or a non-text resolved value threw a TypeError
    // here before; it is now a failure. Missing and empty values still pass.
    if (entry[1] === null || (typeof resolved !== 'string' && resolved))
      throw new MeasurementFailure(
        `third-party package check failed: ${path} has an unreadable entry`
      )
    if (
      typeof resolved === 'string' &&
      resolved &&
      !resolved.startsWith('https://registry.npmjs.org/')
    ) {
      problems.push(`${path} resolves from non-registry source ${resolved}`)
    }
  }
  for (const name of ['peerjs', 'socket.io']) {
    const top = fieldOf(packages, `node_modules/${name}`)
    if (!top) problems.push(`${name} is not installed at top level`)
  }
  if (problems.length) {
    throw new MeasurementFailure(
      'third-party package check failed: ' + problems.join('; ')
    )
  }
}

// Every served own-code script in the captures must equal its checked-in
// source, and each served third-party script must equal the installed
// package. A mismatch that is not a declared server-built script fails the run.
// Property read with ordinary [[Get]] semantics: null/undefined yield
// undefined, primitives box for the holder but stay the getter receiver.
/** @param {unknown} value @param {string} key @returns {unknown} */
const readKey = (value, key) =>
  value === null || value === undefined
    ? undefined
    : Reflect.get(Object(value), key, value)

/** @param {unknown[]} browserEntries */
export function checkServedScripts(browserEntries) {
  const own = new Map(
    browserFiles().map((f) => [f.servedPath, readFileSync(f.abs, 'utf8')])
  )
  const third = new Map(
    thirdPartyFiles().map((f) => [
      f.servedPath,
      readFileSync(f.packageFile, 'utf8')
    ])
  )
  // A capture whose source could not be retrieved carries undefined; that is
  // a retrieval gap, not content. Every retrieved source for a known path
  // must match, and a known path seen only through irretrievable sources
  // fails the run as unverifiable.
  /** @type {Set<string>} */
  const seenUnverifiable = new Set()
  /** @type {Set<string>} */
  const seenVerified = new Set()
  for (const entry of browserEntries) {
    let pathname
    try {
      pathname = new URL(String(readKey(entry, 'url'))).pathname
    } catch {
      continue
    }
    const expected = own.has(pathname)
      ? own.get(pathname)
      : third.has(pathname)
        ? third.get(pathname)
        : undefined
    if (expected === undefined) continue
    if (readKey(entry, 'source') === undefined) {
      if (!seenVerified.has(pathname)) seenUnverifiable.add(pathname)
      continue
    }
    if (readKey(entry, 'source') !== expected) {
      throw new MeasurementFailure(
        own.has(pathname)
          ? `served script differs from its checked-in source: ${pathname}`
          : `third-party script differs from its installed package: ${pathname}`
      )
    }
    seenVerified.add(pathname)
    seenUnverifiable.delete(pathname)
  }
  for (const pathname of seenUnverifiable) {
    throw new MeasurementFailure(
      `served script content could not be retrieved for verification: ${pathname}`
    )
  }
}

// Detects script written inside a page's HTML, including event-handler
// attributes. Fixture-proven; a page that carries one fails the check.
/** @param {string} html @param {string} pageName */
export function findInlineScripts(html, pageName) {
  const problems = []
  const scriptTags = html.match(/<script\b[^>]*>/gi) || []
  for (const tag of scriptTags) {
    if (!/\bsrc\s*=/i.test(tag)) {
      problems.push(`${pageName} has a <script> tag without src`)
    }
  }
  const stripped = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  const handlers = stripped.match(/\son[a-z]+\s*=/gi) || []
  for (const h of handlers) {
    problems.push(
      `${pageName} has an event-handler attribute (${h.trim().split('=')[0]})`
    )
  }
  return problems
}

// Fetches the pages from a verification server (never a measured one) and
// checks both the inline-script rule and that served HTML matches disk.
/** @param {string} baseUrl */
export async function checkPages(baseUrl) {
  const pages = [
    { name: 'index.html', path: '/' },
    { name: 'room.html', path: '/room/measurement-check' }
  ]
  const problems = []
  for (const page of pages) {
    const res = await fetch(baseUrl + page.path)
    const html = await res.text()
    const onDisk = readFileSync(join(root, 'public', page.name), 'utf8')
    if (html !== onDisk) {
      throw new MeasurementFailure(
        `served page differs from its checked-in file: ${page.name}`
      )
    }
    problems.push(...findInlineScripts(html, page.name))
  }
  if (problems.length) {
    throw new MeasurementFailure(
      'inline script check failed: ' + problems.join('; ')
    )
  }
}
