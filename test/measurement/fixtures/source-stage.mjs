// Finite stored-take observations. They do not certify capture completeness.
const answer = (value) => (value ? 'yes' : 'no')
export function sourceMatch(entries, source) {
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    typeof source !== 'string' ||
    source.length === 0
  )
    return 'inconclusive'
  if (entries.some((entry) => typeof entry?.source !== 'string'))
    return 'inconclusive'
  return answer(entries.every((entry) => entry.source === source))
}
export function rawHelperPositive(entries, source) {
  if (sourceMatch(entries, source) !== 'yes') return 'inconclusive'
  const start = source.indexOf('function submitted()')
  const end = source.indexOf('}', start) + 1
  if (start < 0 || end <= start) return 'inconclusive'
  for (const entry of entries) {
    if (!Array.isArray(entry.functions)) return 'inconclusive'
    for (const fn of entry.functions) {
      if (typeof fn?.functionName !== 'string' || !Array.isArray(fn.ranges))
        return 'inconclusive'
      if (!fn.ranges.length) return 'inconclusive'
      for (const range of fn.ranges)
        if (
          !Number.isInteger(range?.startOffset) ||
          !Number.isInteger(range.endOffset) ||
          range.startOffset < 0 ||
          range.endOffset < range.startOffset ||
          range.endOffset > source.length ||
          !Number.isInteger(range.count) ||
          range.count < 0
        )
          return 'inconclusive'
      const outer = fn.ranges[0]
      const stack = [outer]
      for (const range of fn.ranges.slice(1)) {
        if (
          range.startOffset < outer.startOffset ||
          range.endOffset > outer.endOffset ||
          (range.startOffset === outer.startOffset &&
            range.endOffset === outer.endOffset)
        )
          return 'inconclusive'
        while (stack.length > 1 && range.startOffset >= stack.at(-1).endOffset)
          stack.pop()
        const parent = stack.at(-1)
        if (
          range.startOffset < parent.startOffset ||
          range.endOffset > parent.endOffset ||
          (range.startOffset === parent.startOffset &&
            range.endOffset === parent.endOffset)
        )
          return 'inconclusive'
        stack.push(range)
      }
    }
  }
  return answer(
    entries.some((entry) =>
      entry.functions.some(
        (fn) =>
          fn.functionName === 'submitted' &&
          fn.ranges[0].startOffset === start &&
          fn.ranges[0].endOffset === end &&
          fn.ranges[0].count > 0
      )
    )
  )
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
export function wrapperLine2Positive(hit) {
  return Number.isFinite(hit) && hit >= 0 ? answer(hit > 0) : 'inconclusive'
}
