// Converts merged V8 coverage to Istanbul file coverage with the same
// converter Tetris uses, and computes exact covered/total counts.
//
// V8 refines block ranges as code executes, so two loads of identical source
// can carry different range structures. Applying many loads to one converter
// would let those structures multiply locations. Instead each load converts
// on its own and the Istanbul maps merge: locations come from the source's
// own syntax tree, so totals stay stable across runs and reloads, and only
// counts accumulate.
import libCoverage from 'istanbul-lib-coverage'
import V8ToIstanbul from 'v8-to-istanbul'

const { createFileCoverage } = libCoverage

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
      const key = `${fn.functionName}@${start}-${end}`
      if (!union.has(key)) union.set(key, { name: fn.functionName, start, end })
    }
  }
  return coverageList.map((functions) => {
    const present = new Set(
      (functions || [])
        .filter((fn) => fn.ranges && fn.ranges.length > 0)
        .map(
          (fn) =>
            `${fn.functionName}@${Math.min(...fn.ranges.map((r) => r.startOffset))}-${Math.max(...fn.ranges.map((r) => r.endOffset))}`
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
  const coverages = []
  for (const functions of completeFunctionLists(
    merged.coverageList || [merged.functions]
  )) {
    const converter = new V8ToIstanbul(path, 0, {
      sources: { '': merged.source }
    })
    await converter.load()
    converter.applyCoverage(functions)
    coverages.push(converter.toIstanbul()[path])
  }
  return zeroUncalledFunctionBodies(coverages.reduce(maxMergeFileCoverages))
}

// A function no load invoked can never have executed a statement or branch
// in its body. V8 compiles lazily: loads where such a function had no entry
// at all credit its body through the enclosing range, and the per-location
// max-merge keeps that false credit. Zeroing body locations after the union
// removes only credit no execution could have produced, so it cannot turn
// real coverage into a false negative. Locations compare by line and
// column; a statement sharing a line with code outside the body keeps its
// own count because containment uses both.
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

function sameLocation(a, b) {
  return (
    a.start.line === b.start.line &&
    a.start.column === b.start.column &&
    a.end.line === b.end.line &&
    a.end.column === b.end.column
  )
}

// Statement maps are identical for identical source, so statement counts
// merge by key. Function and branch maps include only what a load's ranges
// reached, so their numeric keys are load-local: the same key can name a
// different function in another load. Those merge by identity - a location
// already present takes the max count; a new location is appended under a
// fresh key. A path is covered when any load executed it, and cumulative
// writes (a mid-run snapshot plus the exit write) never double-count.
export function maxMergeFileCoverages(a, b) {
  const out = {
    ...a,
    s: { ...a.s },
    f: { ...a.f },
    b: { ...a.b },
    fnMap: { ...a.fnMap },
    branchMap: { ...a.branchMap }
  }
  for (const [k, v] of Object.entries(b.s))
    out.s[k] = Math.max(out.s[k] ?? 0, v)

  let nextFn =
    Object.keys(out.fnMap).reduce((m, k) => Math.max(m, Number(k)), -1) + 1
  for (const [bk, bfn] of Object.entries(b.fnMap)) {
    const match = Object.entries(out.fnMap).find(
      ([, f]) => f.name === bfn.name && sameLocation(f.decl, bfn.decl)
    )
    if (match) {
      out.f[match[0]] = Math.max(out.f[match[0]] ?? 0, b.f[bk] ?? 0)
    } else {
      out.fnMap[String(nextFn)] = bfn
      out.f[String(nextFn)] = b.f[bk] ?? 0
      nextFn++
    }
  }

  let nextBr =
    Object.keys(out.branchMap).reduce((m, k) => Math.max(m, Number(k)), -1) + 1
  for (const [bk, bbr] of Object.entries(b.branchMap)) {
    const match = Object.entries(out.branchMap).find(
      ([, br]) => br.type === bbr.type && sameLocation(br.loc, bbr.loc)
    )
    if (match) {
      // Sub-location arrays also differ structurally across loads, so merge
      // path counts by sub-location identity, never element-wise.
      const mk = match[0]
      const locs = (out.branchMap[mk].locations || []).slice()
      const counts = (out.b[mk] || []).slice()
      const incLocs = bbr.locations || []
      const incCounts = b.b[bk] || []
      incLocs.forEach((loc, i) => {
        const j = locs.findIndex((x) => sameLocation(x, loc))
        if (j === -1) {
          locs.push(loc)
          counts.push(incCounts[i] ?? 0)
        } else {
          counts[j] = Math.max(counts[j] ?? 0, incCounts[i] ?? 0)
        }
      })
      out.branchMap[mk] = { ...out.branchMap[mk], locations: locs }
      out.b[mk] = counts
    } else {
      out.branchMap[String(nextBr)] = bbr
      out.b[String(nextBr)] = (b.b[bk] || []).slice()
      nextBr++
    }
  }
  return out
}

// files: [{ path, coverage }] -> per-file exact counts
export function summarize(files) {
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
