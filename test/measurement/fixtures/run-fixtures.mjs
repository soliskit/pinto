// Proves the measurement harness behaviors the plan requires, including
// proving each run-failing check by making it fail. Fixtures live outside the
// production file lists, so they never enter the inventory or the baseline.
// Re-run these after any upgrade to a tool in the measuring setup.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import libCoverage from 'istanbul-lib-coverage'
import { chromium } from 'playwright'
import { CoverageConflict, mergeV8Entries, uncovered } from '../v8merge.mjs'
import { toFileCoverage, summarize } from '../convert.mjs'
import {
  MeasurementFailure,
  validateBrowserDir,
  validateServerDir
} from '../validate.mjs'
import { checkServedScripts, findInlineScripts } from '../checks.mjs'
import { stopWithTimeout } from '../stopwithtimeout.mjs'

const { createFileCoverage } = libCoverage
const here = fileURLToPath(new URL('.', import.meta.url))
const results = []
async function proof(name, fn) {
  try {
    await fn()
    results.push(`ok - ${name}`)
  } catch (error) {
    results.push(`FAIL - ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const lineHits = (cov) => createFileCoverage(cov).getLineCoverage()

// Runs a fixture program with coverage on and returns its converted coverage.
async function nodeCoverageFor(fileAbs, { preload = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fx-cov-'))
  const nodeOptions = preload
    ? `--import ${join(here, '..', 'server-preload.mjs')}`
    : ''
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileAbs], {
      env: {
        ...process.env,
        NODE_V8_COVERAGE: dir,
        NODE_OPTIONS: nodeOptions,
        PINTO_MEASURE: preload ? '1' : ''
      },
      stdio: 'ignore'
    })
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`))
    )
  })
  const url = 'file://' + fileAbs
  const entries = []
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    for (const r of d.result) if (r.url === url) entries.push(r)
  }
  assert(entries.length > 0, `no coverage entry for ${url}`)
  const source = readFileSync(fileAbs, 'utf8')
  const merged = mergeV8Entries(
    entries.map((e) => ({ url: e.url, source, functions: e.functions }))
  )
  return toFileCoverage(merged.get(url), fileAbs)
}

// A temp file with fixture content, so the converter reads real paths.
function tempScript(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'fx-js-'))
  const abs = join(dir, name)
  writeFileSync(abs, content)
  return abs
}

async function withFixtureServer(routes, fn) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname
    const route = routes[pathname]
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': route.type })
    res.end(route.body)
  })
  await new Promise((resolve) => server.listen(0, resolve))
  try {
    await fn(`http://localhost:${server.address().port}`)
  } finally {
    server.close()
  }
}

const FX_JS =
  'function f() {\n  return 7\n}\nif (location.search.includes("run")) {\n  f()\n}\n'
const PAGE = (src) => `<html><body><script src="${src}"></script></body></html>`
const routesFor = (extra = {}) => ({
  '/fx.js': { type: 'text/javascript', body: FX_JS },
  ...extra
})

// Captures each document's coverage separately (the preload's job is capture
// across navigation; these fixtures prove merge and conversion).
async function capturePerDocument(pages) {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const all = []
  for (const url of pages) {
    await page.coverage.startJSCoverage({ resetOnNavigation: false })
    await page.goto(url)
    all.push(...(await page.coverage.stopJSCoverage()))
  }
  await browser.close()
  return all
}

// --- TypeScript exact-line proofs -----------------------------------------
await proof(
  'a TypeScript function that never runs shows uncovered at its exact .ts line, and one that runs shows covered there',
  async () => {
    const prog = tempScript(
      'prog.ts',
      'function neverRuns() {\n  return 42\n}\nfunction runs() {\n  return 1\n}\nruns()\n'
    )
    const cov = await nodeCoverageFor(prog)
    const lines = lineHits(cov)
    assert.equal(lines[2], 0, 'line 2 (neverRuns body) must be uncovered')
    assert(lines[5] > 0, 'line 5 (runs body) must be covered')
  }
)

