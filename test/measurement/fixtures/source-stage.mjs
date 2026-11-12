// Finite stored-take observations. They do not certify capture completeness.
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === 'object' && value !== null
/** @param {unknown} value @returns {value is unknown[]} */
const isList = (value) => Array.isArray(value)
/** @param {unknown} value @returns {value is number} */
const isInteger = (value) => Number.isInteger(value)
/** @param {unknown} value @returns {value is number} */
const isFiniteNumber = (value) => Number.isFinite(value)
/** @param {boolean} value */
const answer = (value) => (value ? 'yes' : 'no')
/** @param {unknown} entries @param {unknown} source */
export function sourceMatch(entries, source) {
  if (
    !isList(entries) ||
    !entries.length ||
    typeof source !== 'string' ||
    source.length === 0
  )
    return 'inconclusive'
  let same = true
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.source !== 'string')
      return 'inconclusive'
    if (entry.source !== source) same = false
  }
  return answer(same)
}
/**
 * @typedef {object} CheckedRange
 * @property {number} startOffset
 * @property {number} endOffset
 * @property {number} count
 * @typedef {{ raw: 'yes' | 'no', exact: boolean }} HelperObservation
 */
/**
 * The result covers only checked fields, not capture completeness.
 * @param {unknown} entries
 * @param {unknown} source
 * @returns {HelperObservation | null}
 */
export function observeHelper(entries, source) {
  if (
    !isList(entries) ||
    !entries.length ||
    typeof source !== 'string' ||
    source.length === 0
  )
    return null
  const start = source.indexOf('function submitted()')
  const end = source.indexOf('}', start) + 1
  if (start < 0 || end <= start) return null
  let positive = false
  let exact = false
  for (const entry of entries) {
    if (!isRecord(entry) || entry.source !== source || !isList(entry.functions))
      return null
    for (const fn of entry.functions) {
      if (
        !isRecord(fn) ||
        typeof fn.functionName !== 'string' ||
        !isList(fn.ranges) ||
        !fn.ranges.length
      )
        return null
      /** @type {CheckedRange[]} */
      const ranges = []
      for (const range of fn.ranges) {
        if (
          !isRecord(range) ||
          !isInteger(range.startOffset) ||
          !isInteger(range.endOffset) ||
          range.startOffset < 0 ||
          range.endOffset < range.startOffset ||
          range.endOffset > source.length ||
          !isInteger(range.count) ||
          range.count < 0
        )
          return null
        ranges.push({
          startOffset: range.startOffset,
          endOffset: range.endOffset,
          count: range.count
        })
      }
      const outer = ranges[0]
      const stack = [outer]
      for (const range of ranges.slice(1)) {
        if (
          range.startOffset < outer.startOffset ||
          range.endOffset > outer.endOffset ||
          (range.startOffset === outer.startOffset &&
            range.endOffset === outer.endOffset)
        )
          return null
        while (
          stack.length > 1 &&
          range.startOffset >= stack[stack.length - 1].endOffset
        )
          stack.pop()
        const parent = stack[stack.length - 1]
        if (
          range.startOffset < parent.startOffset ||
          range.endOffset > parent.endOffset ||
          (range.startOffset === parent.startOffset &&
            range.endOffset === parent.endOffset)
        )
          return null
        stack.push(range)
      }
      if (
        fn.functionName === 'submitted' &&
        outer.startOffset === start &&
        outer.endOffset === end
      ) {
        exact = true
        if (outer.count > 0) positive = true
      }
    }
  }
  return { raw: positive ? 'yes' : 'no', exact }
}
/** @param {unknown} entries @param {unknown} source */
export function rawHelperPositive(entries, source) {
  return observeHelper(entries, source)?.raw ?? 'inconclusive'
}
/**
 * @template Entry
 * @param {Entry[]} entries
 * @param {unknown} source
 * @param {(entry: Entry) => unknown} convert
 */
export async function directLine2Positive(entries, source, convert) {
  if (sourceMatch(entries, source) !== 'yes') return 'inconclusive'
  let positive = false
  try {
    for (const entry of entries) {
      const hit = await convert(entry)
      if (typeof hit !== 'number' || !Number.isFinite(hit) || hit < 0)
        return 'inconclusive'
      if (hit > 0) positive = true
    }
    return answer(positive)
  } catch {
    return 'inconclusive'
  }
}
/** @param {unknown} hit */
export function wrapperLine2Positive(hit) {
  return isFiniteNumber(hit) && hit >= 0 ? answer(hit > 0) : 'inconclusive'
}
