import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  scopedSourceBindings,
  normalizeOwnNodeEntry
} from '../node-source-identity.mjs'
import { validateServerDir } from '../validate.mjs'
import { mergeV8Entries } from '../v8merge.mjs'
import { toFileCoverage } from '../convert.mjs'
import {
  stopMeasuredServer,
  validateProcessReceipt
} from '../stop-measured-server.mjs'
const dir = mkdtempSync(join(tmpdir(), 'pinto-identity-stop-'))
let proofs = 0
/** @param {string} name @param {() => unknown} fn */
async function proof(name, fn) {
  await fn()
  proofs++
  console.log('PASS ' + name)
}
const a = join(dir, 'a.js'),
  b = join(dir, 'b.js')
const source =
  'export function cold(){ return 1 }\nexport function hot(){ return 2 }\nhot()\n'
writeFileSync(a, source)
writeFileSync(b, source)
const url = pathToFileURL(a).href
const bindings = scopedSourceBindings([{ abs: a }, { abs: b }])
const functions = [
  {
    functionName: '',
    ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
    isBlockCoverage: true
  },
  {
    functionName: 'cold',
    ranges: [{ startOffset: 7, endOffset: 33, count: 0 }],
    isBlockCoverage: true
  },
  {
    functionName: 'hot',
    ranges: [{ startOffset: 41, endOffset: 66, count: 1 }],
    isBlockCoverage: true
  }
]
await proof('query/hash source identities retain each V8 instance', () => {
  const es = [1, 2].map((n) => {
    const normalized = normalizeOwnNodeEntry(
      { url: url + '?load=' + String(n) + '#part', functions },
      bindings
    )
    assert(normalized, 'the bound query URL must normalize')
    return normalized
  })
  const merged = mergeV8Entries(es)
  assert.equal(merged.size, 1)
  const entry = merged.get(url)
  assert(entry, 'the merged source URL must be present')
  assert.deepEqual(entry.coverageList, [functions, functions])
})
await proof('conflicting supplied source rejected', () => {
  assert.throws(
    () =>
      normalizeOwnNodeEntry(
        { url: url + '?load=3', source: 'changed', functions },
        bindings
      ),
    /conflict/
  )
})
await proof('different physical files remain separate', () => {
  const first = normalizeOwnNodeEntry({ url, functions }, bindings)
  const second = normalizeOwnNodeEntry(
    { url: pathToFileURL(b).href, functions },
    bindings
  )
  assert(first, 'the first bound physical file must normalize')
  assert(second, 'the second bound physical file must normalize')
  assert.equal(mergeV8Entries([first, second]).size, 2)
})
await proof(
  'scope and protocol cannot expand through query normalization',
  () => {
    assert.equal(
      normalizeOwnNodeEntry(
        { url: 'https://example.invalid/a.js?load=1', functions },
        bindings
      ),
      null
    )
    const c = join(dir, 'outside.js')
    writeFileSync(c, source)
    assert.equal(
      normalizeOwnNodeEntry(
        { url: pathToFileURL(c).href + '?load=1', functions },
        bindings
      ),
      null
    )
  }
)
await proof(
  'actual validator admits own query reload before filtering, cold function stays zero',
  async () => {
    const reports = join(dir, 'reports')
    mkdirSync(reports)
    writeFileSync(
      join(reports, 'coverage-1-1-0.json'),
      JSON.stringify({ result: [{ url: url + '?load=1', functions }] })
    )
    const entries = validateServerDir(reports, 0, new Set([url]), bindings)
    assert.equal(entries.length, 1)
    const cov = await toFileCoverage(mergeV8Entries(entries).get(url), a)
    const cold = Object.entries(cov.fnMap).find(([, v]) => v.name === 'cold')
    assert(cold)
    assert.equal(cov.f[cold[0]], 0)
  }
)
/** @param {string} mode @param {string} coverage */
async function start(mode, coverage) {
  const file = join(dir, 'child-' + mode + '-' + String(Date.now()) + '.mjs')
  writeFileSync(
    file,
    `process.on('SIGTERM',()=>${mode === 'ignore' ? '{}' : 'process.exit(0)'});console.log('ready');setInterval(()=>{},1000)`
  )
  const startedAt = Date.now()
  const child = spawn(process.execPath, [file], {
    env: { ...process.env, NODE_OPTIONS: '', NODE_V8_COVERAGE: coverage },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('error', reject)
  })
  return {
    child,
    startedAt,
    sourceUrl: pathToFileURL(file).href,
    dir: coverage
  }
}
await proof(
  'graceful stop has fresh exact-PID exact-source receipt',
  async () => {
    const x = await start('normal', join(dir, 'normal'))
    const names = await stopMeasuredServer(x.child, x)
    assert(names.length)
  }
)
await proof('timeout kills and awaits child, then fails', async () => {
  const x = await start('ignore', join(dir, 'ignore'))
  await assert.rejects(
    stopMeasuredServer(x.child, { ...x, timeoutMs: 100 }),
    /timed out/
  )
  assert.equal(x.child.signalCode, 'SIGKILL')
})
await proof(
  'early failure cleanup still awaits and validates child',
  async () => {
    const x = await start('early', join(dir, 'early'))
    let failed
    try {
      throw Error('fixture early failure')
    } catch {
      failed = true
      await stopMeasuredServer(x.child, x)
    }
    assert.equal(failed, true)
    assert.equal(x.child.exitCode, 0)
  }
)
const receiptDir = join(dir, 'bad')
mkdirSync(receiptDir)
await proof('wrong PID and source receipts fail closed', () => {
  writeFileSync(
    join(receiptDir, 'coverage-99-100-0.json'),
    JSON.stringify({ result: [{ url: 'file:///wrong' }] })
  )
  assert.throws(
    () => validateProcessReceipt(receiptDir, 98, 0, url),
    /missing PID/
  )
  assert.throws(
    () => validateProcessReceipt(receiptDir, 99, 0, url),
    /source identity/
  )
})
await proof('stale and cut-off receipts fail closed', () => {
  assert.throws(() => validateProcessReceipt(receiptDir, 99, 101, url), /stale/)
  writeFileSync(join(receiptDir, 'coverage-99-100-0.json'), '{')
  assert.throws(() => validateProcessReceipt(receiptDir, 99, 0, url), /cut-off/)
})
console.log(
  `${String(proofs)}/${String(proofs)} identity and shutdown fixture proofs passed`
)