// --- Merge and conversion proofs ------------------------------------------
await proof(
  'a function that runs only on a second load shows covered',
  async () => {
    await withFixtureServer(
      routesFor({
        '/p1': { type: 'text/html', body: PAGE('/fx.js') },
        '/p2': { type: 'text/html', body: PAGE('/fx.js') }
      }),
      async (base) => {
        const entries = await capturePerDocument([
          base + '/p1',
          base + '/p2?run=1'
        ])
        const js = entries.filter((e) => new URL(e.url).pathname === '/fx.js')
        assert.equal(js.length, 2, 'both loads captured')
        const abs = tempScript('fx.js', FX_JS)
        const merged = mergeV8Entries(
          js.map((e) => ({
            url: '/fx.js',
            source: e.source,
            functions: e.functions
          }))
        )
        const cov = await toFileCoverage(merged.get('/fx.js'), abs)
        assert(
          lineHits(cov)[2] > 0,
          'f body line must be covered after the second load'
        )
      }
    )
  }
)

await proof(
  'two identical files where only one runs leave the other uncovered',
  async () => {
    await withFixtureServer(
      routesFor({
        '/b.js': { type: 'text/javascript', body: FX_JS },
        '/p': { type: 'text/html', body: PAGE('/fx.js?run=1') },
        '/q': { type: 'text/html', body: PAGE('/b.js') }
      }),
      async (base) => {
        // location.search decides: /p?run=1 runs f for fx.js; /q never runs it for b.js
        const entries = await capturePerDocument([
          base + '/p?run=1',
          base + '/q'
        ])
        const abs = tempScript('fx.js', FX_JS)
        const merged = mergeV8Entries(
          entries
            .filter((e) =>
              ['/fx.js', '/b.js'].includes(new URL(e.url).pathname)
            )
            .map((e) => ({
              url: new URL(e.url).pathname,
              source: e.source,
              functions: e.functions
            }))
        )
        const a = await toFileCoverage(merged.get('/fx.js'), abs)
        const b = await toFileCoverage(merged.get('/b.js'), abs)
        assert(lineHits(a)[2] > 0, 'fx.js f must be covered')
        assert.equal(lineHits(b)[2], 0, 'b.js f must stay uncovered')
      }
    )
  }
)

await proof('a scope-listed file that never loads shows 0%', async () => {
  const abs = tempScript('never.js', FX_JS)
  const cov = await toFileCoverage(uncovered('file://' + abs, FX_JS), abs)
  const s = summarize([{ path: abs, coverage: cov }])[abs]
  assert.equal(s.lines.covered, 0)
  assert(s.lines.total > 0, 'total lines must be counted')
  assert.equal(s.functions.covered, 0)
})

await proof(
  'with no reloads the merge gives the same counts as a single load',
  async () => {
    await withFixtureServer(
      routesFor({ '/p': { type: 'text/html', body: PAGE('/fx.js?run=1') } }),
      async (base) => {
        const entries = await capturePerDocument([base + '/p?run=1'])
        const js = entries.filter((e) => new URL(e.url).pathname === '/fx.js')
        const abs = tempScript('fx.js', FX_JS)
        const single = await toFileCoverage(
          {
            url: '/fx.js',
            source: js[0].source,
            coverageList: [js[0].functions]
          },
          abs
        )
        const merged = mergeV8Entries(
          js.map((e) => ({
            url: '/fx.js',
            source: e.source,
            functions: e.functions
          }))
        )
        const viaMerge = await toFileCoverage(merged.get('/fx.js'), abs)
        assert.deepEqual(
          summarize([{ path: abs, coverage: viaMerge }]),
          summarize([{ path: abs, coverage: single }])
        )
      }
    )
  }
)

