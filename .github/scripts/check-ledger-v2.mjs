// Prototype v2.1: fail-closed ledger checker. Verifies wrapper evidence OUTSIDE
// Stryker before a shard's mutation report may count. GATE AFTER RAW REPORT:
// Stryker's verdicts are generated as-is; this checker only decides acceptance.
//
//   node check-ledger-v2.mjs --ledger <dir> --report <mutation.json> --shard <name> --head <sha>
//
// Policy (every BLOCK names its reason; exit 0 pass / 1 block):
//   - ledger dir missing/unreadable, malformed/schema-invalid records -> BLOCK
//     (kind/invocationId/mutantId/pid/node always required; start: finite
//     startedMs; terminal: strictly boolean clean + mode; heartbeat: finite at
//     + strictly boolean childAlive)
//   - every record must bind to --shard/--head -> else BLOCK
//   - report must echo FIRST_FAIL_SHARD=<shard> and GITHUB_SHA=<head> in
//     config.commandRunner.command -> else BLOCK (anti-staleness binding;
//     NOT tamper-proof against a forged report - documented limitation)
//   - dry run: exactly one __dry_run__ invocation, terminal clean mode=all-passed
//   - Killed id: START + terminal clean mode=stopped-at-first-failure, same
//     invocation AND terminal.mutantId === id
//   - Survived id: START + terminal clean mode=all-passed, same invocation AND
//     terminal.mutantId === id
//   - Timeout id: START, NO terminal, and heartbeat alive near the kill
//     (last heartbeat at >= startedMs + report duration - 3000ms slack) with
//     childAlive === true. A terminal record on a Timeout id, a stale
//     heartbeat, or a dead-child heartbeat -> BLOCK (race-aware; no guessing)
//   - Ignored id with any record -> BLOCK
//   - orphan records: any terminal/heartbeat whose invocationId no START
//     claims -> BLOCK; any start for an unknown mutant id -> BLOCK
//   - each runnable id: exactly one START; duplicates -> BLOCK
//   - duplicate terminal or heartbeat per invocation -> BLOCK
//   - unknown report status (NoCoverage, ...) -> BLOCK (no weaker acceptance)
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}
const ledgerDir = opt('--ledger')
const reportPath = opt('--report')
const shard = opt('--shard')
const head = opt('--head')
const expectedRunId = opt('--run-id')
if (!ledgerDir || !reportPath || !shard || !head) {
  console.error('usage: check-ledger-v2.mjs --ledger <dir> --report <mutation.json> --shard <name> --head <sha> --run-id <expected>')
  process.exit(2)
}

const blocks = []
const block = (reason) => blocks.push(reason)

if (!existsSync(ledgerDir)) block(`ledger directory missing: ${ledgerDir}`)
let report
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'))
} catch (err) {
  block(`report unreadable: ${err.message}`)
}
if (blocks.length) {
  for (const b of blocks) console.error(`BLOCK: ${b}`)
  process.exit(1)
}

// Report <-> invocation binding: the wrapper command in the Stryker config
// echoes shard/head, and Stryker records the config in the report.
const cmd = report?.config?.commandRunner?.command
if (typeof cmd !== 'string' || !cmd.includes(`FIRST_FAIL_SHARD=${shard}`) || !cmd.includes(`GITHUB_SHA=${head}`)) {
  block(`report not bound to shard/head: config.commandRunner.command ${typeof cmd === 'string' ? 'does not echo the FIRST_FAIL_SHARD/GITHUB_SHA flags' : 'is missing'}`)
}
const runIdMatch = typeof cmd === 'string' ? cmd.match(/FIRST_FAIL_RUN_ID=(\S+)/) : null
const reportRunId = runIdMatch ? runIdMatch[1] : null
if (!reportRunId) block('report not bound to a run: config.commandRunner.command carries no FIRST_FAIL_RUN_ID')
// External expectation: the caller (CI) names the run it expects. Mutual
// ledger<->report consistency alone cannot catch a consistently STALE pair.
if (!expectedRunId) block('no expected run identity supplied (--run-id required; refusing to qualify without an external anchor)')
else if (reportRunId && reportRunId !== expectedRunId) block(`report run ${reportRunId} != expected run ${expectedRunId} (stale or foreign report)`)

