// Two isolated measurement-only proofs for synchronous submit navigation.
// Uses the pinned preload and converter, not production app scenarios.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import libCoverage from 'istanbul-lib-coverage'
import { mergeV8Entries } from '../v8merge.mjs'
import { toFileCoverage } from '../convert.mjs'
import { validateBrowserDir } from '../validate.mjs'
const here = fileURLToPath(new URL('.', import.meta.url))
const results = []
async function proof(name, fn) {
  try {
    await fn()
    results.push(`ok - ${name}`)
  } catch {
    results.push(`FAIL - ${name}`)
    process.exitCode = 1
  }
}
const lineHits = (cov) => libCoverage.createFileCoverage(cov).getLineCoverage()
function tempScript(name, content) {
  const abs = join(mkdtempSync(join(tmpdir(), 'fx-js-')), name)
  writeFileSync(abs, content)
  return abs
}

// Regression proposal: exercise the real preload at the event that navigates.
// This is deliberately not a production app scenario or a coverage exemption.
for (const fixtureMode of ['click', 'enter'])
  await proof(
    `synchronous ${fixtureMode} submit navigation preserves callback and helper credit`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fx-submit-nav-'))
      const child = join(here, '.child-submit-nav.mjs')
      const src = [
        'function submitted() {',
        '  window.__submitted = true',
        '}',
        'document.querySelector("form").addEventListener("submit", (event) => {',
        '  event.preventDefault()',
        '  submitted()',
        '  location.assign("/next")',
        '})',
        ''
      ].join('\n')
      writeFileSync(
        child,
        `
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
const src = ${JSON.stringify(src)}
const server = createServer((req, res) => {
  if (req.url === '/event.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(src)
  } else if (req.url === '/p') {
    res.end('<form><input name="x"><button>Go</button></form><script src="/event.js"></script>')
  } else res.end('<p>Next</p>')
})
await new Promise((resolve) => server.listen(0, resolve))
const base = 'http://localhost:' + server.address().port
const browser = await chromium.launch()
try {
  for (const mode of [process.env.FIXTURE_MODE]) {
    const page = await browser.newPage()
    try {
      await page.goto(base + '/p')
      if (mode === 'click') await page.click('button')
      else await page.press('input', 'Enter')
      await page.waitForURL(base + '/next')
      assert.equal(page.url(), base + '/next')
    } finally { await page.close() }
  }
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)) }
`
      )
      try {
        await new Promise((resolve, reject) => {
          const proc = spawn(
            'timeout',
            [
              '--signal=TERM',
              '--kill-after=5s',
              '90s',
              process.execPath,
              child
            ],
            {
              detached: true,
              cwd: join(here, '..', '..'),
              env: {
                ...process.env,
                PINTO_MEASURE: '1',
                PINTO_MEASURE_DIR: dir,
                FIXTURE_MODE: fixtureMode,
                NODE_OPTIONS: `--import ${join(here, '..', 'browser-preload.mjs')}`
              },
              stdio: 'ignore'
            }
          )
          let settled = false
          function finish(error) {
            if (settled) return
            settled = true
            clearTimeout(watchdog)
            // Best effort on all outcomes. Host container teardown is the final
            // authority for Chromium descendants that create their own groups.
            try {
              process.kill(-proc.pid, 'SIGKILL')
            } catch {
              // The process group may already be gone; the container receipt is authoritative.
            }
            if (error) reject(error)
            else resolve()
          }
          const watchdog = setTimeout(
            () => finish(new Error('child cleanup deadline exceeded')),
            100_000
          )
          proc.once('exit', (code, signal) =>
            finish(
              code === 0
                ? undefined
                : new Error(`child exited ${code}/${signal}`)
            )
          )
          proc.once('error', (error) => finish(error))
        })
      } finally {
        rmSync(child, { force: true })
      }
      const entries = validateBrowserDir(join(dir, 'browser')).filter(
        (entry) => new URL(entry.url).pathname === '/event.js'
      )
      assert(entries.length > 0, 'event script was not captured')
      const abs = tempScript('event.js', src)
      const merged = mergeV8Entries(
        entries.map((entry) => ({
          url: '/event.js',
          source: entry.source,
          functions: entry.functions
        }))
      )
      const cov = await toFileCoverage(merged.get('/event.js'), abs)
      const lines = lineHits(cov)
      assert(
        lines[2] > 0,
        'helper body must be credited after synchronous navigation'
      )
      assert(
        lines[5] > 0,
        'submit callback must be credited after synchronous navigation'
      )
      assert(
        lines[6] > 0,
        'helper call must be credited after synchronous navigation'
      )
      assert(lines[7] > 0, 'navigation statement must be credited')
      const helper = Object.entries(cov.fnMap).find(
        ([, fn]) => fn.name === 'submitted'
      )
      assert(
        helper && cov.f[helper[0]] > 0,
        'named helper function must be credited'
      )
    }
  )

for (const [index, result] of results.entries())
  console.log(
    (index === 0 ? 'click=' : 'enter=') +
      (result.startsWith('ok -') ? 'pass' : 'fail')
  )
if (results.length !== 2) process.exitCode = 1