// --- Capture across navigation, through the preload ------------------------
await proof(
  'a take whose source could not be retrieved keeps its coverage, and a real content conflict still fails',
  async () => {
    // Debugger.getScriptSource can fail on a live target. That take carries
    // source undefined: it must still join the file and contribute its runs,
    // never veto the content check and never drop its coverage.
    const abs = join(here, 'fixture-src.js')
    writeFileSync(abs, FX_JS)
    const ran = {
      functionName: 'f',
      ranges: [{ startOffset: 0, endOffset: FX_JS.length, count: 1 }],
      isBlockCoverage: true
    }
    for (const order of [
      [
        { url: '/fx.js', source: FX_JS, functions: [] },
        { url: '/fx.js', source: undefined, functions: [ran] }
      ],
      [
        { url: '/fx.js', source: undefined, functions: [ran] },
        { url: '/fx.js', source: FX_JS, functions: [] }
      ]
    ]) {
      const merged = mergeV8Entries(order)
      const entry = merged.get('/fx.js')
      assert.equal(entry.source, FX_JS)
      assert.equal(entry.coverageList.length, 2)
      const cov = await toFileCoverage(entry, abs)
      assert.ok(
        Object.values(cov.s).some((hits) => hits > 0),
        "the undefined-source take's execution counts must reach the file coverage"
      )
    }
    assert.throws(
      () =>
        mergeV8Entries([
          { url: '/fx.js', source: FX_JS, functions: [] },
          { url: '/fx.js', source: FX_JS + '// changed', functions: [] }
        ]),
      CoverageConflict
    )
  }
)

await proof(
  'a load that never compiled a function cannot credit its body',
  async () => {
    // V8 compiles lazily. A load whose script instance never compiled f has no
    // entry for f; without the correction its body inherits the enclosing
    // range's count and the max-merge keeps that false credit. The merged
    // result must show f's body uncovered at its exact lines.
    const abs = join(here, 'fixture-src.js')
    writeFileSync(abs, FX_JS)
    const withEntry = [
      {
        functionName: '(anonymous)',
        ranges: [{ startOffset: 0, endOffset: FX_JS.length, count: 1 }],
        isBlockCoverage: true
      },
      {
        functionName: 'f',
        ranges: [{ startOffset: 0, endOffset: 31, count: 0 }],
        isBlockCoverage: true
      }
    ]
    const lazyLoad = [
      {
        functionName: '(anonymous)',
        ranges: [{ startOffset: 0, endOffset: FX_JS.length, count: 1 }],
        isBlockCoverage: true
      }
    ]
    const merged = mergeV8Entries([
      { url: '/fx.js', source: FX_JS, functions: withEntry },
      { url: '/fx.js', source: FX_JS, functions: lazyLoad }
    ])
    const cov = await toFileCoverage(merged.get('/fx.js'), abs)
    const fc = createFileCoverage(cov)
    const lines = fc.getLineCoverage()
    assert.equal(
      lines[2] ?? 0,
      0,
      'the return line inside never-called f must be uncovered'
    )
    assert.equal(lines[4] ?? 0, 1, 'the top-level guard line stays covered')
  }
)

await proof(
  'a never-compiled outer function zeroes its nested functions too',
  async () => {
    // One load compiled outer (and so lists it, never run, count 0); another
    // load never compiled it and lists neither outer nor inner. The union must
    // still show both bodies uncovered: the zero-entry load keeps them honest
    // and the body zeroing removes the lazy load's false credit.
    const SRC =
      'function outer() {\n  function inner() {\n    return 1\n  }\n  return inner\n}\nouter\n'
    const abs = join(here, 'fixture-src.js')
    writeFileSync(abs, SRC)
    const withOuter = [
      {
        functionName: '(anonymous)',
        ranges: [{ startOffset: 0, endOffset: SRC.length, count: 1 }],
        isBlockCoverage: true
      },
      {
        functionName: 'outer',
        ranges: [{ startOffset: 0, endOffset: 73, count: 0 }],
        isBlockCoverage: true
      }
    ]
    const lazyLoad = [
      {
        functionName: '(anonymous)',
        ranges: [{ startOffset: 0, endOffset: SRC.length, count: 1 }],
        isBlockCoverage: true
      }
    ]
    const merged = mergeV8Entries([
      { url: '/n.js', source: SRC, functions: withOuter },
      { url: '/n.js', source: SRC, functions: lazyLoad }
    ])
    const cov = await toFileCoverage(merged.get('/n.js'), abs)
    const fc = createFileCoverage(cov)
    const lines = fc.getLineCoverage()
    assert.equal(lines[3] ?? 0, 0, 'inner body must be uncovered')
    assert.equal(lines[5] ?? 0, 0, 'outer body statement must be uncovered')
    assert.equal(lines[7] ?? 0, 1, 'the top-level reference line stays covered')
    const outerEntry = Object.entries(cov.fnMap).find(
      ([, fn]) => fn.name === 'outer'
    )
    assert.ok(outerEntry, 'outer must appear in the function map')
    assert.equal(cov.f[outerEntry[0]], 0, 'outer must read as never invoked')
    for (const [k, fn] of Object.entries(cov.fnMap)) {
      if (fn.name === 'inner')
        assert.equal(cov.f[k], 0, 'inner must read as never invoked')
    }
  }
)

