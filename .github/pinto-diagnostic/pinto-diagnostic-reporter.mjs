import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'

export const FILES = Object.freeze([
  'test/room.test.ts',
  'test/room-join-edges.test.ts',
  'test/video-width.test.ts',
  'test/pinch-zoom.test.ts',
  'test/contrast.test.ts',
  'test/config-timings-edges.test.ts'
])
const TARGET =
  'local Leave retires a closed call before a later room-loss notice'
const CODES = new Set(['ERR_ASSERTION', 'ERR_TEST_FAILURE', 'ERR_TEST_TIMEOUT'])
const CLASSES = new Set([
  'Error',
  'AssertionError',
  'TimeoutError',
  'TypeError',
  'RangeError'
])
const own = (x, k) => {
  if (!x || typeof x !== 'object') return undefined
  const d = Object.getOwnPropertyDescriptor(x, k)
  return d && 'value' in d ? d.value : undefined
}
const integer = (x, max = 1000000) =>
  Number.isSafeInteger(x) && Math.abs(x) <= max
const type = (x) =>
  x === null
    ? 'null'
    : [
          'undefined',
          'boolean',
          'number',
          'string',
          'bigint',
          'symbol',
          'function'
        ].includes(typeof x)
      ? typeof x
      : 'object'
const primitive = (x) => ({
  type: type(x),
  value: x === null || typeof x === 'boolean' || integer(x) ? x : null,
  length: typeof x === 'string' ? Math.min(x.length, 65535) : null,
  redacted: !(x === null || typeof x === 'boolean' || integer(x))
})
const frame = (error, data) => {
  const stack = own(error, 'stack')
  if (typeof stack === 'string' && stack.length <= 65536) {
    for (const line of stack.split('\n').slice(1, 30)) {
      const match = line.match(
        /(?:\/|\()(?<file>test\/(?:room\.test|room-join-edges\.test|video-width\.test|pinch-zoom\.test|contrast\.test|config-timings-edges\.test)\.ts):(?<line>\d{1,6}):(?<column>\d{1,6})(?:\)|$)/
      )
      if (match && FILES.includes(match.groups.file))
        return {
          file: match.groups.file,
          line: Number(match.groups.line),
          column: Number(match.groups.column),
          unknown: false,
          native: true
        }
    }
  }
  const file = own(data, 'file')
  const known =
    typeof file === 'string' &&
    FILES.find((f) => file === f || file.endsWith('/' + f))
  const line = own(data, 'line'),
    column = own(data, 'column')
  return known && integer(line) && line > 0 && integer(column) && column > 0
    ? { file: known, line, column, unknown: false, native: false }
    : { file: null, line: null, column: null, unknown: true, native: false }
}
export function capture(data) {
  let error = own(own(data, 'details'), 'error')
  const outer = error
  for (let i = 0; i < 3; i++) {
    const cause = own(error, 'cause')
    if (!cause || typeof cause !== 'object') break
    error = cause
  }
  const name = own(error, 'name'),
    code = own(error, 'code')
  const expected = Object.getOwnPropertyDescriptor(
    error && typeof error === 'object' ? error : {},
    'expected'
  )
  const actual = Object.getOwnPropertyDescriptor(
    error && typeof error === 'object' ? error : {},
    'actual'
  )
  return {
    testId: own(data, 'name') === TARGET ? 'target' : 'other',
    category: CLASSES.has(name)
      ? name
      : code === 'ERR_ASSERTION'
        ? 'AssertionError'
        : 'unknown',
    code: CODES.has(code) ? code : 'unknown',
    outerCode: CODES.has(own(outer, 'code')) ? own(outer, 'code') : 'unknown',
    frame: frame(error, data),
    expectedPresent: !!expected && 'value' in expected,
    actualPresent: !!actual && 'value' in actual,
    expected: primitive(
      expected && 'value' in expected ? expected.value : undefined
    ),
    actual: primitive(actual && 'value' in actual ? actual.value : undefined)
  }
}
export function binding(env) {
  if (
    !/^[a-f0-9]{40}$/.test(env.DIAGNOSTIC_TARGET ?? '') ||
    !['base', 'dependency'].includes(env.DIAGNOSTIC_ROLE) ||
    !/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9][0-9]{0,3}$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
  )
    throw Error('binding-refused')
  return {
    target: env.DIAGNOSTIC_TARGET,
    role: env.DIAGNOSTIC_ROLE,
    run: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT
  }
}
export function atomic(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (lstatSync(dirname(path)).isSymbolicLink())
    throw Error('directory-refused')
  const tmp = path + '.tmp'
  const fd = openSync(
    tmp,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600
  )
  try {
    writeSync(fd, JSON.stringify(data) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}
export async function* reporter(source, opts = {}) {
  const env = opts.env ?? process.env,
    say = opts.say ?? ((line) => writeSync(3, line))
  const persist =
    opts.persist ??
    ((data) => atomic(join(env.DIAGNOSTIC_CAPTURE_DIR, 'failure.json'), data))
  say('READY\n')
  for await (const event of source) {
    if (
      event.type === 'test:fail' &&
      event.data.todo === undefined &&
      event.data.skip === undefined
    ) {
      try {
        persist({
          schema: 1,
          ...binding(env),
          outcome: 'failure',
          detail: capture(event.data)
        })
      } catch {
        /* Existing failure remains fatal. Missing capture is refused by exporter. */
      }
      say(`FIRST-FAIL ${JSON.stringify(event.data.name ?? null)}\n`)
      yield ''
      return
    }
  }
}
export default reporter
