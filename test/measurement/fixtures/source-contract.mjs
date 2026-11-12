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
/** @param {string} name @param {number} count */
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
/** @param {import('node:inspector').Profiler.FunctionCoverage[][]} takes */
const merged = (takes) => ({ url: '/input.js', source, coverageList: takes })
/** @param {import('istanbul-lib-coverage').FileCoverageData} cov */
const lines = (cov) => libCoverage.createFileCoverage(cov).getLineCoverage()
/** @param {import('istanbul-lib-coverage').FileCoverageData} cov @param {string} name */
const functionHit = (cov, name) => {
  const found = Object.entries(cov.fnMap).find(([, fn]) => fn.name === name)
  assert(found, 'expected named function is present')
  return cov.f[found[0]]
}
/** @param {import('istanbul-lib-coverage').FileCoverageData} cov */
const shape = (cov) => ({
  statementMap: cov.statementMap,
  s: cov.s,
  fnMap: cov.fnMap,
  f: cov.f,
  branchMap: cov.branchMap,
  b: cov.b
})
/** @param {string} name @param {() => unknown} run */
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
    const direct = V8ToIstanbul(path, 0, { source })
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
  await proof('uncalled-function-does-not-credit-child', async () => {
    const text =
      'function g(flag) {\n  if (flag) {\n    return 1\n  }\n  return 0\n}\ng(false)\n'
    const end = text.indexOf('\n}\n') + 2
    const start = text.indexOf('return 1')
    const module = {
      functionName: '',
      isBlockCoverage: true,
      ranges: [{ startOffset: 0, endOffset: text.length, count: 1 }]
    }
    const zero = {
      functionName: 'g',
      isBlockCoverage: false,
      ranges: [{ startOffset: 0, endOffset: end, count: 0 }]
    }
    const called = {
      functionName: 'g',
      isBlockCoverage: true,
      ranges: [
        { startOffset: 0, endOffset: end, count: 1 },
        {
          startOffset: start,
          endOffset: start + 'return 1'.length,
          count: 0
        }
      ]
    }
    for (const takes of [
      [
        [module, zero],
        [module, called]
      ],
      [
        [module, called],
        [module, zero]
      ]
    ]) {
      const cov = await toFileCoverage(
        { source: text, coverageList: takes },
        path
      )
      const child = Object.entries(cov.branchMap).find(
        ([, br]) => br.loc.start.line === 3 && br.loc.start.column === 4
      )
      assert(child, 'the zero child location remains in the report')
      assert.equal(
        cov.b[child[0]][0],
        0,
        'an uncalled take cannot credit the child'
      )
      assert(functionHit(cov, 'g') > 0, 'the other take did call g')
    }
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
  await proof('source-conflict', () => {
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
    const entry = same.get('/input.js')
    assert(entry, 'the merged input URL must be present')
    assert.equal(entry.source, source)
    assert.equal(entry.coverageList.length, 2)
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}