await proof(
  'a called outer keeps its coverage while its uncalled inner arrow is zeroed',
  async () => {
    const SRC =
      'function outer() {\n  const inner = () => 1\n  return 2\n}\nouter()\n'
    const abs = join(here, 'fixture-src.js')
    writeFileSync(abs, SRC)
    const load = [
      {
        functionName: '(anonymous)',
        ranges: [{ startOffset: 0, endOffset: SRC.length, count: 1 }],
        isBlockCoverage: true
      },
      {
        functionName: 'outer',
        ranges: [{ startOffset: 0, endOffset: 49, count: 1 }],
        isBlockCoverage: true
      },
      {
        functionName: 'inner',
        ranges: [{ startOffset: 21, endOffset: 39, count: 0 }],
        isBlockCoverage: true
      }
    ]
    const merged = mergeV8Entries([
      { url: '/o.js', source: SRC, functions: load }
    ])
    const cov = await toFileCoverage(merged.get('/o.js'), abs)
    const fc = createFileCoverage(cov)
    const lines = fc.getLineCoverage()
    assert.equal(lines[3] ?? 0, 1, 'the executed return must stay covered')
    for (const [k, fn] of Object.entries(cov.fnMap)) {
      if (fn.name === 'outer')
        assert.ok(cov.f[k] > 0, 'outer must read as invoked')
      if (fn.name === 'inner')
        assert.equal(cov.f[k], 0, 'inner must read as never invoked')
    }
  }
)

await proof(
  'a function that runs only before a navigation shows covered',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-nav-'))
    // The child must live under the repo so it resolves playwright.
    const child = join(here, '.child-nav.mjs')
    writeFileSync(
      child,
      `import { createServer } from 'node:http'
import { chromium } from 'playwright'
const server = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  if (p === '/before.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('function g() {\\n  return 1\\n}\\ng()\\n'); return }
  if (p === '/p') { res.end('<html><script src="/before.js"></script></html>'); return }
  res.end('<html></html>')
})
await new Promise((r) => server.listen(0, r))
const base = 'http://localhost:' + server.address().port
const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(base + '/p')
await page.goto(base + '/next')
await page.close()
await browser.close()
server.close()
console.log('child done')
`
    )
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [child], {
          cwd: join(here, '..', '..'),
          env: {
            ...process.env,
            PINTO_MEASURE: '1',
            PINTO_MEASURE_DIR: dir,
            NODE_OPTIONS: `--import ${join(here, '..', 'browser-preload.mjs')}`
          },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        proc.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`child exited ${code}`))
        )
        proc.on('error', reject)
      })
    } finally {
      rmSync(child, { force: true })
    }
    const captures = readdirSync(join(dir, 'browser')).filter((f) =>
      f.endsWith('.json')
    )
    assert(captures.length > 0, 'preload produced no captures')
    const entries = []
    for (const f of captures) {
      const d = JSON.parse(readFileSync(join(dir, 'browser', f), 'utf8'))
      entries.push(...d.entries)
    }
    const js = entries.filter((e) => e.url.endsWith('/before.js'))
    assert(js.length > 0, 'the pre-navigation document must be captured')
    const abs = tempScript('before.js', 'function g() {\n  return 1\n}\ng()\n')
    const merged = mergeV8Entries(
      js.map((e) => ({
        url: '/before.js',
        source: e.source,
        functions: e.functions
      }))
    )
    const cov = await toFileCoverage(merged.get('/before.js'), abs)
    assert(lineHits(cov)[2] > 0, 'g body line must be covered')
  }
)

