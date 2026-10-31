// Pinto's measurement runner. Measures the existing tests only: it spawns the
// suites with the measurement preloads active, validates every report, merges
// coverage keyed to path plus content, converts with the converter Tetris
// uses and prints exact covered/total counts per pipeline. Raw reports are
// kept unfiltered under the run directory. Nothing here runs outside
// measurement, and the existing checks behave exactly as today.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserFiles, root, serverFiles, thirdPartyFiles, readFile } from './filelists.mjs'
import { mergeV8Entries, uncovered } from './v8merge.mjs'
import { toFileCoverage, summarize } from './convert.mjs'
import { MeasurementFailure, checkNavigationCoverage, validateBrowserDir, validateServerDir } from './validate.mjs'
import { checkLockfile, checkPages, checkServedScripts } from './checks.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const suite = args.includes('--slow') ? 'slow' : 'fast'
const outDir = args[args.indexOf('--out') + 1] || mkdtempSync(join(tmpdir(), 'pinto-measure-'))
const TIMEOUT_MS = 20 * 60 * 1000

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' }).trim()
}

function runSuite() {
  const pattern = suite === 'slow' ? 'test/slow/*.test.ts' : 'test/*.test.ts'
  const env = {
    ...process.env,
    PINTO_MEASURE: '1',
    PINTO_MEASURE_DIR: outDir,
    NODE_V8_COVERAGE: join(outDir, 'server'),
    NODE_OPTIONS: [
      `--import ${join(here, 'server-preload.mjs')}`,
      `--import ${join(here, 'browser-preload.mjs')}`,
      process.env.NODE_OPTIONS || ''
    ].join(' ')
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-timeout=120000', pattern],
      { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'], shell: false }
    )
    const killer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new MeasurementFailure(`suite exceeded ${TIMEOUT_MS / 60000} minutes; run failed, no numbers produced`))
    }, TIMEOUT_MS)
    child.on('exit', (code) => {
      clearTimeout(killer)
      if (code === 0) resolve()
      else reject(new MeasurementFailure(`${suite} suite exited ${code}; measurement run failed`))
    })
  })
}

// Starts a verification server without any coverage or preload, for page
// checks that must not add coverage to the measurement.
async function withVerificationServer(fn) {
  const { spawn: spawnRaw } = await import('node:child_process')
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawnRaw(process.execPath, ['src/index.ts'], {
    cwd: root,
    env: { ...process.env, KEY: '', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', (d) => (output += d))
  child.stderr.on('data', (d) => (output += d))
  const deadline = Date.now() + 15000
  while (!output.includes('Pinto listening')) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new MeasurementFailure('verification server never started. Output:\n' + output)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  try {
    await fn(`http://localhost:${port}`)
  } finally {
    child.kill('SIGKILL')
  }
}

const runStartedAt = Date.now()
mkdirSync(join(outDir, 'server'), { recursive: true })
mkdirSync(join(outDir, 'browser'), { recursive: true })

const commit = git('rev-parse', 'HEAD')
const appDiff = git('diff', '--name-only', 'HEAD', '--', 'src', 'public')
if (appDiff) {
  throw new MeasurementFailure(
    `application source differs from the pinned production commit ${commit}:\n${appDiff}`
  )
}

checkLockfile()
console.error(`measuring ${suite} suite at ${commit} into ${outDir}`)
await runSuite()

const serverEntries = validateServerDir(
  join(outDir, 'server'),
  runStartedAt,
  new Set(serverFiles().map((f) => f.url))
)
const browserCaptures = validateBrowserDir(join(outDir, 'browser'))
checkNavigationCoverage(join(outDir, 'browser'))

await withVerificationServer(checkPages)
checkServedScripts(browserCaptures)

// Server pipeline: source comes from disk (V8 reports carry no source), which
// the clean-tree check above ties to the pinned commit.
const serverMerged = mergeV8Entries(
  serverEntries.map((e) => ({ url: e.url, source: readFile(fileURLToPath(e.url)), functions: e.functions }))
)
// Suite servers listen on different ports; browser scripts key by path,
// with content identity still enforced across every load.
const browserMerged = mergeV8Entries(
  browserCaptures.map((e) => {
    try {
      return { ...e, url: new URL(e.url).pathname }
    } catch {
      return e
    }
  })
)

const files = []
for (const f of serverFiles()) {
  const merged = serverMerged.get(f.url)
  if (!merged) continue // never loaded: stays at 0% via the empty-file entry below
  files.push({ path: f.rel, coverage: await toFileCoverage(merged, f.abs) })
}
const own = new Map(browserFiles().map((f) => [f.servedPath, f]))
const browserByPath = new Map()
for (const [pathname, merged] of browserMerged) {
  const f = own.get(pathname)
  if (!f) continue
  if (browserByPath.has(pathname)) {
    throw new MeasurementFailure(`internal: duplicate merged browser entry for ${pathname}`)
  }
  browserByPath.set(pathname, f)
  files.push({ path: f.rel, coverage: await toFileCoverage(merged, f.abs) })
}
// Files on a list that never loaded count as 0%: give them an empty
// execution so the converter emits fully-uncovered counts.
for (const f of serverFiles()) {
  if (!files.some((x) => x.path === f.rel)) {
    files.push({ path: f.rel, coverage: await toFileCoverage(uncovered(f.url, readFile(f.abs)), f.abs) })
  }
}
for (const f of browserFiles()) {
  if (!files.some((x) => x.path === f.rel)) {
    files.push({ path: f.rel, coverage: await toFileCoverage(uncovered(f.rel, readFile(f.abs)), f.abs) })
  }
}

const summary = summarize(files)
const report = {
  repo: 'pinto',
  suite,
  commit,
  harnessRevision: git('status', '--porcelain') ? `${commit}+uncommitted` : commit,
  node: process.version,
  command: `node --test --test-timeout=120000 ${suite === 'slow' ? 'test/slow/*.test.ts' : 'test/*.test.ts'}`,
  fileListScope: {
    server: serverFiles().map((f) => f.rel),
    browser: browserFiles().map((f) => f.rel),
    thirdParty: thirdPartyFiles().map((f) => f.name)
  },
  runStartedAt: new Date(runStartedAt).toISOString(),
  files: summary
}
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))

for (const rel of [...report.fileListScope.server, ...report.fileListScope.browser]) {
  const s = summary[rel]
  if (!s) {
    console.log(`${rel}: not measured`)
    continue
  }
  console.log(
    s.functions.measurable === false
      ? `${rel}: lines ${s.lines.covered}/${s.lines.total}, branches ${s.branches.covered}/${s.branches.total}, functions n/a (no named functions reach the converter)`
      : `${rel}: lines ${s.lines.covered}/${s.lines.total}, branches ${s.branches.covered}/${s.branches.total}, functions ${s.functions.covered}/${s.functions.total}`
  )
}
console.log(`report: ${join(outDir, 'report.json')}`)
