import { normalizeOwnNodeEntry } from './node-source-identity.mjs'
// Run validation. A report is never assumed from a file's existence: each
// server report must be complete, readable and tied to its own process, and
// stale or cut-off reports are rejected. Browser captures are counted against
// the preload's index so a dropped capture fails the run.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export class MeasurementFailure extends Error {}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null
}

/**
 * @param {unknown} range
 * @returns {boolean}
 */
function isRange(range) {
  return (
    isRecord(range) &&
    typeof range.startOffset === 'number' &&
    typeof range.endOffset === 'number' &&
    typeof range.count === 'number'
  )
}

/**
 * @param {unknown} entry
 * @returns {string | undefined}
 */
function urlOf(entry) {
  // A null entry threw a TypeError here before; it is now a failure.
  if (entry === null) {
    throw new MeasurementFailure('coverage report has a null entry')
  }
  return isRecord(entry) && typeof entry.url === 'string'
    ? entry.url
    : undefined
}

// Wrong-typed V8 function data used to be passed to the coverage library
// unchecked; it now fails the run. A missing functions list is still accepted.
/**
 * @param {unknown} entry
 * @param {string} where
 */
function checkFunctions(entry, where) {
  if (!isRecord(entry)) return
  const functions = Array.isArray(entry.functions) ? entry.functions : []
  for (const fn of functions) {
    const ok =
      isRecord(fn) &&
      typeof fn.functionName === 'string' &&
      typeof fn.isBlockCoverage === 'boolean' &&
      Array.isArray(fn.ranges) &&
      fn.ranges.every(isRange)
    if (!ok) {
      throw new MeasurementFailure(`malformed V8 function coverage in ${where}`)
    }
  }
}

/**
 * @param {string} dir
 * @param {number} runStartedAt
 * @param {Set<string>} serverUrls
 * @param {ReturnType<typeof import('./node-source-identity.mjs').scopedSourceBindings> | null} [sourceBindings]
 */
export function validateServerDir(
  dir,
  runStartedAt,
  serverUrls,
  sourceBindings
) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  if (files.length === 0) {
    throw new MeasurementFailure(`no server coverage reports in ${dir}`)
  }
  /** @type {unknown[]} */
  const entries = []
  let filesWithApp = 0
  for (const f of files) {
    const path = join(dir, f)
    if (statSync(path).mtimeMs < runStartedAt - 1000) {
      throw new MeasurementFailure(`stale coverage report rejected: ${f}`)
    }
    /** @type {unknown} */
    let parsed
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      throw new MeasurementFailure(
        `cut-off or unreadable coverage report rejected: ${f}`
      )
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.result)) {
      throw new MeasurementFailure(`coverage report has no result array: ${f}`)
    }
    /** @type {unknown[]} */
    const result = parsed.result
    const appEntries = sourceBindings
      ? result
          // Non-record entries reach normalizeOwnNodeEntry as null either
          // way: its own reads land inside its try and are filtered out.
          .map((r) =>
            isRecord(r) ? normalizeOwnNodeEntry(r, sourceBindings) : null
          )
          .filter(Boolean)
      : result.filter((r) => {
          const u = urlOf(r)
          return u !== undefined && serverUrls.has(u)
        })
    for (const r of appEntries) checkFunctions(r, f)
    if (appEntries.length > 0) filesWithApp++
    for (const r of appEntries) entries.push(r)
  }
  if (filesWithApp === 0) {
    throw new MeasurementFailure(
      'no server coverage report is tied to a server process (no report contains the app sources)'
    )
  }
  return entries
}

/** @param {string} dir */
export function validateBrowserDir(dir) {
  const indexPath = join(dir, 'captures.index')
  /** @type {string[]} */
  let indexed
  try {
    indexed = readFileSync(indexPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t')[0])
  } catch {
    indexed = []
  }
  const present = readdirSync(dir).filter((f) => f.endsWith('.json'))
  const failed = readdirSync(dir).filter((f) => f.endsWith('.failed'))
  for (const f of failed) {
    throw new MeasurementFailure(
      `browser capture failed: ${readFileSync(join(dir, f), 'utf8').trim()}`
    )
  }
  for (const name of indexed) {
    if (!present.includes(name)) {
      throw new MeasurementFailure(
        `a browser capture was dropped: ${name} is indexed but missing`
      )
    }
  }
  for (const name of present) {
    if (!indexed.includes(name)) {
      throw new MeasurementFailure(`unindexed browser capture: ${name}`)
    }
  }
  /** @type {unknown[]} */
  const entries = []
  for (const name of present) {
    /** @type {unknown} */
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      throw new MeasurementFailure(
        `cut-off or unreadable browser capture rejected: ${name}`
      )
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
      throw new MeasurementFailure(`browser capture has no entries: ${name}`)
    }
    /** @type {unknown[]} */
    const captured = parsed.entries
    for (const entry of captured) checkFunctions(entry, name)
    entries.push(...captured)
  }
  return entries
}

// A run whose coverage data is missing fails the measurement. Every
// navigation must have a capture taken shortly before it - an API-wrapped
// take or a poll - so a navigation can never silently drop a document's
// coverage.
/** @param {string} dir */
export function checkNavigationCoverage(dir) {
  /** @type {Record<string, unknown>[]} */
  const captures = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    /** @type {unknown} */
    const capture = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    // A capture without a numeric at value used to sort as NaN; it now fails.
    if (!isRecord(capture) || typeof capture.at !== 'number') {
      throw new MeasurementFailure('a browser capture has no numeric at value')
    }
    captures.push(capture)
  }
  /** @type {number[]} */
  const takes = []
  for (const c of captures) {
    if (typeof c.at === 'number') takes.push(c.at)
  }
  takes.sort((a, b) => a - b)
  for (const capture of captures) {
    // Whatever truthy value is there is walked by its length, as before.
    const navs = capture.navigations || []
    const length = Number(
      typeof navs === 'string' || isRecord(navs)
        ? Reflect.get(Object(navs), 'length')
        : undefined
    )
    for (let i = 1; i < length; i++) {
      /** @type {unknown} */
      const nav = Reflect.get(Object(navs), i)
      // A navigation after the first with a non-number at or non-text url
      // used to be compared as is; it now fails the run.
      if (
        !isRecord(nav) ||
        typeof nav.at !== 'number' ||
        typeof nav.url !== 'string'
      ) {
        throw new MeasurementFailure(
          'a browser navigation has a non-number at or non-text url'
        )
      }
      const at = nav.at
      const covered = takes.some((t) => t <= at && t >= at - 600)
      if (!covered) {
        throw new MeasurementFailure(
          `coverage data is missing across a navigation to ${nav.url}: no capture in the 600ms before it`
        )
      }
    }
  }
}
