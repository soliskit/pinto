// Dump the full mutant list for one file, as content identities, using the
// pinned @stryker-mutator/instrumenter. The instrumenter is not a repo
// dependency: CI installs it into a scratch prefix and passes that prefix as
// INSTRUMENTER_PREFIX; numeric ids are per-run and meaningless, so the dump
// keeps only content identity: mutator name, replacement, and location.
// The instrumenter's raw locations are 0-based while the JSON reports are
// 1-based (lines and columns), so this dump normalizes to the report basis
// (+1) and the completeness check compares like with like.
//
// Usage: INSTRUMENTER_PREFIX=<path with node_modules> node .github/scripts/dump-mutants.mjs <file> <out.json>
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'

const [file, out] = process.argv.slice(2)
const require = createRequire(`${process.env.INSTRUMENTER_PREFIX}/node_modules/x.js`)
const { createInstrumenter } = require('@stryker-mutator/instrumenter')
const { createInjector } = require('typed-inject')

const logger = {
  debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {},
  isTraceEnabled: () => false, isDebugEnabled: () => false
}
const instrumenter = createInstrumenter(createInjector().provideValue('logger', logger))
const content = readFileSync(file, 'utf8')
const result = await instrumenter.instrument([{ name: file, mutate: true, content }], {
  mutate: [file], reporters: [], testRunner: 'command', plugins: [], allowEmpty: true,
  ignorers: [], excludedMutations: [], mutator: { name: 'DEFAULT', plugins: null, excludedMutations: [] }
})
const oneBased = (p) => ({ line: p.line + 1, column: p.column + 1 })
writeFileSync(out, JSON.stringify(result.mutants.map((m) => ({
  mutatorName: m.mutatorName, replacement: m.replacement,
  start: oneBased(m.location.start), end: oneBased(m.location.end)
}))))
console.log(`${file}: ${result.mutants.length} mutants dumped`)
