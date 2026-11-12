// Converts each V8 take separately, then merges its reported locations with
// the Istanbul library used by Tetris's browser reporter. Matching counts
// add; unmatched locations can inherit hits from a containing location in
// another take. These are observed-range totals, not a fixed syntax inventory
// or exact invocation counts. Mixed function/block granularity retains the
// library's containing-range interpretation.
import { libCoverage, isPositive } from './runtime-coverage.mjs'
import { createConverter as V8ToIstanbul } from './runtime-converter.mjs'

const { createFileCoverage } = libCoverage

/**
 * @typedef {object} V8Range
 * @property {number} startOffset
 * @property {number} endOffset
 * @property {number} count
 */
/**
 * @typedef {object} V8FunctionCoverage
 * @property {string} functionName
 * @property {boolean} isBlockCoverage
 * @property {V8Range[]} [ranges]
 */

// Coverage data is JSON.parse output: plain data only, no getters or custom
// methods. On plain data Array.isArray is exactly "has .map and iterates",
// Number() is the coercion Math.min/max apply, and a boxed property read is
// Reflect.get over Object(value). The helpers below keep the exact base
// semantics at each read while giving every value an honest type. Where the
// base read threw a TypeError (a null holder, .map on a non-array), the
// helper throws an Error at the same point - the failure remains, its kind
// changes.
/** @param {unknown} value @param {string} key @returns {unknown} */
const readProp = (value, key) => {
  if (value === null || value === undefined)
    throw new Error(`coverage data is missing the holder of ${key}`)
  return Reflect.get(Object(value), key, value)
}
// `(value || []).map(...)`: falsy maps as empty, a JSON array maps, any other
// truthy JSON value (strings included) threw TypeError at .map.
/** @param {unknown} value @returns {unknown[]} */
const arrayOrEmpty = (value) => {
  if (Array.isArray(value)) return value
  if (value) throw new Error('coverage data is not a list where .map was used')
  return []
}
// `for (const x of value || [])`: falsy iterates empty, a JSON array or
// string iterates, any other truthy JSON value threw TypeError "not
// iterable".
/** @param {unknown} value @returns {Iterable<unknown>} */
const iterateOrEmpty = (value) => {
  if (Array.isArray(value) || typeof value === 'string') return value
  if (value)
    throw new Error('coverage data is not iterable where a list is required')
  return []
}
// `{...value}` on JSON data: records and arrays spread their own entries,
// strings spread their characters, numbers and booleans spread to {}.
/** @param {unknown} value @returns {Record<string, unknown>} */
const spreadData = (value) => {
  /** @type {Record<string, unknown>} */
  const out = {}
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'string')
  )
    return out
  for (const key of Object.keys(value)) out[key] = readProp(value, key)
  return out
}

// A function-only zero is not evidence for any location inside that function.
// Give the library a zero root branch so it cannot inherit outer-block hits
// past this uncalled function. Positive function-only samples stay unchanged.
/** @param {unknown} functions @returns {unknown[]} */
const zeroAsBlock = (functions) =>
  arrayOrEmpty(functions).map((fn) => {
    const ranges = readProp(fn, 'ranges')
    const onlyCount =
      ranges === null || ranges === undefined
        ? undefined
        : readProp(ranges, 'length') === 1
          ? readProp(Reflect.get(Object(ranges), '0'), 'count')
          : undefined
    return !readProp(fn, 'isBlockCoverage') && onlyCount === 0
      ? { ...spreadData(fn), isBlockCoverage: true }
      : fn
  })

