import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  atomic,
  binding,
  capture,
  reporter
} from './pinto-diagnostic-reporter.mjs'
import { exportSummary, validate } from './pinto-diagnostic-export.mjs'
const env = {
  DIAGNOSTIC_TARGET: '5bce64236564b992ad66574afeb3b0033f3d286b',
  DIAGNOSTIC_ROLE: 'dependency',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1'
}
const secret =
  'SYNTHETIC_SECRET_TOKEN_https://example.invalid/?auth=forged_/home/private/process.env'
function data(error = {}) {
  return {
    name: 'local Leave retires a closed call before a later room-loss notice',
    file: '/tmp/sandbox/test/room.test.ts',
    line: 2799,
    column: 1,
    details: { error: { code: 'ERR_TEST_FAILURE', cause: error } }
  }
}
function record(d) {
  return { schema: 1, ...binding(env), outcome: 'failure', detail: capture(d) }
}
function temp() {
  return mkdtempSync(join(tmpdir(), 'pinto-privacy-'))
}
async function* events(xs) {
  yield* xs
}

test('native assertion preserves category/types/line without string content', () => {
  const x = record(
    data({
      name: 'AssertionError',
      code: 'ERR_ASSERTION',
      expected: null,
      actual: secret,
      message: secret,
      stack:
        'AssertionError: ' +
        secret +
        '\n    at TestContext.<anonymous> (/tmp/sandbox/test/room.test.ts:2819:10)'
    })
  )
  validate(x, env)
  assert.equal(x.detail.frame.line, 2819)
  assert.equal(x.detail.frame.native, true)
  assert.equal(x.detail.expected.type, 'null')
  assert.equal(x.detail.actual.type, 'string')
  assert(!JSON.stringify(x).includes(secret))
})
test('earlier evaluation failure returns category and earlier frame', () => {
  const x = record(
    data({
      name: 'Error',
      stack:
        'Error: ' + secret + '\n    at /tmp/sandbox/test/room.test.ts:2807:12'
    })
  )
  validate(x, env)
  assert.equal(x.detail.frame.line, 2807)
  assert.equal(x.detail.category, 'Error')
})
test('unknown names codes paths messages remain private', () => {
  const x = record({
    name: secret,
    file: secret,
    line: 3,
    column: 2,
    details: {
      error: { name: secret, code: secret, stack: secret, message: secret }
    }
  })
  validate(x, env)
  assert.equal(x.detail.testId, 'other')
  assert.equal(x.detail.frame.unknown, true)
  assert(!JSON.stringify(x).includes(secret))
})
test('nested causes bounded and arbitrary object values never traversed', () => {
  const cyclic = {}
  cyclic.self = cyclic
  const x = record(
    data({ name: 'Error', expected: cyclic, actual: { secret } })
  )
  validate(x, env)
  assert.equal(x.detail.actual.type, 'object')
  assert(!JSON.stringify(x).includes(secret))
})
test('getters for error values never invoked', () => {
  let invoked = false
  const x = { name: 'Error' }
  Object.defineProperty(x, 'actual', {
    get() {
      invoked = true
      throw Error(secret)
    }
  })
  validate(record(data(x)), env)
  assert.equal(invoked, false)
})
test('oversized stack and unusual primitive values redacted', () => {
  for (const value of [
    NaN,
    Infinity,
    1000001,
    1n,
    Symbol(secret),
    () => secret,
    secret.repeat(1000)
  ]) {
    const x = record(
      data({
        name: 'Error',
        expected: value,
        actual: value,
        stack: secret.repeat(1000)
      })
    )
    validate(x, env)
    assert(x.detail.actual.redacted)
    assert(!JSON.stringify(x).includes(secret))
  }
})
test('safe bounded primitives retained', () => {
  for (const value of [null, true, false, 0, -1, 1000000])
    validate(
      record(data({ code: 'ERR_ASSERTION', expected: value, actual: value })),
      env
    )
})
test('missing native error is explicit unknown', () => {
  const x = record({})
  validate(x, env)
  assert(x.detail.frame.unknown)
  assert.equal(x.detail.category, 'unknown')
  assert.equal(x.detail.actualPresent, false)
})
test('unbound foreign target or role refused', () => {
  for (const changed of [
    { DIAGNOSTIC_TARGET: secret },
    { DIAGNOSTIC_ROLE: secret },
    { GITHUB_RUN_ID: secret }
  ])
    assert.throws(() => binding({ ...env, ...changed }))
  const x = record(data())
  assert.throws(() =>
    validate(x, { ...env, DIAGNOSTIC_TARGET: '0'.repeat(40) })
  )
})
test('forged schema fields enums values and oversize location rejected', () => {
  for (const change of [
    (x) => (x.extra = secret),
    (x) => (x.detail.category = secret),
    (x) => (x.detail.actual.value = secret),
    (x) => (x.detail.frame.line = 1000001),
    (x) => (x.detail.actual.extra = secret)
  ]) {
    const x = record(data())
    change(x)
    assert.throws(() => validate(x, env))
  }
})
test('synchronous capture precedes existing first-fail protocol', async () => {
  const order = []
  for await (const unused of reporter(
    events([{ type: 'test:fail', data: data({ code: 'ERR_ASSERTION' }) }]),
    {
      env,
      say: (x) => order.push(x.startsWith('READY') ? 'ready' : 'fatal'),
      persist: (x) => {
        validate(x, env)
        order.push('capture')
      }
    }
  ))
    void unused
  assert.deepEqual(order, ['ready', 'capture', 'fatal'])
})
test('capture refusal still emits fatal, never passes', async () => {
  const output = []
  for await (const unused of reporter(
    events([{ type: 'test:fail', data: data() }]),
    {
      env,
      say: (x) => output.push(x),
      persist: () => {
        throw Error(secret)
      }
    }
  ))
    void unused
  assert(output.some((x) => x.startsWith('FIRST-FAIL ')))
  assert(!output.join('').includes(secret))
})
test('todo and skip presence preserve exact production predicate', async () => {
  let captured = 0
  const xs = [
    { type: 'test:fail', data: { todo: false } },
    { type: 'test:fail', data: { skip: false } },
    { type: 'test:pass', data: {} }
  ]
  for await (const unused of reporter(events(xs), {
    env,
    say: () => {},
    persist: () => captured++
  }))
    void unused
  assert.equal(captured, 0)
})
test('no failure produces no fabricated detail', async () => {
  let captured = false
  for await (const unused of reporter(
    events([{ type: 'test:pass', data: {} }]),
    { env, say: () => {}, persist: () => (captured = true) }
  ))
    void unused
  assert.equal(captured, false)
})
test('atomic capture writes complete fixed JSON', () => {
  const root = temp(),
    path = join(root, 'capture/failure.json')
  const x = record(data())
  atomic(path, x)
  assert.deepEqual(JSON.parse(readFileSync(path)), x)
})
test('symlink capture directory refuses atomic write', () => {
  const root = temp()
  mkdirSync(join(root, 'real'))
  symlinkSync(join(root, 'real'), join(root, 'capture'))
  assert.throws(() =>
    atomic(join(root, 'capture/failure.json'), record(data()))
  )
})
test('export only fixed schema and bound result, no raw ledger', () => {
  const root = temp(),
    dir = join(root, 'capture')
  mkdirSync(dir)
  atomic(join(dir, 'failure.json'), record(data({ actual: secret })))
  const x = exportSummary(dir, join(root, 'export/summary.json'), env, {
    outcome: 'failure',
    exitCode: 1,
    cleanupConfirmed: true
  })
  assert(!JSON.stringify(x).includes(secret))
  assert.equal(x.outcome, 'failure')
})
test('export refuses symlinks unknown tree malformed UTF8 oversized bytes JSON', () => {
  for (const kind of ['symlink', 'tree', 'utf8', 'oversize', 'json']) {
    const root = temp(),
      dir = join(root, 'capture')
    mkdirSync(dir)
    const f = join(dir, 'failure.json')
    if (kind === 'symlink') {
      writeFileSync(join(root, 'other'), '{}')
      symlinkSync(join(root, 'other'), f)
    }
    if (kind === 'tree') mkdirSync(join(dir, 'unexpected'))
    if (kind === 'utf8') writeFileSync(f, Buffer.from([0xff]))
    if (kind === 'oversize') writeFileSync(f, 'x'.repeat(8193))
    if (kind === 'json') writeFileSync(f, '{')
    assert.throws(() =>
      exportSummary(dir, join(root, 'out/summary.json'), env, {
        outcome: 'failure',
        exitCode: 1,
        cleanupConfirmed: true
      })
    )
  }
})
test('passing summary demands zero exit clean wrapper and absent failure', () => {
  const root = temp(),
    dir = join(root, 'capture')
  mkdirSync(dir)
  const out = join(root, 'out/summary.json')
  assert.equal(
    exportSummary(dir, out, env, {
      outcome: 'all-passed',
      exitCode: 0,
      cleanupConfirmed: true
    }).failure,
    null
  )
  assert.throws(() =>
    exportSummary(dir, out, env, {
      outcome: 'all-passed',
      exitCode: 1,
      cleanupConfirmed: true
    })
  )
  assert.throws(() =>
    exportSummary(dir, out, env, {
      outcome: 'all-passed',
      exitCode: 0,
      cleanupConfirmed: false
    })
  )
  atomic(join(dir, 'failure.json'), record(data()))
  assert.throws(() =>
    exportSummary(dir, out, env, {
      outcome: 'all-passed',
      exitCode: 0,
      cleanupConfirmed: true
    })
  )
})
