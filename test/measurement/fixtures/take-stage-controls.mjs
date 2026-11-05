// Pure data controls. No browser, network, child process or capture.
import assert from 'node:assert/strict'
import {
  helperState,
  summarizeTakes,
  emptyTakeSummary,
  takeKeys,
  reasons,
  states,
  relations
} from './take-stage.mjs'
const source = 'function submitted() {\n  window.__submitted = true\n}\n'
const end = source.indexOf('}') + 1
const entry = (count = 0) => ({
  url: 'http://localhost/event.js',
  source,
  functions: [
    {
      functionName: 'submitted',
      ranges: [{ startOffset: 0, endOffset: end, count }]
    }
  ]
})
const clone = (value) => structuredClone(value)
const take = (sequence, why, entries = [entry()], at = 7) => ({
  name: `42-${sequence}.json`,
  data: { pid: 42, why, at, navigations: [], entries }
})
const indexFor = (records) =>
  records.map(({ name, data }) => ({ name, why: data.why }))
const summary = (records, mode = 'click') =>
  summarizeTakes(records, indexFor(records), source, mode)
assert.equal(helperState([], source), 'no-event-entry')
assert.equal(
  helperState([{ ...entry(), functions: [] }], source),
  'absent-exact'
)
assert.equal(helperState([entry()], source), 'exact-zero')
assert.equal(helperState([entry(1)], source), 'exact-positive')
assert.equal(helperState([entry(), entry(1)], source), 'exact-positive')
assert.equal(helperState([entry(1), entry()], source), 'exact-positive')
const wrongSpan = entry()
wrongSpan.functions[0].ranges[0].endOffset--
assert.equal(helperState([wrongSpan], source), 'absent-exact')
const nested = entry()
nested.functions[0].ranges.push({ startOffset: 2, endOffset: 5, count: 1 })
assert.equal(helperState([nested], source), 'exact-zero')
for (const badSource of [undefined, null, 8, '', source + '//different']) {
  assert.equal(
    helperState([{ ...entry(), source: badSource }], source),
    'inconclusive'
  )
}
for (const change of [
  (e) => {
    e.functions = null
  },
  (e) => {
    e.functions[0].ranges = []
  },
  (e) => {
    e.functions[0].ranges[0].count = -1
  },
  (e) => {
    e.functions[0].ranges[0].count = 0.5
  },
  (e) => {
    e.functions[0].ranges[0].startOffset = -1
  },
  (e) => {
    e.functions[0].ranges[0].endOffset = source.length + 1
  },
  (e) => {
    e.functions[0].ranges.push({ ...e.functions[0].ranges[0], count: 1 })
  }
]) {
  const bad = entry()
  change(bad)
  assert.equal(helperState([entry(1), bad], source), 'inconclusive')
  assert.equal(helperState([bad, entry(1)], source), 'inconclusive')
}
const valid = [
  take(1, 'before:goto', []),
  take(3, 'before:click'),
  take(5, 'poll', [entry(1)])
]
const baseline = summary(valid)
assert.equal(baseline['take-metadata'], 'valid')
assert.equal(baseline['take-order'], 'valid')
assert.equal(baseline['take-reason-before-goto-no-event-entry'], '1')
assert.equal(baseline['take-order-action-initiation-exact-zero'], '1')
assert.equal(baseline['take-order-later-initiation-exact-positive'], '1')
assert.deepEqual(Object.keys(baseline), takeKeys)
// Equal timestamps and non-contiguous initiation sequences are legitimate.
// Completion/index order can differ from initiation order without changing buckets.
assert.deepEqual(summary([valid[2], valid[0], valid[1]]), baseline)
assert.deepEqual(
  summarizeTakes(valid, indexFor(valid).reverse(), source, 'click'),
  baseline
)
for (const mode of ['click', 'enter']) {
  const action = mode === 'click' ? 'before:click' : 'before:press'
  for (const count of [0, 1, 2, 3]) {
    const records = [
      take(1, action),
      ...Array.from({ length: count }, (_, i) => take(i + 2, 'poll'))
    ]
    const s = summary(records, mode)
    assert.equal(
      s['take-reason-poll-exact-zero'],
      count === 0 ? '0' : count === 1 ? '1' : '2plus'
    )
  }
}
for (const actionCount of [0, 2]) {
  const records = [
    take(1, 'poll'),
    ...Array.from({ length: actionCount }, (_, i) =>
      take(i + 2, 'before:click')
    )
  ]
  const s = summary(records)
  assert.equal(s['take-metadata'], 'valid')
  assert.equal(s['take-order'], 'inconclusive')
  for (const relation of relations)
    for (const state of states)
      assert.equal(s[`take-order-${relation}-${state}`], 'inconclusive')
}
for (const why of [
  'before:reload',
  'before:goBack',
  'before:goForward',
  'before:dblclick',
  'before:tap'
]) {
  assert.equal(
    summary([take(1, 'before:click'), take(2, why)])[
      'take-reason-other-known-api-exact-zero'
    ],
    '1'
  )
}
for (const change of [
  (r, i) => {
    r.push(clone(r[0]))
    i.push(clone(i[0]))
  },
  (r, i) => {
    r[0].name = '42-3.json'
    i[0].name = '42-3.json'
  },
  (r, i) => {
    i[0].why = 'poll'
  },
  (r, i) => {
    r[0].data.why = 'unknown'
    i[0].why = 'unknown'
  },
  (r, i) => {
    r[0].data.pid = 43
    r[0].name = '43-1.json'
    i[0].name = '43-1.json'
  },
  (r) => {
    r[0].data.at = NaN
  },
  (r) => {
    r[0].data.entries = null
  },
  (r) => {
    r[0].data.navigations = [{}]
  },
  (r) => {
    r[0].data.entries = [{ url: 'not a URL' }]
  },
  (r, i) => {
    i[0].name = 'missing.json'
  },
  (r, i) => {
    i.pop()
  }
]) {
  const r = clone(valid)
  const i = indexFor(r)
  change(r, i)
  assert.deepEqual(summarizeTakes(r, i, source, 'click'), emptyTakeSummary())
}
// Metadata remains valid when the helper evidence alone is inconclusive.
const different = entry()
different.source += '//different'
const mismatched = summary([take(1, 'before:click', [different])])
assert.equal(mismatched['take-metadata'], 'valid')
assert.equal(mismatched['take-order-action-initiation-inconclusive'], '1')
for (const reason of reasons)
  for (const state of states)
    assert(
      ['0', '1', '2plus'].includes(baseline[`take-reason-${reason}-${state}`])
    )
console.log('take-stage-controls=pass')
