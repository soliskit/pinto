// Measurement-only converter controls. No browser or application scenarios.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import libCoverage from 'istanbul-lib-coverage'
import V8ToIstanbul from 'v8-to-istanbul'
import { toFileCoverage } from '../convert.mjs'
import { mergeV8Entries } from '../v8merge.mjs'

const dir = mkdtempSync(join(tmpdir(), 'pinto-source-contract-'))
const path = join(dir, 'input.js')
const source = [
  'function cold() {',
  '  return 1',
  '}',
  'function hot() {',
  '  return 2',
  '}',
  'hot()',
  ''
].join('\n')
const diskOther = 'throw new Error("different disk source")\n'
const span = (name, count) => ({
  functionName: name,
  isBlockCoverage: true,
  ranges: [
    {
      startOffset: source.indexOf('function ' + name),
      endOffset: source.indexOf('}', source.indexOf('function ' + name)) + 1,
      count
    }
  ]
})
const root = {
  functionName: '',
  isBlockCoverage: true,
  ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }]
}
const full = [root, span('cold', 0), span('hot', 1)]
const coldTake = [root, span('cold', 0), span('hot', 0)]
const absentTake = [root, span('cold', 0)]
const merged = (takes) => ({ url: '/input.js', source, coverageList: takes })
const lines = (cov) => libCoverage.createFileCoverage(cov).getLineCoverage()
const functionHit = (cov, name) => {
  const found = Object.entries(cov.fnMap).find(([, fn]) => fn.name === name)
  assert(found, 'expected named function is present')
  return cov.f[found[0]]
}
const shape = (cov) => ({
  statementMap: cov.statementMap,
  s: cov.s,
  fnMap: cov.fnMap,
  f: cov.f,
  branchMap: cov.branchMap,
  b: cov.b
})
async function proof(name, run) {
  await run()
  console.log(name + '=pass')
}
try {
  await proof('supplied-source', async () => {
    writeFileSync(path, diskOther)
    const cov = await toFileCoverage(merged([full]), path)
    assert.equal(lines(cov)[2], 0)
    assert.equal(lines(cov)[5], 1)
    assert.equal(functionHit(cov, 'cold'), 0)
    assert.equal(functionHit(cov, 'hot'), 1)
    assert.equal(Object.keys(lines(cov)).length, 7)
  })
  await proof('same-source', async () => {
    writeFileSync(path, source)
    const direct = new V8ToIstanbul(path, 0, { source })
    await direct.load()
    direct.applyCoverage(full)
    const cov = await toFileCoverage(merged([full]), path)
    assert.deepEqual(shape(cov), shape(direct.toIstanbul()[path]))
  })
  await proof('missing-source', async () => {
    await assert.rejects(
      toFileCoverage({ url: '/input.js', coverageList: [full] }, path),
      /coverage conversion requires a defined source/
    )
  })
  await proof('negative-control', async () => {
    const cov = await toFileCoverage(merged([coldTake]), path)
    assert.equal(functionHit(cov, 'cold'), 0)
    assert.equal(functionHit(cov, 'hot'), 0)
    assert.equal(lines(cov)[2], 0)
    assert.equal(lines(cov)[5], 0)
  })
  await proof('positive-union', async () => {
    const a = await toFileCoverage(merged([absentTake, full, coldTake]), path)
    const b = await toFileCoverage(merged([coldTake, full, absentTake]), path)
    assert.equal(functionHit(a, 'hot'), 1)
    assert.equal(lines(a)[5], 1)
    assert.equal(functionHit(a, 'cold'), 0)
    assert.equal(lines(a)[2], 0)
    assert.deepEqual(shape(a), shape(b))
  })
  await proof('empty-source', async () => {
    writeFileSync(path, diskOther)
    const cov = await toFileCoverage(
      { url: '/input.js', source: '', coverageList: [[]] },
      path
    )
    assert.deepEqual(shape(cov), {
      statementMap: {},
      s: {},
      fnMap: {},
      f: {},
      branchMap: {},
      b: {}
    })
    await assert.rejects(
      toFileCoverage(
        { url: '/input.js', source: '', coverageList: [full] },
        path
      ),
      /coverage range exceeds empty source/
    )
  })
  await proof('source-conflict', async () => {
    assert.throws(() =>
      mergeV8Entries([
        { url: '/input.js', source, functions: full },
        { url: '/input.js', source: diskOther, functions: full }
      ])
    )
    const same = mergeV8Entries([
      { url: '/input.js', source, functions: full },
      { url: '/input.js', source, functions: full }
    ])
    assert.equal(same.size, 1)
    assert.equal(same.get('/input.js').source, source)
    assert.equal(same.get('/input.js').coverageList.length, 2)
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}
