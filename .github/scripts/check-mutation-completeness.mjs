// Completeness gate for sliced mutation targets: the slice reports for one
// target must together contain exactly the whole file's mutants - every
// expected mutation exactly once, none missing, none duplicated, none
// unexpected. Numeric ids are per-run and meaningless, so identity is
// content-based: mutator name, replacement, start and end location, all on
// the instrumenter's own basis (0-based lines), which the dump and the
// reports share.
//
// Usage: node .github/scripts/check-mutation-completeness.mjs <target-file> <expected-dump.json> <slice-report.json>...
import { readFileSync } from 'node:fs'

const [target, expectedPath, ...reportPaths] = process.argv.slice(2)
const fail = (msg) => {
  console.error(msg)
  process.exit(1)
}

const keyOf = (m) =>
  `${m.mutatorName}|${m.start.line}:${m.start.column}-${m.end.line}:${m.end.column}|${m.replacement ?? ''}`

const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
const expectedCounts = new Map()
for (const m of expected) expectedCounts.set(keyOf(m), (expectedCounts.get(keyOf(m)) ?? 0) + 1)

const actualCounts = new Map()
let reportCount = 0
for (const path of reportPaths) {
  const report = JSON.parse(readFileSync(path, 'utf8'))
  const mutants = report.files?.[target]?.mutants
  if (!mutants) fail(`Report ${path} contains no entry for ${target}`)
  reportCount++
  for (const m of mutants) {
    const key = keyOf({
      mutatorName: m.mutatorName, replacement: m.replacement,
      start: m.location.start, end: m.location.end
    })
    actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1)
  }
}

const problems = []
for (const [key, n] of expectedCounts) {
  const got = actualCounts.get(key) ?? 0
  if (got < n) problems.push(`MISSING x${n - got}: ${key}`)
  else if (got > n) problems.push(`DUPLICATE x${got - n}: ${key}`)
}
for (const [key, n] of actualCounts) {
  if (!expectedCounts.has(key)) problems.push(`UNEXPECTED x${n}: ${key}`)
}
if (problems.length) {
  fail(`Completeness failed for ${target} across ${reportCount} slice reports (${expected.length} expected, ${[...actualCounts.values()].reduce((a, b) => a + b, 0)} reported):\n${problems.slice(0, 50).join('\n')}${problems.length > 50 ? `\n...and ${problems.length - 50} more` : ''}`)
}
console.log(`OK ${target}: ${expected.length} expected mutations each found exactly once across ${reportCount} slice reports`)
