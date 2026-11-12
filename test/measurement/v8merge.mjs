// Groups V8 coverage entries by their path and checks content identity. Only
// repeated loads of the same file with identical content merge; one path
// appearing with two different contents fails the run and names the conflict.
// Range structures legitimately differ between loads of identical source -
// V8 refines block ranges as code executes - so counts are not zipped here;
// the converter accumulates every load onto the file's own structure.

/**
 * url/source stay unknown: entries come from JSON.parse output, and the merge
 * only compares them for identity. Conversion narrows source itself.
 * @template Functions
 * @typedef {object} CoverageEntry
 * @property {unknown} [url]
 * @property {unknown} [source]
 * @property {Functions} [functions]
 */
/**
 * @template Functions
 * @typedef {object} MergedCoverage
 * @property {unknown} url
 * @property {unknown} source
 * @property {(Functions | undefined)[]} coverageList
 */

export class CoverageConflict extends Error {}

// ToString for JSON.parse data, kept exact so error messages read as they
// did when urls were interpolated directly: strings verbatim, numbers and
// booleans by String(), arrays joined with ',' (null elements empty), plain
// objects '[object Object]'. JSON has no functions, so an own toString
// member is never callable: interpolation called it and threw a TypeError,
// and the helper throws at the same point (failure kind changed only).
// At the conflict site itself only strings, truthy numbers and true are
// reachable: falsy urls are skipped before keying, and object/array urls
// are identity-keyed so two JSON parses can never collide. The array and
// object branches exist for totality, not for that call.
/** @param {unknown} value @returns {string} */
function jsonToString(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  if (Array.isArray(value))
    return value
      .map((el) => (el === null || el === undefined ? '' : jsonToString(el)))
      .join(',')
  if (typeof Reflect.get(value, 'toString', value) !== 'function')
    throw new Error('coverage data url cannot be stringified')
  return '[object Object]'
}

// entries: [{ url, source, functions: [...] }]
// returns Map url -> { url, source, coverageList: [functions, ...] }
/** @template Functions @param {CoverageEntry<Functions>[]} entries */
export function mergeV8Entries(entries) {
  /** @type {Map<unknown, MergedCoverage<Functions>>} */
  const byUrl = new Map()
  for (const entry of entries) {
    if (!entry.url) continue
    const existing = byUrl.get(entry.url)
    if (!existing) {
      byUrl.set(entry.url, {
        url: entry.url,
        source: entry.source,
        coverageList: [entry.functions]
      })
      continue
    }
    // A take whose source could not be retrieved carries source undefined;
    // that is a retrieval gap, not a content signal, so it joins the file
    // without voting on identity. Two defined sources that differ still
    // fail the run, and a file with no defined source fails at conversion.
    if (existing.source === undefined) existing.source = entry.source
    else if (entry.source !== undefined && existing.source !== entry.source) {
      throw new CoverageConflict(
        `coverage conflict: ${jsonToString(entry.url)} appeared with two different contents`
      )
    }
    existing.coverageList.push(entry.functions)
  }
  return byUrl
}

// A file on a list that never loaded counts as 0% for its pipeline: one
// zero-count range over the whole file leaves every path uncovered.
/** @param {string} url @param {string} source */
export function uncovered(url, source) {
  return {
    url,
    source,
    coverageList: [
      [
        {
          functionName: '(never-loaded)',
          ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }],
          isBlockCoverage: true
        }
      ]
    ]
  }
}
