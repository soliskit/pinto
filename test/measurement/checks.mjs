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
export function checkLockfile() {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  const problems = []
  for (const [path, pkg] of Object.entries(lock.packages || {})) {
    if (
      !path.includes('node_modules/peerjs') &&
      !path.includes('node_modules/socket.io')
    )
      continue
    if (
      pkg.resolved &&
      !pkg.resolved.startsWith('https://registry.npmjs.org/')
    ) {
      problems.push(`${path} resolves from non-registry source ${pkg.resolved}`)
    }
  }
  for (const name of ['peerjs', 'socket.io']) {
    const top = lock.packages?.[`node_modules/${name}`]
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
  const seenUnverifiable = new Set()
  const seenVerified = new Set()
  for (const entry of browserEntries) {
    let pathname
    try {
      pathname = new URL(entry.url).pathname
    } catch {
      continue
    }
    const expected = own.has(pathname)
      ? own.get(pathname)
      : third.has(pathname)
        ? third.get(pathname)
        : undefined
    if (expected === undefined) continue
    if (entry.source === undefined) {
      if (!seenVerified.has(pathname)) seenUnverifiable.add(pathname)
      continue
    }
    if (entry.source !== expected) {
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
