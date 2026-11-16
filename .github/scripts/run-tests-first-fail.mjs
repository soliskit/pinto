// Prototype v2: fail-closed first-fail wrapper with a durable per-invocation
// ledger. NOT for publication. Local disposable safety prototype only.
//
// Binding: Stryker 10.1.1 commandRunner sets __STRYKER_ACTIVE_MUTANT__=<id>
// per mutant run (pinned: command-test-runner.ts run()); the dry run inherits
// ambient env (no variable) -> labeled __dry_run__.
//
// Ledger (FIRST_FAIL_LEDGER_DIR, default ./reports/first-fail-ledger):
// Invocation: node wrapper-v2.mjs -- <verbatim node --test args>
//   <invocationId>.start.json    written atomically BEFORE spawn
//   <invocationId>.terminal.json written atomically at a deliberate exit
//   <invocationId>.hb.json       heartbeat, rewritten every 1s while alive
// A terminal record with clean=true is written ONLY when every wrapper-owned
// step succeeded: reporter pre-import, spawn, READY handshake, drain, and
// process-group cleanup confirmation. Any wrapper-owned failure -> clean=false
// + exit 2 (shard must BLOCK). Ambiguous child exits (nonzero/signal with no
// fatal test event) -> clean=false + exit 2: this deliberately blocks genuine
// mutant crashes whose cause is unclear (a deliberate, visible limitation).
// Stryker's timeout SIGKILL leaves START + heartbeat only.
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, renameSync, accessSync, constants } from 'node:fs'

// Usage: node wrapper-v2.mjs -- <node --test arguments verbatim, incl. test files>
// Everything after `--` is forwarded to `node --test` untouched, so the
// calling command owns the baseline flags (Pinto: --test-timeout=120000).
const sep = process.argv.indexOf('--')
const files = sep >= 0 ? process.argv.slice(sep + 1) : []
if (files.length === 0) {
  console.error('wrapper-v2: expected `--` followed by the node --test arguments (baseline flags + test files)')
  process.exit(2)
}

const mutantId = process.env.__STRYKER_ACTIVE_MUTANT__ ?? '__dry_run__'
const runId = process.env.FIRST_FAIL_RUN_ID ?? null
const shard = process.env.FIRST_FAIL_SHARD ?? 'unknown-shard'
const head = process.env.GITHUB_SHA ?? 'unknown-head'
const ledgerDir = process.env.FIRST_FAIL_LEDGER_DIR ?? join(process.cwd(), 'reports', 'first-fail-ledger')
mkdirSync(ledgerDir, { recursive: true })
const invocationId = randomUUID()
const t0 = Date.now()

