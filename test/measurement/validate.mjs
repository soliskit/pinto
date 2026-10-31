// Run validation. A report is never assumed from a file's existence: each
// server report must be complete, readable and tied to its own process, and
// stale or cut-off reports are rejected. Browser captures are counted against
// the preload's index so a dropped capture fails the run.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export class MeasurementFailure extends Error {}

export function validateServerDir(dir, runStartedAt, serverUrls) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  if (files.length === 0) {
    throw new MeasurementFailure(`no server coverage reports in ${dir}`)
  }
  const entries = []
  let filesWithApp = 0
  for (const f of files) {
    const path = join(dir, f)
    if (statSync(path).mtimeMs < runStartedAt - 1000) {
      throw new MeasurementFailure(`stale coverage report rejected: ${f}`)
    }
    let parsed
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      throw new MeasurementFailure(
        `cut-off or unreadable coverage report rejected: ${f}`
      )
    }
    if (!Array.isArray(parsed.result)) {
      throw new MeasurementFailure(`coverage report has no result array: ${f}`)
    }
    const appEntries = parsed.result.filter((r) => serverUrls.has(r.url))
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

export function validateBrowserDir(dir) {
  const indexPath = join(dir, 'captures.index')
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
  const entries = []
  for (const name of present) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      throw new MeasurementFailure(
        `cut-off or unreadable browser capture rejected: ${name}`
      )
    }
    if (!Array.isArray(parsed.entries)) {
      throw new MeasurementFailure(`browser capture has no entries: ${name}`)
    }
    entries.push(...parsed.entries)
  }
  return entries
}

// A run whose coverage data is missing fails the measurement. Every
// navigation must have a capture taken shortly before it - an API-wrapped
// take or a poll - so a navigation can never silently drop a document's
// coverage.
export function checkNavigationCoverage(dir) {
  const captures = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  const takes = captures.map((c) => c.at).sort((a, b) => a - b)
  for (const capture of captures) {
    const navs = capture.navigations || []
    for (let i = 1; i < navs.length; i++) {
      const at = navs[i].at
      const covered = takes.some((t) => t <= at && t >= at - 600)
      if (!covered) {
        throw new MeasurementFailure(
          `coverage data is missing across a navigation to ${navs[i].url}: no capture in the 600ms before it`
        )
      }
    }
  }
}
