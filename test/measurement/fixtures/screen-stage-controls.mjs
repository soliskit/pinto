// Executes only the exact screen CLI and a deliberate pass-through mutant.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { takeKeys } from './take-stage.mjs'
const dir = mkdtempSync(join(tmpdir(), 'pinto-screen-controls-'))
const target = fileURLToPath(new URL('./screen-stage.mjs', import.meta.url))
const marker = 'PRIVATE_SCREEN_SENTINEL_71dbe2'
const modes = ['click', 'enter']
const keys = [
  'source-match',
  'raw-helper-positive',
  'direct-line2-positive',
  'wrapper-line2-positive'
]
const originalBase =
  modes
    .flatMap((mode) => [
      mode + '=pass',
      mode + '-phase=pass',
      mode + '-child-phase=done',
      mode + '-failure=other',
      ...keys.map((key) => mode + '-' + key + '=yes')
    ])
    .join('\n') + '\n'
const metadataBase =
  modes
    .flatMap((mode) =>
      takeKeys.map(
        (suffix) =>
          mode +
          '-' +
          suffix +
          '=' +
          (['take-metadata', 'take-order'].includes(suffix) ? 'valid' : '0')
      )
    )
    .join('\n') + '\n'
const base = originalBase + metadataBase
const key = 'click-source-match='
const cases = [
  { name: 'valid', input: base, value: 'yes', code: 0 },
  {
    name: 'missing',
    input: base.replace(key + 'yes\n', ''),
    value: 'inconclusive',
    code: 1
  },
  {
    name: 'duplicate',
    input: base + key + 'yes\n',
    value: 'inconclusive',
    code: 1
  },
  ...['', 'PASS', 'yes ', ' yes', 'null', '1', marker + ' yes'].map(
    (value, i) => ({
      name: 'near-' + String(i),
      input: base.replace(key + 'yes', key + value),
      value: 'inconclusive',
      code: 1
    })
  ),
  {
    name: 'embedded',
    input: base + marker + ' source says yes pass ' + marker + '\n',
    value: 'yes',
    code: 0
  },
  {
    name: 'original-fail',
    input: base.replace('click=pass', 'click=fail'),
    value: 'yes',
    code: 1
  }
]
try {
  for (const layer of ['container', 'host']) {
    for (const item of cases) {
      const path = join(dir, layer + '-' + item.name)
      const prefix = layer === 'host' ? 'fixture-phase=fixtures-pass\n' : ''
      writeFileSync(path, prefix + item.input + marker + '\n')
      const result = spawnSync(process.execPath, [target, layer, path], {
        encoding: 'utf8',
        timeout: 1000,
        maxBuffer: 65536
      })
      const expectedLines = base
        .replace(key + 'yes', key + item.value)
        .replace(
          'click=pass',
          item.name === 'original-fail' ? 'click=fail' : 'click=pass'
        )
      const expected =
        (layer === 'host' ? 'fixture-last-phase=fixtures-pass\n' : '') +
        expectedLines
      assert.equal(result.status, item.code, item.name)
      assert.equal(result.stdout, expected, item.name)
      assert.equal(result.stderr, '', item.name)
      assert(!result.stdout.includes(marker) && !result.stderr.includes(marker))
      // Exact output check must reject raw pass-through for EVERY case.
      const raw = spawnSync(
        process.execPath,
        [
          '-e',
          'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))',
          path
        ],
        { encoding: 'utf8', timeout: 1000, maxBuffer: 65536 }
      )
      assert(
        !(
          raw.status === item.code &&
          raw.stdout === expected &&
          raw.stderr === ''
        ),
        item.name + ' rejects pass-through'
      )
    }
    const thrown = spawnSync(
      process.execPath,
      [target, layer, join(dir, marker + '-missing')],
      { encoding: 'utf8', timeout: 1000, maxBuffer: 65536 }
    )
    assert.equal(thrown.status, 1)
    assert.equal(thrown.stdout, '')
    assert.equal(thrown.stderr, '')
  }
  console.log('screen-controls=pass')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