// merged: { url, source, coverageList: [functions, ...] } ; path for the report
// V8 lists a function only once it is compiled, so a load where a function
// never compiled has no entry for it, and converting that load credits the
// function's body through the enclosing range. Absent means never compiled,
// which means never run: completing each load with zero-count spans for the
// functions other loads of the same source observed removes only credit no
// execution could have produced. This happens at the V8 level because the
// converter's own function map drops anonymous functions entirely.
/** @param {unknown[]} coverageList @returns {unknown[]} */
export function completeFunctionLists(coverageList) {
  /** @type {Map<string, { name: unknown, start: number, end: number }>} */
  const union = new Map()
  for (const functions of coverageList) {
    for (const fn of iterateOrEmpty(functions)) {
      const fnRanges = readProp(fn, 'ranges')
      if (!fnRanges || readProp(fnRanges, 'length') === 0) continue
      const start = Math.min(
        ...arrayOrEmpty(fnRanges).map((r) => Number(readProp(r, 'startOffset')))
      )
      const end = Math.max(
        ...arrayOrEmpty(fnRanges).map((r) => Number(readProp(r, 'endOffset')))
      )
      const key = `${String(readProp(fn, 'functionName'))}@${String(start)}-${String(end)}`
      if (!union.has(key))
        union.set(key, { name: readProp(fn, 'functionName'), start, end })
    }
  }
  return coverageList.map(
    /** @param {unknown} functions @returns {unknown} */ (functions) => {
      const present = new Set(
        arrayOrEmpty(functions)
          .filter((fn) => {
            const fnRanges = readProp(fn, 'ranges')
            return fnRanges ? Number(readProp(fnRanges, 'length')) > 0 : false
          })
          .map((fn) => {
            const ranges = arrayOrEmpty(readProp(fn, 'ranges') || [])
            return `${String(readProp(fn, 'functionName'))}@${String(Math.min(...ranges.map((r) => Number(readProp(r, 'startOffset')))))}-${String(Math.max(...ranges.map((r) => Number(readProp(r, 'endOffset')))))}`
          })
      )
      // Partial writes can list a function that ran while omitting its
      // ancestors; a zero span containing a present function's span would
      // erase real credit, so it is never inserted. The ancestor's own
      // statements are carried by complete takes.
      const presentSpans = arrayOrEmpty(functions)
        .filter((f) => {
          const fRanges = readProp(f, 'ranges')
          return fRanges ? Number(readProp(fRanges, 'length')) > 0 : false
        })
        .map((f) => {
          const ranges = arrayOrEmpty(readProp(f, 'ranges') || [])
          return {
            start: Math.min(
              ...ranges.map((r) => Number(readProp(r, 'startOffset')))
            ),
            end: Math.max(
              ...ranges.map((r) => Number(readProp(r, 'endOffset')))
            )
          }
        })
      /** @type {unknown[]} */
      const added = []
      for (const [key, fn] of union) {
        if (present.has(key)) continue
        if (
          presentSpans.some(
            (p) =>
              fn.start <= p.start &&
              p.end <= fn.end &&
              (fn.start < p.start || p.end < fn.end)
          )
        )
          continue
        added.push({
          functionName: fn.name,
          isBlockCoverage: true,
          ranges: [{ startOffset: fn.start, endOffset: fn.end, count: 0 }]
        })
      }
      return added.length ? [...iterateOrEmpty(functions), ...added] : functions
    }
  )
}

/**
 * @param {{ url?: unknown, source?: unknown, coverageList?: unknown, functions?: unknown } | undefined} merged
 * @param {string} path
 */
export async function toFileCoverage(merged, path) {
  if (typeof merged?.source !== 'string')
    throw new Error('coverage conversion requires a defined source')
  if (merged.source.length === 0) {
    const lists = merged.coverageList || [merged.functions]
    for (const functions of iterateOrEmpty(lists))
      for (const fn of iterateOrEmpty(functions))
        for (const range of iterateOrEmpty(readProp(fn, 'ranges')))
          if (
            readProp(range, 'startOffset') !== 0 ||
            readProp(range, 'endOffset') !== 0
          )
            throw new Error('coverage range exceeds empty source')
    return createFileCoverage(path).data
  }
  const coverages = []
  const lists = merged.coverageList || [merged.functions]
  for (const functions of completeFunctionLists(
    arrayOrEmpty(lists).map(zeroAsBlock)
  )) {
    const converter = V8ToIstanbul(path, 0, {
      source: merged.source
    })
    await converter.load()
    converter.applyCoverage(functions)
    coverages.push(converter.toIstanbul()[path])
  }
  const map = libCoverage.createCoverageMap({})
  for (const coverage of coverages) map.merge({ [path]: coverage })
  return zeroUncalledFunctionBodies(map.fileCoverageFor(path).data)
}

