// Write the Stryker config for one mutator-family shard: the shard's line
// range is passed on the command line as usual, and this config excludes
// every mutator family the instrumenter generates on the mutated file
// except the shard's own, so the shard runs exactly its family's mutants.
// Range-contained families are not enough: a family whose base mutants
// span the range edge stays unexcluded otherwise, and exclusion changes
// generation, so its mutants would run inside this shard too. (Stryker's
// mutator option has no command-line flag, so the exclusion list travels
// in a config file; command line options still apply and take precedence.)
// The exclusion list is derived from the pinned instrumenter's enumeration
// of the whole file, never hand-maintained. The instrumenter is not a repo
// dependency: CI installs it into a scratch prefix and passes that prefix
// as INSTRUMENTER_PREFIX.
//
// Usage: INSTRUMENTER_PREFIX=<path with node_modules> node .github/scripts/write-shard-config.mjs <shard> <out.json>
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'

const require = createRequire(`${process.env.INSTRUMENTER_PREFIX}/node_modules/x.js`)
const { createInstrumenter } = require('@stryker-mutator/instrumenter')
const { createInjector } = require('typed-inject')

const [shardName, out] = process.argv.slice(2)
const fail = (msg) => {
  console.error(msg)
  process.exit(1)
}

const matrix = JSON.parse(readFileSync('.github/mutation-ranges.json', 'utf8'))
const shard = matrix.include.find((s) => s.shard === shardName)
if (!shard) fail(`Unknown shard "${shardName}"`)
if (!shard.mutators) fail(`Shard ${shardName} has no mutators list; it needs no shard config`)
const [file, range] = shard.mutate.split(':')
if (!range) fail(`Shard ${shardName} has no line range`)

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
const present = new Set(result.mutants.map((m) => m.mutatorName))
const included = new Set(shard.mutators)
for (const name of included) {
  if (!present.has(name)) fail(`Shard ${shardName} names mutator "${name}" with no mutants in ${file}`)
}
const excludedMutations = [...present].filter((name) => !included.has(name)).sort()
writeFileSync(out, `${JSON.stringify({ mutator: { excludedMutations } }, null, 2)}\n`)
console.log(`${shardName}: excluding ${excludedMutations.length} families (${excludedMutations.join(', ') || 'none'}); keeping ${[...included].join(', ')}`)
