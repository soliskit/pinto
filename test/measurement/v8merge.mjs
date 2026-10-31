// Groups V8 coverage entries by their path and checks content identity. Only
// repeated loads of the same file with identical content merge; one path
// appearing with two different contents fails the run and names the conflict.
// Range structures legitimately differ between loads of identical source -
// V8 refines block ranges as code executes - so counts are not zipped here;
// the converter accumulates every load onto the file's own structure.

export class CoverageConflict extends Error {}

// entries: [{ url, source, functions: [...] }]
// returns Map url -> { url, source, coverageList: [functions, ...] }
export function mergeV8Entries(entries) {
  const byUrl = new Map()
  for (const entry of entries) {
    if (!entry.url) continue
    const existing = byUrl.get(entry.url)
    if (!existing) {
      byUrl.set(entry.url, { url: entry.url, source: entry.source, coverageList: [entry.functions] })
      continue
    }
    // A take whose source could not be retrieved carries source undefined;
    // that is a retrieval gap, not a content signal, so it joins the file
    // without voting on identity. Two defined sources that differ still
    // fail the run, and a file with no defined source fails at conversion.
    if (existing.source === undefined) existing.source = entry.source
    else if (entry.source !== undefined && existing.source !== entry.source) {
      throw new CoverageConflict(
        `coverage conflict: ${entry.url} appeared with two different contents`
      )
    }
    existing.coverageList.push(entry.functions)
  }
  return byUrl
}

// A file on a list that never loaded counts as 0% for its pipeline: one
// zero-count range over the whole file leaves every path uncovered.
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