const atomicWrite = (name, obj) => {
  const tmp = join(ledgerDir, `${name}.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, join(ledgerDir, name))
}

const base = () => ({
  invocationId,
  runId,
  mutantId,
  shard,
  head,
  pid: process.pid,
  node: process.version
})

// START before spawn: a terminal-only ledger cannot prove an invocation existed.
atomicWrite(`${invocationId}.start.json`, { ...base(), kind: 'start', startedAt: new Date(t0).toISOString(), startedMs: t0, argv: files })



let heartbeat = null
const failClosed = (error, extra = {}) => {
  clearInterval(heartbeat)
  try {
    atomicWrite(`${invocationId}.terminal.json`, { ...base(), kind: 'terminal', clean: false, error, endedAt: new Date().toISOString(), wallMs: Date.now() - t0, ...extra })
  } catch { /* nothing more we can do */ }
  console.error(`wrapper-v2: fail-closed: ${error}`)
  process.exit(2)
}

if (!runId) failClosed('missing-run-id', { detail: 'FIRST_FAIL_RUN_ID not set; invocation cannot be bound to a report' })

// Pre-spawn wrapper-owned validation: reporter file must exist and import.
const reporter = process.env.FIRST_FAIL_REPORTER_OVERRIDE ?? fileURLToPath(new URL('./reporter-v2.mjs', import.meta.url))
try {
  accessSync(reporter, constants.R_OK)
} catch (err) {
  failClosed('reporter-unreadable', { detail: err.message })
}
try {
  await import(reporter)
} catch (err) {
  failClosed('reporter-import', { detail: err.message })
}

const nodeBin = process.env.FIRST_FAIL_NODE_OVERRIDE ?? process.execPath
const child = spawn(
  nodeBin,
  [
    '--test',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    `--test-reporter=${reporter}`,
    `--test-reporter-destination=${join(tmpdir(), `first-fail-reporter-${process.pid}.log`)}`,
    ...files
  ],
  { detached: true, stdio: ['ignore', 'pipe', 'inherit', 'pipe'] }
)

let done = false
let handshake = false
let fatal = null
let childExit = null
let childExited = false

const hbName = `${invocationId}.hb.json`
// Liveness of the direct child (node --test): /proc state, excluding zombies.
const pidAlive = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
    return state !== 'Z' && state !== 'X'
  } catch {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}
heartbeat = setInterval(() => {
  try {
    atomicWrite(hbName, { ...base(), kind: 'heartbeat', at: Date.now(), childAlive: childExited ? false : pidAlive(child.pid) })
  } catch { /* best effort */ }
}, 1000)

// /proc-based group liveness: zombie group members still answer signal-0
// probes, and reap timing after reparenting is init-dependent, so scan for
// LIVE (non-zombie) members of the group instead.
const liveGroupMembers = (pgid) => {
  try {
    const members = []
    for (const ent of readdirSync('/proc')) {
      if (!/^\d+$/.test(ent)) continue
      try {
        const stat = readFileSync(`/proc/${ent}/stat`, 'utf8')
        const rparen = stat.lastIndexOf(')')
        const fields = stat.slice(rparen + 2).split(' ')
        const state = fields[0]
        const pgrp = Number(fields[2])
        if (pgrp === pgid && state !== 'Z' && state !== 'X') members.push(`${ent}:${state}`)
      } catch {
        // /proc entry vanished between readdir and read: the child is gone
      }
    }
    return members
  } catch {
    return null // no /proc: caller falls back to kill probe
  }
}

const groupDead = async (ms) => {
  if (process.env.FIRST_FAIL_FAKE_CLEANUP_FAIL) return false
  const until = Date.now() + ms
  let lastMembers = null
  while (Date.now() < until) {
    const members = liveGroupMembers(child.pid)
    if (members !== null) {
      lastMembers = members
      if (members.length === 0 && childExited) return true
    } else {
      try {
        process.kill(-child.pid, 0)
        lastMembers = ['probe-alive']
      } catch (err) {
        if (err.code === 'ESRCH' && childExited) return true
        lastMembers = [err.code]
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  console.error(`wrapper-v2: cleanup probe ended childExited=${childExited} members=${JSON.stringify(lastMembers)}`)
  return false
}
const killGroup = () => {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch { /* already gone */ }
}

const drainChild = () =>
  new Promise((resolve) => {
    if (child.stdout.readableEnded) return resolve(false)
    child.stdout.on('end', () => resolve(false))
    setTimeout(() => resolve(true), 2000)
  })

const settle = async ({ mode, exitCode, clean, error, fatalTest }) => {
  if (done) return
  done = true
  clearInterval(heartbeat)
  const drainTimedOut = await drainChild()
  if (child.pid && !childExited) killGroup() // idempotent; covers non-fatal paths too
  const cleanupOk = child.pid ? await groupDead(3000) : true
  const finalClean = clean && cleanupOk
  atomicWrite(`${invocationId}.terminal.json`, {
    ...base(),
    kind: 'terminal',
    clean: finalClean,
    mode,
    error: cleanupOk ? (error ?? null) : 'cleanup-unconfirmed',
    childExit,
    drainTimedOut,
    handshake,
    fatalTest: fatalTest ?? null,
    endedAt: new Date().toISOString(),
    wallMs: Date.now() - t0
  })
  if (process.stdout.writableNeedDrain) await new Promise((resolve) => process.stdout.once('drain', resolve))
  process.exit(finalClean ? exitCode : 2)
}

child.on('error', (err) => {
  settle({ mode: 'spawn-failure', exitCode: 2, clean: false, error: `spawn: ${err.message}` })
})

// fd 3 protocol: READY, then FIRST-FAIL <json>.
const control = child.stdio[3]
control.setEncoding('utf8')
let buf = ''
control.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (line === 'READY') {
      handshake = true
    } else if (line.startsWith('FIRST-FAIL')) {
      if (fatal) continue
      let name = null
      try {
        name = JSON.parse(line.slice('FIRST-FAIL'.length).trim())
      } catch { /* name is diagnostic only */ }
      fatal = name ?? true
      console.error('wrapper-v2: first fatal test failure; stopping the run')
      killGroup()
      settle({ mode: 'stopped-at-first-failure', exitCode: 1, clean: true, fatalTest: fatal })
    }
  }
})

child.stdout.pipe(process.stdout)

if (process.env.FIRST_FAIL_DEBUG_THROW_MS) {
  setTimeout(() => {
    throw new Error('debug throw hook')
  }, Number(process.env.FIRST_FAIL_DEBUG_THROW_MS))
}

child.on('exit', (code, signal) => {
  childExit = { code, signal }
  childExited = true
  if (done) return
  if (fatal) return // fatal path owns settlement
  if (code === 0 && handshake) {
    settle({ mode: 'all-passed', exitCode: 0, clean: true })
  } else if (code === 0 && !handshake) {
    settle({ mode: 'missing-handshake', exitCode: 2, clean: false, error: 'child exited 0 without reporter READY: fail-fast protection unproven' })
  } else {
    // Ambiguous: mutant crash vs runner/wrapper infra. Conservative BLOCK.
    settle({ mode: handshake ? 'unclassified-child-exit' : 'pre-handshake-exit', exitCode: 2, clean: false, error: `child exited code=${code} signal=${signal} with no fatal test event` })
  }
})

const exceptionShutdown = (kind, err) => {
  try {
    if (child?.pid) killGroup()
  } catch { /* best effort */ }
  failClosed(kind, { detail: err?.message ?? String(err) })
}
process.on('uncaughtException', (err) => exceptionShutdown('uncaught', err))
process.on('unhandledRejection', (err) => exceptionShutdown('unhandled-rejection', err))
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    killGroup()
    settle({ mode: 'signal-received', exitCode: 2, clean: false, error: sig })
  })
}