await proof(
  'a mid-run snapshot and the exit write keep every path exactly once',
  async () => {
    const prog = tempScript(
      'prog.ts',
      'function beforeSignal() {\n  return 1\n}\nfunction afterSignal() {\n  return 2\n}\nbeforeSignal()\nprocess.kill(process.pid, "SIGUSR2")\nsetTimeout(() => {\n  afterSignal()\n}, 100)\n'
    )
    const cov = await nodeCoverageFor(prog, { preload: true })
    const lines = lineHits(cov)
    assert.equal(
      lines[2],
      1,
      'beforeSignal body counted exactly once across snapshot and exit'
    )
    assert.equal(
      lines[5],
      1,
      'afterSignal body counted exactly once across snapshot and exit'
    )
  }
)

// --- Run-failing checks, each proven by making it fail ---------------------
await proof(
  'one path loaded with two different contents fails the run and names the path',
  async () => {
    assert.throws(
      () =>
        mergeV8Entries([
          { url: '/x.js', source: 'v1', functions: [] },
          { url: '/x.js', source: 'v2', functions: [] }
        ]),
      (e) => e instanceof CoverageConflict && e.message.includes('/x.js')
    )
  }
)

await proof(
  'a served script differing from its checked-in source fails the run',
  async () => {
    assert.throws(
      () =>
        checkServedScripts([
          { url: 'http://localhost:1/home.js', source: 'tampered()' }
        ]),
      (e) => e instanceof MeasurementFailure && e.message.includes('/home.js')
    )
  }
)

await proof(
  'a third-party script differing from its package fails the run',
  async () => {
    assert.throws(
      () =>
        checkServedScripts([
          {
            url: 'http://localhost:1/vendor/peerjs.min.js',
            source: 'tampered()'
          }
        ]),
      (e) => e instanceof MeasurementFailure && e.message.includes('peerjs')
    )
  }
)

await proof('a cut-off report is rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fx-cut-'))
  writeFileSync(join(dir, 'coverage-1-1-0.json'), '{"result": [')
  assert.throws(
    () => validateServerDir(dir, Date.now() - 10000, new Set(['file:///x.ts'])),
    (e) => e instanceof MeasurementFailure && e.message.includes('cut-off')
  )
})

await proof('a stale report left by an earlier run is rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fx-stale-'))
  const f = join(dir, 'coverage-1-1-0.json')
  writeFileSync(f, '{"result": []}')
  const old = new Date(Date.now() - 3600_000)
  utimesSync(f, old, old)
  assert.throws(
    () => validateServerDir(dir, Date.now(), new Set(['file:///x.ts'])),
    (e) => e instanceof MeasurementFailure && e.message.includes('stale')
  )
})

await proof(
  'a server that ignores the stop signal until the timeout fails the run',
  async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},500)'
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    await new Promise((resolve) => child.stdout.once('data', resolve))
    const exited = new Promise((resolve) => child.on('exit', resolve))
    await assert.rejects(
      stopWithTimeout(child, exited, 300),
      (e) => e instanceof MeasurementFailure
    )
    await exited
  }
)

await proof(
  'a page carrying script inside its HTML, including an event-handler attribute, is detected',
  async () => {
    assert(
      findInlineScripts('<html><script>alert(1)</script></html>', 'p.html')
        .length > 0,
      'inline script tag'
    )
    assert(
      findInlineScripts('<html><div onclick="x()"></div></html>', 'p.html')
        .length > 0,
      'event-handler attribute'
    )
    assert.equal(
      findInlineScripts('<html><script src="/a.js"></script></html>', 'p.html')
        .length,
      0,
      'clean page passes'
    )
  }
)

await proof('dropping one capture among many fails the run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fx-drop-'))
  writeFileSync(
    join(dir, 'captures.index'),
    'a.json\tpage.close\nb.json\tpage.close\nc.json\tpage.close\n'
  )
  writeFileSync(join(dir, 'a.json'), '{"entries":[]}')
  writeFileSync(join(dir, 'b.json'), '{"entries":[]}')
  assert.throws(
    () => validateBrowserDir(dir),
    (e) => e instanceof MeasurementFailure && e.message.includes('c.json')
  )
})

console.log(results.join('\n'))
console.log(
  `${results.filter((r) => r.startsWith('ok')).length}/${results.length} fixture proofs passed`
)
