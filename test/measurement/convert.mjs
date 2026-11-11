// Converts each V8 take separately, then merges its reported locations with
// the Istanbul library used by Tetris's browser reporter. Matching counts
// add; unmatched locations can inherit hits from a containing location in
// another take. These are observed-range totals, not a fixed syntax inventory
// or exact invocation counts. Mixed function/block granularity retains the
// library's containing-range interpretation.
import libCoverage from 'istanbul-lib-coverage'
import V8ToIstanbul from 'v8-to-istanbul'

const { createFileCoverage } = libCoverage

// A function-only zero is not evidence for any location inside that function.
// Give the library a zero root branch so it cannot inherit outer-block hits
// past this uncalled function. Positive function-only samples stay unchanged.
const zeroAsBlock = (functions) =>
  (functions || []).map((fn) =>
    !fn.isBlockCoverage && fn.ranges?.length === 1 && fn.ranges[0].count === 0
      ? { ...fn, isBlockCoverage: true }
      : fn
  )

// merged: { url, source, coverageList: [functions, ...] } ; path for the report
// V8 lists a function only once it is compiled, so a load where a function
// never compiled has no entry for it, and converting that load credits the
// function's body through the enclosing range. Absent means never compiled,
// which means never run: completing each load with zero-count spans for the
// functions other loads of the same source observed removes only credit no
// execution could have produced. This happens at the V8 level because the
// converter's own function map drops anonymous functions entirely.
export function completeFunctionLists(coverageList) {
  const union = new Map()
  for (const functions of coverageList) {
    for (const fn of functions || []) {
      if (!fn.ranges || fn.ranges.length === 0) continue
      const start = Math.min(...fn.ranges.map((r) => r.startOffset))
      const end = Math.max(...fn.ranges.map((r) => r.endOffset))
      const key = `${fn.functionName}@${String(start)}-${String(end)}`
      if (!union.has(key)) union.set(key, { name: fn.functionName, start, end })
    }
  }
  return coverageList.map((functions) => {
    const present = new Set(
      (functions || [])
        .filter((fn) => fn.ranges && fn.ranges.length > 0)
        .map(
          (fn) =>
            `${fn.functionName}@${String(Math.min(...fn.ranges.map((r) => r.startOffset)))}-${String(Math.max(...fn.ranges.map((r) => r.endOffset)))}`
        )
    )
    // Partial writes can list a function that ran while omitting its
    // ancestors; a zero span containing a present function's span would
    // erase real credit, so it is never inserted. The ancestor's own
    // statements are carried by complete takes.
    const presentSpans = (functions || [])
      .filter((f) => f.ranges && f.ranges.length > 0)
      .map((f) => ({
        start: Math.min(...f.ranges.map((r) => r.startOffset)),
        end: Math.max(...f.ranges.map((r) => r.endOffset))
      }))
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
    return added.length ? [...(functions || []), ...added] : functions
  })
}

export async function toFileCoverage(merged, path) {
  if (typeof merged?.source !== 'string')
    throw new Error('coverage conversion requires a defined source')
  if (merged.source.length === 0) {
    const lists = merged.coverageList || [merged.functions]
    for (const functions of lists)
      for (const fn of functions || [])
        for (const range of fn.ranges || [])
          if (range.startOffset !== 0 || range.endOffset !== 0)
            throw new Error('coverage range exceeds empty source')
    return createFileCoverage(path).data
  }
  const coverages = []
  const lists = merged.coverageList || [merged.functions]
  for (const functions of completeFunctionLists(lists.map(zeroAsBlock))) {
    const converter = new V8ToIstanbul(path, 0, {
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

/** @param {import('istanbul-lib-coverage').FileCoverageData} coverage */
export function zeroUncalledFunctionBodies(coverage) {
  const out = { ...coverage, s: { ...coverage.s }, b: { ...coverage.b } }
  for (const [k, fn] of Object.entries(coverage.fnMap)) {
    if (coverage.f[k] > 0) continue
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
 * @param {{ path: string, coverage: import('istanbul-lib-coverage').FileCoverageData }[]} files
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
