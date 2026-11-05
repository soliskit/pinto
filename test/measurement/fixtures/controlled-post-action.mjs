// Finite controlled diagnostic. No production scenario or exemption.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import libCoverage from 'istanbul-lib-coverage'
import V8ToIstanbul from 'v8-to-istanbul'
import { sourceMatch, rawHelperPositive } from './source-stage.mjs'
import { mergeV8Entries } from '../v8merge.mjs'
import { toFileCoverage } from '../convert.mjs'
const here = fileURLToPath(new URL('.', import.meta.url))
const lineHits = (cov) => libCoverage.createFileCoverage(cov).getLineCoverage()
const finite = (x) => Number.isFinite(x) && x >= 0 && x <= 500000
const parse = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const modes = ['no-navigation-click', 'no-navigation-enter', 'released-navigation-click', 'released-navigation-enter']
async function runChild(child, dir, fixtureMode) {
  return new Promise((resolve) => {
    const proc = spawn('timeout', ['--signal=TERM', '--kill-after=5s', '90s', process.execPath, child], {
      detached: true, cwd: join(here, '..', '..'),
      env: { ...process.env, PINTO_MEASURE: '1', PINTO_MEASURE_DIR: dir, FIXTURE_MODE: fixtureMode,
        PINTO_FIXTURE_EXPLICIT_TAKE: '1', NODE_OPTIONS: `--import ${join(here, '..', 'browser-preload.mjs')}` },
      stdio: 'ignore'
    })
    let settled = false
    function finish(reason) {
      if (settled) return
      settled = true; clearTimeout(watchdog)
      try { process.kill(-proc.pid, 'SIGKILL') } catch {}
      resolve(reason)
    }
    const watchdog = setTimeout(() => finish('child-deadline'), 100000)
    proc.once('error', () => finish('spawn-failed'))
    proc.once('exit', (code) => finish(code === 0 ? 'none' : code === 124 || code === 137 ? 'child-timeout' : 'child-failed'))
  })
}
for (const controlArm of ['no-navigation', 'released-navigation']) for (const fixtureMode of ['click', 'enter']) {
  const mode = controlArm + '-' + fixtureMode
  const dir = mkdtempSync(join(tmpdir(), 'fx-controlled-'))
  const scriptDir = mkdtempSync(join(tmpdir(), 'fx-source-'))
  const abs = join(scriptDir, 'event.js')
  const child = join(here, '.child-controlled.mjs')
  const src = ['function submitted() {', '  window.__submitted = true', '}',
    'document.querySelector("form").addEventListener("submit", async (event) => {',
    '  event.preventDefault()', '  submitted()',
    ...(controlArm === 'released-navigation' ? ['  await new Promise((resolve) => { window.__releaseNavigation = resolve })', '  location.assign("/next")'] : []), '})', ''].join('\n')
  const expectedHash = createHash('sha256').update(src).digest('hex')
  const rows = []
  let phase = 'setup', failure = 'none', childPhase = 'unavailable', complete = true, cleanup = 'unverified'
  let timeline = {}, explicitOrdinal = null, sessionId = null, expectedCount = null
  let sawProvenCredit = false, intervalPositive = false, explicitPositive = 'inconclusive', conversionFailure = false
  try {
    writeFileSync(abs, src)
      writeFileSync(
        child,
        `
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
const timeline = {}
const persist = () => writeFileSync(process.env.PINTO_MEASURE_DIR + '/timeline.json', JSON.stringify(timeline))
const mark = (value) => { persist(); writeFileSync(process.env.PINTO_MEASURE_DIR + '/child.phase', value) }
mark('setup')
import { chromium } from 'playwright'
import { takeAfterFixtureAction } from '../browser-preload.mjs'
const controlArm = ${JSON.stringify(controlArm)}
const src = ${JSON.stringify(src)}
const server = createServer((req, res) => {
  if (req.url === '/event.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(src)
  } else if (req.url === '/p') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<form><input name="x"><button>Go</button></form><script src="/event.js"></script>')
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<p>Next</p>')
  }
})
await new Promise((resolve) => server.listen(0, resolve))
const base = 'http://localhost:' + server.address().port
mark('browser-launch')
const browser = await chromium.launch()
try {
  for (const mode of [process.env.FIXTURE_MODE]) {
    mark('page-create')
    const page = await browser.newPage()
    try {
      mark('goto')
      await page.goto(base + '/p')
      mark('action')
      timeline.actionStartedAt = performance.now(); persist()
      if (mode === 'click') await page.click('button')
      else await page.press('input', 'Enter')
      timeline.actionResolvedAt = performance.now(); persist()
      assert.equal(await page.evaluate(() => window.__submitted), true)
      timeline.markerObservedAt = performance.now(); persist()
      timeline.explicitReceipt = await takeAfterFixtureAction(page); persist()
      if (controlArm === 'released-navigation') {
        timeline.releaseIssuedAt = performance.now(); persist()
        await page.evaluate(() => { window.__releaseNavigation() })
        await page.waitForURL(base + '/next')
        assert.equal(page.url(), base + '/next')
      } else {
        assert.equal(page.url(), base + '/p')
      }
      mark('destination')
    } finally { mark('page-close'); await page.close() }
  }
} finally { mark('browser-close'); await browser.close(); mark('server-close'); await new Promise((resolve) => server.close(resolve)) }
timeline.finishedAt = performance.now()
writeFileSync(process.env.PINTO_MEASURE_DIR + '/timeline.json', JSON.stringify(timeline))
mark('done')
`
      )
    phase = 'child'
    failure = await runChild(child, dir, fixtureMode)
  } catch { failure = 'setup-failed' }
  // Never let an outcome assertion skip surviving evidence extraction.
  try {
    const value = readFileSync(join(dir, 'child.phase'), 'utf8')
    if (['setup','browser-launch','page-create','goto','action','destination','page-close','browser-close','server-close','done'].includes(value)) childPhase = value
  } catch {}
  timeline = parse(join(dir, 'timeline.json')) || {}
  phase = 'receipts'
  try {
    const browserDir = join(dir, 'browser')
    const allNames = readdirSync(browserDir).filter((name) => /^\d+-\d+\.json$/.test(name)).sort((a,b) => Number(a.split('-')[1].split('.')[0])-Number(b.split('-')[1].split('.')[0]))
    if (allNames.length > 128) complete = false
    const names = allNames.slice(0,128)
    const records = names.map((name) => ({ name, data: parse(join(browserDir, name)) }))
      .sort((a,b) => (a.data?.ordinal ?? Infinity) - (b.data?.ordinal ?? Infinity))
    function tolerantLines(file, decode) {
      let text
      try { text = readFileSync(join(browserDir,file),'utf8') } catch { complete=false; return [] }
      const out=[]
      for (const line of text.split('\n').filter(Boolean).slice(0,129)) {
        try { out.push(decode(line)) } catch { complete=false }
      }
      if (text.split('\n').filter(Boolean).length > 128) complete=false
      return out
    }
    const index=tolerantLines('captures.index',(line)=> {const parts=line.split('\t'); if(parts.length!==2)throw new Error();return parts})
    const writes=tolerantLines('writes.receipts',(line)=>{const w=JSON.parse(line);if(!w||typeof w!=='object'||Array.isArray(w))throw new Error();return w})
    expectedCount = allNames.length <= 128 ? records.length : null
    const explicit = records.filter((r) => r.data?.why === 'fixture:after-action')
    if (explicit.length === 1) explicitOrdinal = explicit[0].data.ordinal
    sessionId = records[0]?.data?.sessionId ?? null
    if (!records.length || index.length !== records.length || writes.length !== records.length ||
      readdirSync(browserDir).some((name) => name.endsWith('.failed'))) complete = false
    let priorWritten = 0
    for (let i = 0; i < records.length; i++) {
      const {name, data: d} = records[i]
      const ws = writes.filter((w) => w.name === name)
      const ix = index.filter(([n,why]) => n === name && why === d?.why)
      const w = ws.length === 1 ? ws[0] : null
      const row = { mode, sessionId: d?.sessionId ?? null, ordinal: d?.ordinal ?? null, why: d?.why ?? 'unavailable',
        queuedAt: d?.queuedAt ?? null, initiatedAt: d?.initiatedAt ?? null, respondedAt: d?.respondedAt ?? null,
        sourceFetchedAt: d?.sourceFetchedAt ?? null, writtenAt: w?.writtenAt ?? null,
        relation: 'ambiguous', eligible: 'no', source: 'inconclusive', sourceHash: null, helperStart: null, helperEnd: null, helperCount: null,
        raw: 'inconclusive', direct: 'inconclusive', wrapper: 'inconclusive', helperCredit: 'inconclusive', receipt: 'incomplete' }
      rows.push(row)
      const times = [row.queuedAt,row.initiatedAt,row.respondedAt,row.sourceFetchedAt,row.writtenAt]
      const metadata = d && w && d.ordinal === i+1 && d.sessionId === sessionId && w.sessionId === sessionId && w.ordinal === d.ordinal &&
        ix.length === 1 && times.every(finite) && times.every((x,j) => j === 0 || times[j-1] <= x) && priorWritten <= d.initiatedAt &&
        ['queuedAt','initiatedAt','respondedAt','sourceFetchedAt'].every((k) => w[k] === d[k])
      if (!metadata) complete = false
      else { priorWritten = w.writtenAt; row.receipt = 'complete' }
      if (finite(timeline.markerObservedAt) && d?.initiatedAt >= timeline.markerObservedAt) row.relation = 'post-marker'
      else if (finite(timeline.actionStartedAt) && d?.respondedAt < timeline.actionStartedAt) row.relation = 'pre-action'
      const eligible = metadata && Number.isInteger(explicitOrdinal) && d.ordinal <= explicitOrdinal && finite(timeline.actionStartedAt) && d.respondedAt >= timeline.actionStartedAt && (!finite(timeline.releaseIssuedAt) || d.respondedAt <= timeline.releaseIssuedAt)
      row.eligible = eligible ? 'yes' : 'no'
      const entries = Array.isArray(d?.entries) ? d.entries.filter((e) => { try { return new URL(e.url).pathname === '/event.js' } catch { return false } }) : []
      if (!entries.length) { row.source = 'no-event-entry'; continue }
      row.source = sourceMatch(entries, src)
      if (row.source !== 'yes') { complete = false; continue }
      row.sourceHash = expectedHash
      row.raw = rawHelperPositive(entries, src)
      const helpers = entries.flatMap((e) => e.functions || []).filter((fn) => fn.functionName === 'submitted' && fn.ranges?.[0]?.startOffset === 0 && fn.ranges[0].endOffset === 52)
      if (helpers.length === 1) { row.helperStart = 0; row.helperEnd = 52; row.helperCount = helpers[0].ranges[0].count }
      else { complete = false; continue }
      try {
        // Exactly the same take input, no cross-take merge.
        let directHit = 0
        for (const entry of entries) {
          const converter = new V8ToIstanbul(abs, 0, { source: src }); await converter.load(); converter.applyCoverage(entry.functions)
          const hit = lineHits(converter.toIstanbul()[abs])[2]
          assert(Number.isFinite(hit) && hit >= 0); directHit += hit
        }
        row.direct = directHit > 0 ? 'yes' : 'no'
        const merged = mergeV8Entries(entries.map((e) => ({ ...e, url: '/event.js' })))
        const cov = await toFileCoverage(merged.get('/event.js'), abs)
        const hit = lineHits(cov)[2]; assert(Number.isFinite(hit) && hit >= 0)
        row.wrapper = hit > 0 ? 'yes' : 'no'
        const helper = Object.entries(cov.fnMap).find(([,fn]) => fn.name === 'submitted')
        row.helperCredit = helper && cov.f[helper[0]] > 0 ? 'yes' : 'no'
        if (eligible && row.raw === 'yes' && (row.direct !== 'yes' || row.wrapper !== 'yes' || row.helperCredit !== 'yes')) conversionFailure = true
        if (eligible && row.relation === 'post-marker' && row.raw === 'yes' && row.direct === 'yes' && row.wrapper === 'yes' && row.helperCredit === 'yes') sawProvenCredit = true
      } catch { complete = false }
      if (row.raw === 'inconclusive') complete = false
      if (eligible && row.raw === 'yes' && row.relation !== 'pre-action') intervalPositive = true
      if (row.ordinal === explicitOrdinal) explicitPositive = row.raw
    }
  } catch { complete = false }
  const tr = timeline.explicitReceipt
  const timelineValid = [timeline.actionStartedAt,timeline.actionResolvedAt,timeline.markerObservedAt,tr?.writtenAt].every(finite) &&
    timeline.actionStartedAt <= timeline.actionResolvedAt && timeline.actionResolvedAt <= timeline.markerObservedAt &&
    tr?.ordinal === explicitOrdinal && tr?.sessionId === sessionId && rows.some((row) => row.ordinal === explicitOrdinal && row.receipt === 'complete' && row.initiatedAt >= timeline.markerObservedAt && row.writtenAt === tr.writtenAt) &&
    (controlArm === 'released-navigation' ? finite(timeline.releaseIssuedAt) && timeline.releaseIssuedAt >= tr.writtenAt : timeline.releaseIssuedAt === undefined)
  if (!timelineValid) complete = false
  // Emit every bounded surviving row BEFORE status decisions. No source or URL.
  for (const row of rows) console.log('controlled-take=' + JSON.stringify(row))
  const safeTime = (x) => finite(x) ? x : null
  console.log('controlled-timeline=' + JSON.stringify({ mode, sessionId, explicitOrdinal, expectedCount,
    actionStartedAt: safeTime(timeline.actionStartedAt), actionResolvedAt: safeTime(timeline.actionResolvedAt),
    markerObservedAt: safeTime(timeline.markerObservedAt), explicitWrittenAt: safeTime(tr?.writtenAt),
    releaseIssuedAt: safeTime(timeline.releaseIssuedAt), valid: timelineValid ? 'yes' : 'no' }))
  try { rmSync(dir, {recursive:true,force:true}); rmSync(scriptDir,{recursive:true,force:true}); rmSync(child,{force:true})
    cleanup = !existsSync(dir) && !existsSync(scriptDir) && !existsSync(child) ? 'verified-absent' : 'failed'
  } catch { cleanup = 'failed' }
  if (cleanup !== 'verified-absent') complete = false
  const result = failure === 'none' && complete && !conversionFailure && sawProvenCredit ? 'pass' : 'inconclusive'
  if (conversionFailure && failure === 'none') failure = 'mapping-discrepancy'
  console.log(mode + '-phase=' + phase)
  console.log(mode + '-child-phase=' + childPhase)
  console.log(mode + '-failure=' + failure)
  console.log(mode + '-cleanup=' + cleanup)
  console.log(mode + '-receipt-state=' + (complete ? 'complete' : 'incomplete'))
  console.log(mode + '-take-count=' + rows.length)
  console.log(mode + '-interval-positive=' + (intervalPositive ? 'yes' : complete ? 'no' : 'inconclusive'))
  console.log(mode + '-explicit-positive=' + explicitPositive)
  console.log(mode + '=' + result)
  if (result !== 'pass') process.exitCode = 1
}
