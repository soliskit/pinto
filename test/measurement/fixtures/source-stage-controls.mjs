// Synthetic controls only. Does not launch a browser or application.
import assert from 'node:assert/strict'
import V8ToIstanbul from 'v8-to-istanbul'
import libCoverage from 'istanbul-lib-coverage'
import {
  sourceMatch,
  rawHelperPositive,
  directLine2Positive,
  wrapperLine2Positive
} from './source-stage.mjs'
const source = 'function submitted() {\n  window.__submitted = true\n}\n'
const fn = (count = 1, name = 'submitted', start = 0) => ({
  functionName: name,
  ranges: [{ startOffset: start, endOffset: source.indexOf('}') + 1, count }]
})
const entries = (f = fn()) => [{ source, functions: [f] }]
assert.equal(sourceMatch(entries(), source), 'yes')
assert.equal(sourceMatch([{ source: 'different' }], source), 'no')
for (const x of [[], [{ source: undefined }], [{ source: null }]])
  assert.equal(sourceMatch(x, source), 'inconclusive')
assert.equal(sourceMatch([{ source: '' }], ''), 'inconclusive')
console.log('source-identity-control=pass')
assert.equal(rawHelperPositive(entries(), source), 'yes')
for (const f of [fn(0), fn(1, 'other'), fn(1, 'submitted', 1)])
  assert.equal(rawHelperPositive(entries(f), source), 'no')
assert.equal(
  rawHelperPositive(entries({ functionName: 'submitted' }), source),
  'inconclusive'
)
assert.equal(rawHelperPositive(entries(fn(-1)), source), 'inconclusive')
const outerZeroInnerPositive = fn(0)
outerZeroInnerPositive.ranges.push({ startOffset: 25, endOffset: 30, count: 1 })
assert.equal(rawHelperPositive(entries(outerZeroInnerPositive), source), 'no')
assert.equal(rawHelperPositive(entries(fn(0.5)), source), 'inconclusive')
const outOfOuter = fn(1)
outOfOuter.ranges.push({ startOffset: 0, endOffset: source.length, count: 1 })
assert.equal(rawHelperPositive(entries(outOfOuter), source), 'inconclusive')
assert.equal(
  rawHelperPositive(
    [...entries(), { source, functions: [{ functionName: 'bad' }] }],
    source
  ),
  'inconclusive'
)
assert.equal(
  rawHelperPositive([...entries(fn(0)), ...entries(fn(1))], source),
  'yes'
)
const duplicateSpan = fn(0)
duplicateSpan.ranges.push({ ...duplicateSpan.ranges[0], count: 1 })
assert.equal(rawHelperPositive(entries(duplicateSpan), source), 'inconclusive')
const crossing = fn(1)
crossing.ranges.push(
  { startOffset: 10, endOffset: 30, count: 1 },
  { startOffset: 20, endOffset: 40, count: 1 }
)
assert.equal(rawHelperPositive(entries(crossing), source), 'inconclusive')
console.log('raw-helper-control=pass')
assert.equal(
  await directLine2Positive(entries(), source, () => Promise.resolve(1)),
  'yes'
)
assert.equal(
  await directLine2Positive(entries(), source, () => Promise.resolve(0)),
  'no'
)
assert.equal(
  await directLine2Positive(entries(), source, () =>
    Promise.reject(new Error('control'))
  ),
  'inconclusive'
)
assert.equal(
  await directLine2Positive(entries(), source, () =>
    Promise.resolve(undefined)
  ),
  'inconclusive'
)
console.log('direct-error-control=pass')
assert.equal(rawHelperPositive(entries(fn(0)), source), 'no')
assert.equal(
  await directLine2Positive(entries(fn(0)), source, () => Promise.resolve(1)),
  'yes'
)
assert.equal(wrapperLine2Positive(0), 'no')
assert.equal(wrapperLine2Positive(undefined), 'inconclusive')
assert.throws(() => assert(0 > 0, 'original line2 oracle remains a failure'))
console.log('separate-observations-control=pass')

// Real pinned-library integration, distinct from injected error callbacks.
for (const count of [0, 1]) {
  const input = entries(fn(count))
  const result = await directLine2Positive(input, source, async (entry) => {
    const path = '/synthetic-source-stage.js'
    const converter = new V8ToIstanbul(path, 0, { source })
    await converter.load()
    converter.applyCoverage(entry.functions)
    return libCoverage
      .createFileCoverage(converter.toIstanbul()[path])
      .getLineCoverage()[2]
  })
  assert.equal(result, count ? 'yes' : 'no')
}
console.log('direct-pinned-library-control=pass')
