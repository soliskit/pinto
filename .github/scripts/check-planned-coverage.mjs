// Planned-coverage gate for the mutation matrix: for every ranged target,
// the planned shards (line range x mutator family) must cover the whole
// file's mutants exactly once, by direct enumeration with the pinned
// instrumenter - generation only, no mutation run. A mutant planned into no
// shard or into two shards fails here before any slice starts. Shards with
// no expected mutants also fail (a vacuous shard would fail its job later;
// failing here is faster and clearer). The instrumenter is not a repo
// dependency: CI installs it into a scratch prefix and passes that prefix as
// INSTRUMENTER_PREFIX.
//
// Usage: INSTRUMENTER_PREFIX=<path with node_modules> node .github/scripts/check-planned-coverage.mjs
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(`${process.env.INSTRUMENTER_PREFIX}/node_modules/x.js`)
const { createInstrumenter } = require('@stryker-mutator/instrumenter')
const { createInjector } = require('typed-inject')

const fail = (msg) => {
  console.error(msg)
  process.exit(1)
}

const logger = {
  debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {},
  isTraceEnabled: () => false, isDebugEnabled: () => false
}
const instrumenter = createInstrumenter(createInjector().provideValue('logger', logger))

const matrix = JSON.parse(readFileSync('.github/mutation-ranges.json', 'utf8'))
const targets = [...new Set(matrix.include.filter((s) => s.mutate.includes(':')).map((s) => s.target))]

const keyOf = (m) =>
  `${m.mutatorName}|${m.start.line}:${m.start.column}-${m.end.line}:${m.end.column}|${m.replacement ?? ''}`
const oneBased = (p) => ({ line: p.line + 1, column: p.column + 1 })

for (const target of targets) {
  const shards = matrix.include.filter((s) => s.target === target)
  const file = shards[0].mutate.split(':')[0]
  if (shards.some((s) => s.mutate.split(':')[0] !== file)) fail(`Target ${target} maps to more than one file`)
  const content = readFileSync(file, 'utf8')
  const result = await instrumenter.instrument([{ name: file, mutate: true, content }], {
    mutate: [file], reporters: [], testRunner: 'command', plugins: [], allowEmpty: true,
    ignorers: [], excludedMutations: [], mutator: { name: 'DEFAULT', plugins: null, excludedMutations: [] }
  })
  const all = result.mutants.map((m) => ({
    mutatorName: m.mutatorName, replacement: m.replacement,
    start: oneBased(m.location.start), end: oneBased(m.location.end)
  }))
  const knownMutators = new Set(all.map((m) => m.mutatorName))

  const covered = new Map()
  for (const shard of shards) {
    const [a, b] = shard.mutate.split(':')[1].split('-').map(Number)
    for (const name of shard.mutators ?? []) {
      if (!knownMutators.has(name)) fail(`Shard ${shard.shard} names unknown mutator "${name}"`)
    }
    const expected = all.filter(
      (m) => m.start.line >= a && m.end.line <= b && (!shard.mutators || shard.mutators.includes(m.mutatorName))
    )
    if (expected.length === 0) fail(`Shard ${shard.shard} expects 0 mutants (vacuous shard)`)
    for (const m of expected) covered.set(keyOf(m), (covered.get(keyOf(m)) ?? 0) + 1)
  }

  const problems = []
  for (const m of all) {
    const n = covered.get(keyOf(m)) ?? 0
    if (n === 0) problems.push(`MISSING: ${keyOf(m)}`)
    else if (n > 1) problems.push(`DUPLICATE x${n}: ${keyOf(m)}`)
  }
  if (problems.length) {
    fail(`Planned coverage failed for ${file} (${all.length} mutants, ${shards.length} shards):\n${problems.slice(0, 50).join('\n')}${problems.length > 50 ? `\n...and ${problems.length - 50} more` : ''}`)
  }
  console.log(`OK ${file}: ${all.length} mutants covered exactly once across ${shards.length} shards`)
}
