// run-tests-first-fail.mjs <test files...>
//
// Runs `node --test` on the given files and stops the whole run at the first
// fatal test failure, then exits 1. A passing run runs to completion and
// exits 0, exactly like the plain command it replaces. Used as the Stryker
// command-runner command: Stryker reads only the exit code, so a mutant
// whose tests fail is reported killed either way - this wrapper just stops
// paying for the remaining test files once the verdict is decided.
//
// Fatal means "node --test would exit nonzero", detected structurally by
// first-fail-reporter.mjs on fd 3 (todo/skip do not count; expected-failure
// tests do, matching node --test's own exit code on 26.13.0). TAP "not ok"
// parsing was rejected: it cannot tell a todo failure from a real one. The
// visible reporter is spec - the same output the plain command produces in
// CI (verified: Node 26.13.0 defaults to spec even when piped).
//
// Teardown, in order of reliance:
//   1. On a fatal failure this wrapper SIGKILLs its detached process group
//      (the test runner, its browsers and servers).
//   2. On Stryker's own timeout, Stryker 10.1.1 kills the command with
//      tree-kill SIGKILL (objectUtils.kill), which enumerates and kills the
//      whole descendant tree, including this detached group. The wrapper's
//      own SIGTERM/SIGINT handlers are best-effort only and cannot run under
//      SIGKILL.
//   3. Browsers additionally self-exit when their CDP pipe closes after the
//      node processes die (observed locally: gone within ~2-3s).
//
// Every exit path drains the child's stdout first so diagnostics are not
// truncated by process.exit.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('run-tests-first-fail: no test files given')
  process.exit(2)
}

const reporter = fileURLToPath(new URL('./first-fail-reporter.mjs', import.meta.url))
const child = spawn(
  process.execPath,
  [
    '--test',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    `--test-reporter=${reporter}`,
    // Node requires one destination per reporter and fsyncs file
    // destinations, so the silent reporter needs a real file.
    `--test-reporter-destination=${join(tmpdir(), `first-fail-reporter-${process.pid}.log`)}`,
    '--test-timeout=120000',
    ...files
  ],
  { detached: true, stdio: ['ignore', 'pipe', 'inherit', 'pipe'] }
)

let done = false
const killGroup = () => {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}
const flushThenExit = (code) => {
  if (done) return
  done = true
  // Drain the child's stdout and our own before exiting so diagnostics are
  // not truncated by process.exit. Fast path: nothing left to flush.
  let exited = false
  const go = () => {
    if (exited) return
    if (!child.stdout.readableEnded) return
    if (process.stdout.writableNeedDrain) {
      process.stdout.once('drain', go)
      return
    }
    exited = true
    process.exit(code)
  }
  child.stdout.on('end', go)
  setTimeout(() => {
    exited = true
    process.exit(code)
  }, 1000)
  go()
}

// fd 3: the reporter's fatal-failure signal.
const control = child.stdio[3]
control.setEncoding('utf8')
control.on('data', () => {
  console.error('run-tests-first-fail: first fatal test failure; stopping the run')
  killGroup()
  flushThenExit(1)
})

child.stdout.pipe(process.stdout)

child.on('error', (err) => {
  console.error(`run-tests-first-fail: failed to launch node --test: ${err.message}`)
  flushThenExit(2)
})

child.on('exit', (code, signal) => {
  flushThenExit(signal ? 1 : (code ?? 1))
})

// Best-effort only; see the teardown note above. Stryker's timeout path is a
// tree-wide SIGKILL, which these handlers cannot intercept.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    killGroup()
    flushThenExit(1)
  })
}
