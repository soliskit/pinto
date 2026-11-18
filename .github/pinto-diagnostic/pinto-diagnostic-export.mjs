import assert from 'node:assert/strict'
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { atomic, binding, FILES } from './pinto-diagnostic-reporter.mjs'

export function validate(x, env) {
  const keys = (v, names) => {
    assert(v && typeof v === 'object' && !Array.isArray(v))
    assert.deepEqual(Object.keys(v).sort(), names.sort())
  }
  keys(x, ['schema', 'target', 'role', 'run', 'attempt', 'outcome', 'detail'])
  assert.equal(x.schema, 1)
  assert.equal(x.outcome, 'failure')
  for (const [k, v] of Object.entries(binding(env))) assert.equal(x[k], v)
  const d = x.detail
  keys(d, [
    'testId',
    'category',
    'code',
    'outerCode',
    'frame',
    'expectedPresent',
    'actualPresent',
    'expected',
    'actual'
  ])
  assert(['target', 'other'].includes(d.testId))
  assert(
    [
      'Error',
      'AssertionError',
      'TimeoutError',
      'TypeError',
      'RangeError',
      'unknown'
    ].includes(d.category)
  )
  for (const k of ['code', 'outerCode'])
    assert(
      [
        'ERR_ASSERTION',
        'ERR_TEST_FAILURE',
        'ERR_TEST_TIMEOUT',
        'unknown'
      ].includes(d[k])
    )
  for (const k of ['expectedPresent', 'actualPresent'])
    assert.equal(typeof d[k], 'boolean')
  keys(d.frame, ['file', 'line', 'column', 'unknown', 'native'])
  assert.equal(typeof d.frame.native, 'boolean')
  assert.equal(typeof d.frame.unknown, 'boolean')
  if (d.frame.unknown) {
    assert.equal(d.frame.file, null)
    assert.equal(d.frame.line, null)
    assert.equal(d.frame.column, null)
  } else {
    assert(FILES.includes(d.frame.file))
    for (const k of ['line', 'column'])
      assert(
        Number.isSafeInteger(d.frame[k]) &&
          d.frame[k] > 0 &&
          d.frame[k] <= 1000000
      )
  }
  for (const k of ['expected', 'actual']) {
    const p = d[k]
    keys(p, ['type', 'value', 'length', 'redacted'])
    assert(
      [
        'null',
        'undefined',
        'boolean',
        'number',
        'string',
        'bigint',
        'symbol',
        'function',
        'object'
      ].includes(p.type)
    )
    assert.equal(typeof p.redacted, 'boolean')
    assert(
      p.value === null ||
        typeof p.value === 'boolean' ||
        (Number.isSafeInteger(p.value) && Math.abs(p.value) <= 1000000)
    )
    if (p.type === 'string') {
      assert(p.redacted)
      assert.equal(p.value, null)
      assert(Number.isInteger(p.length) && p.length >= 0 && p.length <= 65535)
    } else assert.equal(p.length, null)
    if (p.type === 'null') {
      assert.equal(p.value, null)
      assert.equal(p.redacted, false)
    } else if (p.type === 'boolean') {
      assert.equal(typeof p.value, 'boolean')
      assert.equal(p.redacted, false)
    } else if (p.type === 'number' && !p.redacted)
      assert.equal(typeof p.value, 'number')
    else {
      assert.equal(p.value, null)
      assert(p.redacted)
    }
  }
  return x
}
export function exportSummary(dir, out, env, facts) {
  binding(env)
  const st = lstatSync(dir)
  assert(st.isDirectory() && !st.isSymbolicLink())
  const names = readdirSync(dir)
  assert(names.length <= 1)
  assert(names.every((x) => x === 'failure.json'))
  let captureResult = null
  if (names.length) {
    const file = join(dir, 'failure.json'),
      s = lstatSync(file)
    assert(s.isFile() && !s.isSymbolicLink() && s.size <= 8192)
    captureResult = validate(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file))
      ),
      env
    )
  }
  assert(
    [
      'all-passed',
      'failure',
      'capture-refused',
      'setup-failed',
      'interrupted',
      'drift-refused',
      'zero-cost-refused'
    ].includes(facts.outcome)
  )
  assert.equal(typeof facts.cleanupConfirmed, 'boolean')
  assert(
    Number.isInteger(facts.exitCode) &&
      facts.exitCode >= 0 &&
      facts.exitCode <= 255
  )
  if (facts.outcome === 'all-passed') {
    assert.equal(facts.exitCode, 0)
    assert.equal(captureResult, null)
    assert(facts.cleanupConfirmed)
  }
  if (facts.outcome === 'failure') {
    assert.notEqual(facts.exitCode, 0)
    assert(captureResult)
  }
  const result = {
    schema: 1,
    ...binding(env),
    ...facts,
    failure: captureResult?.detail ?? null
  }
  atomic(out, result)
  return result
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [dir, out, outcome, exitCode, cleanup] = process.argv.slice(2)
  try {
    exportSummary(dir, out, process.env, {
      outcome,
      exitCode: Number(exitCode),
      cleanupConfirmed: cleanup === 'true'
    })
  } catch {
    try {
      atomic(out, {
        schema: 1,
        ...binding(process.env),
        outcome: 'capture-refused',
        exitCode: 2,
        cleanupConfirmed: false,
        failure: null
      })
    } catch {
      /* A refused destination remains missing and cannot pass the upload step. */
    }
    process.exitCode = 2
  }
}