const mutants = []
for (const f of Object.keys(report.files ?? {})) {
  for (const m of report.files[f].mutants ?? []) mutants.push(m)
}
if (mutants.length === 0) block('report contains no mutants - vacuous qualification (nothing was tested)')
const byId = new Map(mutants.map((m) => [String(m.id), m]))

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isNonEmptyStr = (v) => typeof v === 'string' && v.length > 0
const KINDS = new Set(['start', 'terminal', 'heartbeat'])

const records = []
for (const name of readdirSync(ledgerDir)) {
  if (!name.endsWith('.json') || name.endsWith('.tmp')) continue
  let rec
  try {
    rec = JSON.parse(readFileSync(join(ledgerDir, name), 'utf8'))
  } catch (err) {
    block(`malformed record ${name}: ${err.message}`)
    continue
  }
  const bad = (why) => block(`record ${name}: ${why}`)
  if (typeof rec !== 'object' || rec === null) { bad('not an object'); continue }
  if (!KINDS.has(rec.kind)) { bad(`unknown kind ${rec.kind}`); continue }
  if (!isNonEmptyStr(rec.invocationId)) { bad('missing/invalid invocationId'); continue }
  if (!isNonEmptyStr(rec.mutantId)) { bad('missing/invalid mutantId'); continue }
  if (!isNonEmptyStr(rec.runId)) { bad('missing/invalid runId'); continue }
  if (reportRunId && rec.runId !== reportRunId) { bad(`runId ${rec.runId} != report run ${reportRunId} (stale/foreign ledger or report)`); continue }
  if (rec.shard !== shard) { bad(`shard ${rec.shard} != ${shard}`); continue }
  if (rec.head !== head) { bad('head mismatch'); continue }
  if (!isFiniteNum(rec.pid)) { bad('missing/invalid pid'); continue }
  if (!isNonEmptyStr(rec.node)) { bad('missing/invalid node'); continue }
  if (rec.kind === 'start') {
    if (!isFiniteNum(rec.startedMs)) { bad('missing/invalid startedMs'); continue }
  } else if (rec.kind === 'terminal') {
    if (typeof rec.clean !== 'boolean') { bad('clean not strictly boolean'); continue }
    if (!isNonEmptyStr(rec.mode)) { bad('missing/invalid mode'); continue }
    if (rec.clean && rec.mode !== 'all-passed' && rec.mode !== 'stopped-at-first-failure') {
      bad(`clean terminal with unexpected mode ${rec.mode}`); continue
    }
  } else if (rec.kind === 'heartbeat') {
    if (!isFiniteNum(rec.at)) { bad('missing/invalid at'); continue }
    if (typeof rec.childAlive !== 'boolean') { bad('missing/invalid childAlive'); continue }
  }
  records.push({ name, rec })
}

const starts = new Map() // mutantId -> [rec]
const terminals = new Map() // invocationId -> rec
const heartbeats = new Map() // invocationId -> rec
for (const { rec } of records) {
  if (rec.kind === 'start') {
    const list = starts.get(rec.mutantId) ?? []
    list.push(rec)
    starts.set(rec.mutantId, list)
  } else if (rec.kind === 'terminal') {
    if (terminals.has(rec.invocationId)) block(`duplicate terminal for ${rec.invocationId}`)
    terminals.set(rec.invocationId, rec)
  } else if (rec.kind === 'heartbeat') {
    if (heartbeats.has(rec.invocationId)) block(`duplicate heartbeat for ${rec.invocationId}`)
    heartbeats.set(rec.invocationId, rec)
  }
}

// Orphan starts (unknown mutant ids)
for (const id of starts.keys()) {
  if (id !== '__dry_run__' && !byId.has(id)) block(`orphan start record for unknown mutant id ${id}`)
}

