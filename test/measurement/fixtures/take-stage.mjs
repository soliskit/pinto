// Finite observations of stored takes. Never a capture-completeness claim.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { observeHelper } from './source-stage.mjs'
export const reasons = [
  'before-goto',
  'before-click',
  'before-press',
  'poll',
  'page-close',
  'context-close',
  'other-known-api'
]
export const states = [
  'absent-exact',
  'exact-zero',
  'exact-positive',
  'no-event-entry',
  'inconclusive'
]
export const relations = [
  'earlier-initiation',
  'action-initiation',
  'later-initiation'
]
const reasonMap = new Map([
  ['before:goto', 'before-goto'],
  ['before:click', 'before-click'],
  ['before:press', 'before-press'],
  ['poll', 'poll'],
  ['page.close', 'page-close'],
  ['context.close', 'context-close'],
  ...['reload', 'goBack', 'goForward', 'dblclick', 'tap'].map((name) => [
    'before:' + name,
    'other-known-api'
  ])
])
export const takeKeys = [
  'take-metadata',
  'take-order',
  ...reasons.flatMap((reason) =>
    states.map((state) => `take-reason-${reason}-${state}`)
  ),
  ...relations.flatMap((relation) =>
    states.map((state) => `take-order-${relation}-${state}`)
  )
]
export function emptyTakeSummary() {
  return Object.fromEntries(takeKeys.map((key) => [key, 'inconclusive']))
}
/** @param {unknown} entries @param {unknown} source */
export function helperState(entries, source) {
  if (!Array.isArray(entries)) return 'inconclusive'
  if (!entries.length) return 'no-event-entry'
  const observation = observeHelper(entries, source)
  if (observation === null) return 'inconclusive'
  if (observation.raw === 'yes') return 'exact-positive'
  return observation.exact ? 'exact-zero' : 'absent-exact'
}
/** @param {number} count */
const cap = (count) => (count === 0 ? '0' : count === 1 ? '1' : '2plus')
// Inputs are parsed data, not instructions. Failure yields no partial summary.
export function summarizeTakes(records, index, source, mode) {
  const result = emptyTakeSummary()
  try {
    if (
      !['click', 'enter'].includes(mode) ||
      !Array.isArray(records) ||
      !records.length ||
      !Array.isArray(index) ||
      index.length !== records.length
    )
      return result
    const indexed = new Map()
    for (const item of index) {
      if (
        typeof item?.name !== 'string' ||
        typeof item.why !== 'string' ||
        indexed.has(item.name)
      )
        return result
      indexed.set(item.name, item.why)
    }
    const seen = new Set()
    const sequences = new Set()
    let childPid
    const takes = []
    for (const record of records) {
      const match =
        typeof record?.name === 'string' &&
        /^(\d+)-(\d+)\.json$/.exec(record.name)
      const data = record?.data
      if (
        !match ||
        seen.has(record.name) ||
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data)
      )
        return result
      seen.add(record.name)
      const pid = Number(match[1])
      const sequence = Number(match[2])
      if (
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        !Number.isSafeInteger(sequence) ||
        sequence <= 0 ||
        sequences.has(sequence) ||
        !Number.isSafeInteger(data.pid) ||
        data.pid !== pid ||
        (childPid !== undefined && childPid !== pid) ||
        !Number.isFinite(data.at) ||
        !Array.isArray(data.entries) ||
        !Array.isArray(data.navigations) ||
        !reasonMap.has(data.why) ||
        indexed.get(record.name) !== data.why
      )
        return result
      childPid = pid
      sequences.add(sequence)
      for (const navigation of data.navigations) {
        if (
          !navigation ||
          !Number.isFinite(navigation.at) ||
          typeof navigation.url !== 'string'
        )
          return result
        new URL(navigation.url)
      }
      const entries = []
      for (const entry of data.entries) {
        if (!entry || typeof entry.url !== 'string') return result
        if (new URL(entry.url).pathname === '/event.js') entries.push(entry)
      }
      takes.push({
        sequence,
        why: data.why,
        reason: reasonMap.get(data.why),
        state: helperState(entries, source)
      })
    }
    result['take-metadata'] = 'valid'
    for (const reason of reasons)
      for (const state of states)
        result[`take-reason-${reason}-${state}`] = cap(
          takes.filter((take) => take.reason === reason && take.state === state)
            .length
        )
    const action = takes.filter(
      (take) => take.why === 'before:' + (mode === 'click' ? 'click' : 'press')
    )
    if (action.length !== 1) return result
    result['take-order'] = 'valid'
    for (const relation of relations)
      for (const state of states)
        result[`take-order-${relation}-${state}`] = cap(
          takes.filter(
            (take) =>
              take.state === state &&
              (relation === 'earlier-initiation'
                ? take.sequence < action[0].sequence
                : relation === 'action-initiation'
                  ? take.sequence === action[0].sequence
                  : take.sequence > action[0].sequence)
          ).length
        )
    return result
  } catch {
    return emptyTakeSummary()
  }
}
// Call only after the unchanged original capture validator has succeeded.
/** @param {string} dir @param {string} source @param {string} mode */
export function readTakeSummary(dir, source, mode) {
  try {
    const text = readFileSync(join(dir, 'captures.index'), 'utf8')
    const lines = text.split('\n')
    if (lines.at(-1) === '') lines.pop()
    const index = lines.map((line) => {
      const parts = line.split('\t')
      if (parts.length !== 2) throw new Error('invalid index')
      return { name: parts[0], why: parts[1] }
    })
    const records = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({
        name,
        data: JSON.parse(readFileSync(join(dir, name), 'utf8'))
      }))
    return summarizeTakes(records, index, source, mode)
  } catch {
    return emptyTakeSummary()
  }
}
