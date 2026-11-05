// Atomic finite output: raw input and caught error text are never returned.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { takeKeys } from './take-stage.mjs'
const modes = ['click', 'enter']
const diagnostics = [
  'source-match',
  'raw-helper-positive',
  'direct-line2-positive',
  'wrapper-line2-positive'
]
const values = {
  '': ['pass', 'fail'],
  '-phase': [
    'pass',
    'setup',
    'child',
    'capture-validation',
    'capture-present',
    'merge',
    'convert',
    'credit-line-2',
    'credit-line-5',
    'credit-line-6',
    'credit-line-7',
    'credit-function'
  ],
  '-child-phase': [
    'setup',
    'browser-launch',
    'page-create',
    'goto',
    'action',
    'destination',
    'page-close',
    'browser-close',
    'server-close',
    'done',
    'unavailable'
  ],
  '-failure': [
    'other',
    'child-deadline',
    'child-possible-timeout',
    'spawn-missing',
    'child-failed'
  ]
}
const phases = [
  'container-start',
  'node-failed',
  'install-failed',
  'version-failed',
  'timeout-missing',
  'fixtures-start',
  'controls-failed',
  'summary-failed',
  'fixtures-pass',
  'fixtures-timeout',
  'fixtures-failed'
]
function one(lines, key, allowed, fallback) {
  const hits = lines.filter((line) => line.startsWith(key))
  const value = hits.length === 1 ? hits[0].slice(key.length) : fallback
  return allowed.includes(value) ? value : fallback
}
export function screen(text, layer) {
  if (typeof text !== 'string' || !['container', 'host'].includes(layer))
    throw new Error('screen input invalid')
  const lines = text.split(/\r?\n/)
  const output = []
  let valid = true
  if (layer === 'host') {
    const found = lines.filter(
      (line) =>
        line.startsWith('fixture-phase=') && phases.includes(line.slice(14))
    )
    const last = found.length ? found.at(-1).slice(14) : 'unavailable'
    output.push('fixture-last-phase=' + last)
    if (last !== 'fixtures-pass') valid = false
  }
  for (const mode of modes) {
    for (const [suffix, allowed] of Object.entries(values)) {
      const key = mode + suffix + '='
      const value = one(lines, key, allowed, 'unavailable')
      output.push(key + value)
      if ((suffix === '' || suffix === '-phase') && value !== 'pass')
        valid = false
    }
    for (const diagnostic of diagnostics) {
      const key = mode + '-' + diagnostic + '='
      const value = one(
        lines,
        key,
        ['yes', 'no', 'inconclusive'],
        'inconclusive'
      )
      output.push(key + value)
      if (value === 'inconclusive') valid = false
    }
  }
  // All metadata keys are finite and screen through both real layers.
  for (const mode of modes)
    for (const suffix of takeKeys) {
      const key = mode + '-' + suffix + '='
      const allowed = ['take-metadata', 'take-order'].includes(suffix)
        ? ['valid', 'inconclusive']
        : ['0', '1', '2plus', 'inconclusive']
      const value = one(lines, key, allowed, 'inconclusive')
      output.push(key + value)
      if (value === 'inconclusive') valid = false
    }
  return { stdout: output.join('\n') + '\n', code: valid ? 0 : 1 }
}
// The CLI is used by both real workflow screen layers.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = screen(
      readFileSync(process.argv[3], 'utf8'),
      process.argv[2]
    )
    process.stdout.write(result.stdout)
    process.exitCode = result.code
  } catch {
    // No partial output was written before all input and output were checked.
    process.exitCode = 1
  }
}