// Dry run accounting
const dryStarts = starts.get('__dry_run__') ?? []
if (dryStarts.length !== 1) block(`expected exactly 1 dry-run start, found ${dryStarts.length}`)
else {
  const t = terminals.get(dryStarts[0].invocationId)
  if (!t) block('dry run: no terminal record')
  else if (t.mutantId !== '__dry_run__') block(`dry run: terminal names mutant ${t.mutantId}`)
  else if (!t.clean || t.mode !== 'all-passed') block(`dry run: terminal not clean all-passed (clean=${t.clean} mode=${t.mode} error=${t.error})`)
}

// Every terminal/heartbeat must be claimed by exactly one known START
const claimed = new Set()
for (const list of starts.values()) for (const s of list) claimed.add(s.invocationId)

// Per-mutant accounting
for (const m of mutants) {
  const id = String(m.id)
  const status = m.status
  const s = starts.get(id) ?? []
  if (status === 'Ignored') {
    if (s.length) block(`Ignored mutant ${id} has ${s.length} start record(s)`)
    continue
  }
  if (s.length !== 1) {
    block(`mutant ${id} (${status}): expected exactly 1 start, found ${s.length}`)
    continue
  }
  const start = s[0]
  const t = terminals.get(start.invocationId)
  if (status === 'Killed') {
    if (!t) block(`Killed ${id}: no terminal record (wrapper crash reads as Killed under Stryker)`)
    else if (t.mutantId !== id) block(`Killed ${id}: terminal names mutant ${t.mutantId} on the same invocation`)
    else if (!t.clean) block(`Killed ${id}: terminal not clean (mode=${t.mode} error=${t.error})`)
    else if (t.mode !== 'stopped-at-first-failure') block(`Killed ${id}: unexpected mode ${t.mode}`)
  } else if (status === 'Survived') {
    if (!t) block(`Survived ${id}: no terminal record`)
    else if (t.mutantId !== id) block(`Survived ${id}: terminal names mutant ${t.mutantId} on the same invocation`)
    else if (!t.clean) block(`Survived ${id}: terminal not clean (mode=${t.mode} error=${t.error})`)
    else if (t.mode !== 'all-passed') block(`Survived ${id}: unexpected mode ${t.mode}`)
  } else if (status === 'Timeout') {
    if (t) block(`Timeout ${id}: terminal record present - cannot positively match external kill (race), blocking`)
    const hb = heartbeats.get(start.invocationId)
    const duration = isFiniteNum(m.duration) ? m.duration : null
    if (!hb) block(`Timeout ${id}: no heartbeat - wrapper aliveness at cutoff unproven`)
    else if (hb.mutantId !== id) block(`Timeout ${id}: heartbeat names mutant ${hb.mutantId} on the same invocation`)
    else if (duration === null) block(`Timeout ${id}: report carries no numeric duration`)
    else if (hb.childAlive !== true) block(`Timeout ${id}: heartbeat shows child dead before the cutoff - wrapper alive but tests not running`)
    else if (hb.at < start.startedMs + duration - 3000) block(`Timeout ${id}: heartbeat stopped ${start.startedMs + duration - hb.at}ms before cutoff - wrapper died early`)
  } else {
    block(`mutant ${id}: unhandled status ${status}`)
  }
}

// Orphan terminals/heartbeats (unclaimed invocation ids)
for (const [inv, t] of terminals) {
  if (!claimed.has(inv)) block(`orphan terminal record: invocation ${inv} has no start (mutant ${t.mutantId}, clean=${t.clean} error=${t.error ?? 'null'})`)
}
for (const [inv, h] of heartbeats) {
  if (!claimed.has(inv)) block(`orphan heartbeat record: invocation ${inv} has no start (mutant ${h.mutantId})`)
}

if (blocks.length) {
  for (const b of blocks) console.error(`BLOCK: ${b}`)
  console.error(`RESULT: BLOCK (${blocks.length} reason(s))`)
  process.exit(1)
}
console.log(`RESULT: PASS (${mutants.length} mutants, ${starts.size} invocations bound)`)
