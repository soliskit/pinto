// Exercise the actual shared screen on every finite new key/token combination.
import assert from 'node:assert/strict'
import { screen } from './screen-stage.mjs'
import { takeKeys } from './take-stage.mjs'
const modes = ['click', 'enter']
const diagnostics = [
  'source-match',
  'raw-helper-positive',
  'direct-line2-positive',
  'wrapper-line2-positive'
]
const originals = modes.flatMap((mode) => [
  mode + '=pass',
  mode + '-phase=pass',
  mode + '-child-phase=done',
  mode + '-failure=other',
  ...diagnostics.map((key) => mode + '-' + key + '=yes')
])
const metadata = modes.flatMap((mode) =>
  takeKeys.map(
    (key) =>
      mode +
      '-' +
      key +
      '=' +
      (['take-metadata', 'take-order'].includes(key) ? 'valid' : '0')
  )
)
const base = [...originals, ...metadata].join('\n') + '\n'
const marker = 'PRIVATE_TAKE_SCREEN_SENTINEL_5062'
for (const layer of ['container', 'host']) {
  const prefix = layer === 'host' ? 'fixture-phase=fixtures-pass\n' : ''
  const outputPrefix =
    layer === 'host' ? 'fixture-last-phase=fixtures-pass\n' : ''
  for (const mode of modes)
    for (const suffix of takeKeys) {
      const key = mode + '-' + suffix + '='
      const status = ['take-metadata', 'take-order'].includes(suffix)
      const initial = status ? 'valid' : '0'
      const allowed = status
        ? ['valid', 'inconclusive']
        : ['0', '1', '2plus', 'inconclusive']
      const line = key + initial + '\n'
      for (const value of allowed) {
        const changed = base.replace(line, key + value + '\n')
        const actual = screen(prefix + changed + marker + '\n', layer)
        assert.deepEqual(actual, {
          stdout: outputPrefix + changed,
          code: value === 'inconclusive' ? 1 : 0
        })
        assert(!actual.stdout.includes(marker))
      }
      for (const value of [
        '',
        'VALID',
        'valid ',
        ' 0',
        'null',
        'undefined',
        '2',
        '3',
        marker,
        initial + marker
      ]) {
        const input = base.replace(line, key + value + '\n')
        assert.deepEqual(screen(prefix + input + marker + '\n', layer), {
          stdout: outputPrefix + base.replace(line, key + 'inconclusive\n'),
          code: 1
        })
      }
      for (const input of [base.replace(line, ''), base + line]) {
        assert.deepEqual(screen(prefix + input + marker + '\n', layer), {
          stdout: outputPrefix + base.replace(line, key + 'inconclusive\n'),
          code: 1
        })
      }
    }
  // Unknown tokens never pass through; original failure is never upgraded.
  assert.deepEqual(
    screen(prefix + base + 'click-take-unknown=' + marker + '\n', layer),
    {
      stdout: outputPrefix + base,
      code: 0
    }
  )
  assert.equal(
    screen(prefix + base.replace('enter=pass', 'enter=fail'), layer).code,
    1
  )
}
console.log('take-screen-controls=pass')
