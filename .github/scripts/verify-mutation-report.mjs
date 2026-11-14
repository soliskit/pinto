// In-job mutation evidence check for one shard. After Stryker exits, this
// enumerates the mutants expected in the shard's range (and mutator family,
// when the shard carries one) with the pinned instrumenter and compares them
// against the report produced in this job. The enumeration applies the
// shard's own mutator exclusions: Stryker's instrumenter generates
// additional mutants when families are excluded, so expectations must be
// built with the same exclusions the run used. A missing report, a missing,
// unexpected or duplicated mutant, an unrecognized mutant status, a vacuous
// shard or a shard with no test-killed mutant fails the job. Excluded-family
// mutants appear in the report with status "Ignored" (enumerated, not run);
// they must be exactly the mutants outside the shard's family, and any
// terminal status on one of them fails the job. Status counts and survivor
// identities are appended to the job summary and printed to the log. The
// instrumenter is not a repo dependency: CI installs it into a scratch
// prefix and passes that prefix as INSTRUMENTER_PREFIX.
//
// Usage: INSTRUMENTER_PREFIX=<path with node_modules> node .github/scripts/verify-mutation-report.mjs <shard>
import { createRequire } from 'node:module'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const require = createRequire(`${process.env.INSTRUMENTER_PREFIX}/node_modules/x.js`)
const { createInstrumenter } = require('@stryker-mutator/instrumenter')
const { createInjector } = require('typed-inject')

const [shardName] = process.argv.slice(2)
const fail = (msg) => {
  console.error(msg)
  process.exit(1)
}

const matrix = JSON.parse(readFileSync('.github/mutation-ranges.json', 'utf8'))
const shard = matrix.include.find((s) => s.shard === shardName)
if (!shard) fail(`Unknown shard "${shardName}"`)
const [file, range] = shard.mutate.split(':')
let rangeStart = 1
let rangeEnd = Infinity
if (range) {
  const m = /^(\d+)-(\d+)$/.exec(range)
  if (!m) fail(`Bad range "${range}" in shard ${shardName}`)
  rangeStart = Number(m[1])
  rangeEnd = Number(m[2])
}
const inRange = (m) => m.start.line >= rangeStart && m.end.line <= rangeEnd

const logger = {
  debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {},
  isTraceEnabled: () => false, isDebugEnabled: () => false
}
const instrumenter = createInstrumenter(createInjector().provideValue('logger', logger))
const content = readFileSync(file, 'utf8')
const enumerate = (excludedMutations) =>
  instrumenter.instrument([{ name: file, mutate: true, content }], {
    mutate: [file], reporters: [], testRunner: 'command', plugins: [], allowEmpty: true,
    ignorers: [], excludedMutations, mutator: { name: 'DEFAULT', plugins: null, excludedMutations }
  })
// The instrumenter's raw locations are 0-based while the json report is
// 1-based (lines and columns), so identities are normalized to the report
// basis (+1), matching dump-mutants.mjs.
const keyOf = (m) =>
  `${m.mutatorName}|${m.start.line}:${m.start.column}-${m.end.line}:${m.end.column}|${m.replacement ?? ''}`
const oneBased = (p) => ({ line: p.line + 1, column: p.column + 1 })
const normalize = (result) =>
  result.mutants
    .map((m) => ({ mutatorName: m.mutatorName, replacement: m.replacement, start: oneBased(m.location.start), end: oneBased(m.location.end) }))
    .filter(inRange)

// Expectations must match what the run instruments: when the shard carries a
// mutator family, enumerate with the shard's own exclusions (every other
// family the instrumenter generates on the file), exactly as the shard's
// generated config does. Range-contained families are not enough: a family
// whose base mutants span the range edge stays unexcluded otherwise, and
// exclusion changes generation, so its mutants would run inside the range.
const baseResult = await enumerate([])
const baseInRange = normalize(baseResult)
const knownMutators = new Set(baseResult.mutants.map((m) => m.mutatorName))
let expected = baseInRange
if (shard.mutators) {
  const excluded = [...knownMutators].filter((name) => !shard.mutators.includes(name)).sort()
  expected = normalize(await enumerate(excluded))
}

const reportPath = 'reports/mutation/mutation.json'
if (!existsSync(reportPath)) fail(`Missing report: ${reportPath} was not produced in this job`)
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const actual = report.files?.[file]?.mutants
if (!actual) fail(`Report contains no entry for ${file}`)

const KNOWN_STATUSES = new Set(['Killed', 'Survived', 'Timeout', 'NoCoverage', 'CompileError', 'RuntimeError'])
const statusProblem = (m) => {
  const ignoredExpected = shard.mutators && !shard.mutators.includes(m.mutatorName)
  if (ignoredExpected) return m.status === 'Ignored' ? null : `excluded mutator ${m.mutatorName} at ${m.location.start.line} ran with status "${m.status}"`
  return KNOWN_STATUSES.has(m.status) ? null : `${m.mutatorName} at ${m.location.start.line}: status "${m.status}"`
}
const expectedCounts = new Map()
for (const m of expected) expectedCounts.set(keyOf(m), (expectedCounts.get(keyOf(m)) ?? 0) + 1)
const actualCounts = new Map()
const statusProblems = []
for (const m of actual) {
  const problem = statusProblem(m)
  if (problem) statusProblems.push(problem)
  const key = keyOf({ mutatorName: m.mutatorName, replacement: m.replacement, start: m.location.start, end: m.location.end })
  actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1)
}
if (statusProblems.length) fail(`Unrecognized mutant status in ${shardName}:\n${statusProblems.join('\n')}`)

const problems = []
for (const [key, n] of expectedCounts) {
  const got = actualCounts.get(key) ?? 0
  if (got < n) problems.push(`MISSING x${n - got}: ${key}`)
  else if (got > n) problems.push(`DUPLICATE x${got - n}: ${key}`)
}
for (const [key, n] of actualCounts) {
  if (!expectedCounts.has(key)) problems.push(`UNEXPECTED x${n}: ${key}`)
}
if (actual.length === 0) fail(`Vacuous slice: ${shardName} report lists 0 mutants`)
if (problems.length) {
  fail(`Report does not match expected mutants for ${shardName} (${expected.length} expected, ${actual.length} reported):\n${problems.slice(0, 50).join('\n')}${problems.length > 50 ? `\n...and ${problems.length - 50} more` : ''}`)
}
const ran = actual.filter((m) => m.status !== 'Ignored')
if (ran.length === 0) fail(`Vacuous slice: ${shardName} report lists ${actual.length} mutants, none run`)
const killed = ran.filter((m) => m.status === 'Killed').length
if (killed === 0) fail(`Zero-kill slice: ${ran.length} mutants run, none killed by a failing test - rollout stops`)

const counts = {}
for (const m of actual) counts[m.status] = (counts[m.status] ?? 0) + 1
const survivors = ran.filter((m) => m.status === 'Survived' || m.status === 'NoCoverage')
const lines = [
  `### ${shardName}: ${ran.length} mutants run, ${killed} killed`,
  '',
  '| Status | Count |',
  '| --- | ---: |',
  ...Object.entries(counts).map(([s, n]) => `| ${s} | ${n} |`),
  '',
  survivors.length
    ? `Surviving mutants: ${survivors.map((m) => `${m.mutatorName} at ${m.location.start.line}:${m.location.start.column}`).join('; ')}`
    : 'No surviving mutants.',
  ''
]
const summary = lines.join('\n')
console.log(summary)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