// A function no load invoked can never have executed a statement or branch
// in its body. V8 compiles lazily: loads where such a function had no entry
// at all can credit its body through the enclosing range, and cross-take
// merging can keep that false credit. Zeroing body locations after the union
// removes only credit no execution could have produced, so it cannot turn
// real coverage into a false negative. Locations compare by line and
// column; a statement sharing a line with code outside the body keeps its
// own count because containment uses both.
/**
 * @typedef {{ line: number, column?: number | null }} CoveragePosition
 * @typedef {{ start: CoveragePosition, end: CoveragePosition }} CoverageSpan
 */
/** @param {CoverageSpan} outer @param {CoverageSpan} loc */
function contains(outer, loc) {
  const startCol = loc.start.column ?? 0
  const outerStartCol = outer.start.column ?? 0
  const startsInside =
    loc.start.line > outer.start.line ||
    (loc.start.line === outer.start.line && startCol >= outerStartCol)
  const endCol = loc.end.column ?? Number.MAX_SAFE_INTEGER
  const outerEndCol = outer.end.column ?? Number.MAX_SAFE_INTEGER
  const endsInside =
    loc.end.line < outer.end.line ||
    (loc.end.line === outer.end.line && endCol <= outerEndCol)
  return startsInside && endsInside
}

/** @param {import('./runtime-coverage.mjs').RuntimeCoverageData} coverage */
export function zeroUncalledFunctionBodies(coverage) {
  const out = { ...coverage, s: { ...coverage.s }, b: { ...coverage.b } }
  for (const [k, fn] of Object.entries(coverage.fnMap)) {
    if (isPositive(coverage.f[k])) continue
    for (const [sk, stmt] of Object.entries(coverage.statementMap)) {
      if (contains(fn.loc, stmt)) out.s[sk] = 0
    }
    for (const [bk, br] of Object.entries(coverage.branchMap)) {
      if (contains(fn.loc, br.loc)) out.b[bk] = out.b[bk].map(() => 0)
    }
  }
  return out
}

/**
 * @typedef {object} MeasuredCounts
 * @property {number} covered
 * @property {number} total
 */
/**
 * @typedef {object} FunctionCounts
 * @property {number} covered
 * @property {number} total
 * @property {false} [measurable]
 */
/**
 * @typedef {object} FileSummary
 * @property {MeasuredCounts} lines
 * @property {MeasuredCounts} branches
 * @property {FunctionCounts} functions
 */
// files: [{ path, coverage }] -> per-file exact counts
/**
 * @param {{ path: string, coverage: import('./runtime-coverage.mjs').RuntimeCoverageData }[]} files
 */
export function summarize(files) {
  /** @type {{ [path: string]: FileSummary | undefined }} */
  const perFile = {}
  for (const f of files) {
    const summary = createFileCoverage(f.coverage).toSummary()
    // A file whose functions are all anonymous reaches the converter with an
    // empty function map: 0/0 must read as not measurable, never as 100%.
    const functionsMeasurable = summary.functions.total > 0
    perFile[f.path] = {
      lines: { covered: summary.lines.covered, total: summary.lines.total },
      branches: {
        covered: summary.branches.covered,
        total: summary.branches.total
      },
      functions: functionsMeasurable
        ? { covered: summary.functions.covered, total: summary.functions.total }
        : { covered: 0, total: 0, measurable: false }
    }
  }
  return perFile
}
