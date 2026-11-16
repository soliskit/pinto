// Paired-run equivalence gate for the first-fail experiment. Run from the
// repo root AT the paired head, after downloading both runs' artifacts and
// generating their manifests with make-run-manifest.mjs:
//
//   node .github/scripts/compare-mutation-reports.mjs \
//     --head <40-hex sha> --stryker <version> \
//     --counts '<{"shard": totalMutants}>' --runnable '<{"shard": runnableMutants}>' \
//     <controlDir> <firstFailDir> <shard...>
//
// Each dir holds one subdirectory per uploaded artifact, named
// mutation-report-<runId>-<attempt>-<mode>-<shard> and containing
// mutation.json at its root (upload-artifact flattens a single-file path),
// plus the generated run-manifest.json.
//
// The gate FAILS (exit 1) unless ALL hold:
//   - the CLI shard list has no duplicates;
//   - each dir contains EXACTLY one artifact per CLI shard and nothing else
//     matching the artifact naming pattern (unexpected artifacts fail);
//   - all artifacts in a dir come from one run and one attempt; the two dirs
//     come from different runs; artifact run ids and attempts match the
//     manifests, and each manifest's run_attempt matches its jobs' attempts;
//   - both manifests name exactly --head (40-hex), workflow path
//     .github/workflows/test.yml and --stryker, with command_mode control vs
//     first-fail; their source_hashes equal the sha256 of the workflow file,
//     package.json and mutation-ranges.json in THIS checkout;
//   - every manifest job conclusion is "success" (job success implies the
//     dry run, Stryker run and in-job report verifier all passed);
//   - each shard's reports name exactly the shard's target file from
//     .github/mutation-ranges.json, hold exactly --counts[shard] mutants,
//     share the same mutant identities (mutator|start-end|replacement, the
//     verifier's identity basis over location.start/end), and agree on every
//     mutant's status;
//   - each control report has at least one Killed (mirrors the in-job gate).
// A missing artifact, report or manifest is a failure, never a pass.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  if (i === -1 || i + 1 >= args.length) {
    console.error(`missing required option ${name}`)
    process.exit(2)
  }
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const expectedHead = opt('--head')
const expectedStryker = opt('--stryker')
const expectedCounts = JSON.parse(opt('--counts'))
const expectedRunnable = JSON.parse(opt('--runnable'))
const [controlDir, wrapperDir, ...shards] = args
if (!controlDir || !wrapperDir || shards.length === 0) {
  console.error('Usage: compare-mutation-reports.mjs --head <sha> --stryker <ver> --counts <json> --runnable <json> <controlDir> <firstFailDir> <shard...>')
  process.exit(2)
}
const fail = (msg) => {
  console.error(`NOT EQUIVALENT: ${msg}`)
  process.exit(1)
}
if (!/^[0-9a-f]{40}$/.test(expectedHead)) fail(`--head must be a full 40-hex commit sha`)
if (new Set(shards).size !== shards.length) fail('duplicate shard names on the command line')
const localHead = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
if (localHead !== expectedHead) {
  fail(`this checkout is at ${localHead}, not ${expectedHead} - run the comparison at the paired head`)
}
const countMap = (label, map) => {
  const keys = Object.keys(map)
  if (keys.length !== shards.length || !shards.every((s) => keys.includes(s))) {
    fail(`${label} must name exactly the CLI shards (${shards.join(', ')})`)
  }
  for (const [k, v] of Object.entries(map)) {
    if (!Number.isInteger(v) || v <= 0) fail(`${label}[${k}] must be a positive integer`)
  }
}
countMap('--counts', expectedCounts)
countMap('--runnable', expectedRunnable)

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const localHashes = {
  workflow: sha256('.github/workflows/test.yml'),
  package_json: sha256('package.json'),
  mutation_ranges: sha256('.github/mutation-ranges.json')
}

const matrix = JSON.parse(readFileSync('.github/mutation-ranges.json', 'utf8'))
const shardFile = new Map()
for (const name of shards) {
  const entry = matrix.include.find((s) => s.shard === name)
  if (!entry) fail(`unknown shard "${name}" (not in .github/mutation-ranges.json at this checkout)`)
  shardFile.set(name, entry.mutate.split(':')[0])
}

const load = (dir, mode) => {
  const artifacts = new Map()
  for (const entry of readdirSync(dir)) {
    const m = /^mutation-report-(\d+)-(\d+)-(control|first-fail)-(.+)$/.exec(entry)
    if (!m) {
      if (entry.startsWith('mutation-report-')) fail(`${dir}: unparseable artifact name ${entry}`)
      continue
    }
    const [, runId, attempt, artifactMode, shard] = m
    if (artifactMode !== mode) fail(`${dir}: artifact ${entry} has mode ${artifactMode}, expected ${mode}`)
    if (!shardFile.has(shard)) fail(`${dir}: unexpected artifact for shard ${shard}`)
    if (artifacts.has(shard)) fail(`${dir}: duplicate artifact for shard ${shard}`)
    const reportPath = join(dir, entry, 'mutation.json')
    if (!existsSync(reportPath)) fail(`${dir}: artifact ${entry} has no mutation.json at its root`)
    artifacts.set(shard, { runId, attempt, report: JSON.parse(readFileSync(reportPath, 'utf8')) })
  }
  for (const shard of shardFile.keys()) if (!artifacts.has(shard)) fail(`${dir}: missing artifact for shard ${shard}`)
  const runIds = new Set([...artifacts.values()].map((a) => a.runId))
  const attempts = new Set([...artifacts.values()].map((a) => a.attempt))
  if (runIds.size !== 1) fail(`${dir}: artifacts span multiple runs (${[...runIds].join(', ')})`)
  if (attempts.size !== 1) fail(`${dir}: artifacts span multiple attempts (${[...attempts].join(', ')})`)

  const manifestPath = join(dir, 'run-manifest.json')
  if (!existsSync(manifestPath)) fail(`${dir}: missing run-manifest.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (String(manifest.run_id) !== [...runIds][0]) fail(`${dir}: manifest run_id ${manifest.run_id} != artifact run ${[...runIds][0]}`)
  if (String(manifest.run_attempt) !== [...attempts][0]) {
    fail(`${dir}: manifest run_attempt ${manifest.run_attempt} != artifact attempt ${[...attempts][0]}`)
  }
  if (manifest.command_mode !== mode) fail(`${dir}: manifest command_mode ${manifest.command_mode}, expected ${mode}`)
  if (manifest.head_sha !== expectedHead) fail(`${dir}: manifest head_sha ${manifest.head_sha} != expected ${expectedHead}`)
  if (manifest.workflow_path !== '.github/workflows/test.yml') fail(`${dir}: unexpected workflow path ${manifest.workflow_path}`)
  if (manifest.stryker_version !== expectedStryker) fail(`${dir}: manifest stryker_version ${manifest.stryker_version} != expected ${expectedStryker}`)
  for (const key of ['workflow', 'package_json', 'mutation_ranges']) {
    if (manifest.source_hashes?.[key] !== localHashes[key]) {
      fail(`${dir}: manifest ${key} hash does not match this checkout - run the comparison at the paired head`)
    }
  }
  for (const shard of shardFile.keys()) {
    const job = manifest.jobs?.[shard]
    if (!job) fail(`${dir}: manifest has no job entry for shard ${shard}`)
    if (job.conclusion !== 'success') fail(`${dir}: job for shard ${shard} concluded "${job.conclusion}"`)
    if (String(job.attempt) !== [...attempts][0]) fail(`${dir}: job attempt for ${shard} (${job.attempt}) != run attempt ${[...attempts][0]}`)
  }
  return { artifacts, manifest }
}

const KNOWN_STATUSES = new Set(['Killed', 'Survived', 'Timeout', 'NoCoverage', 'CompileError', 'RuntimeError', 'Ignored'])
const keyOf = (m) =>
  `${m.mutatorName}|${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column}|${m.replacement ?? ''}`
const statusMap = (report, shard) => {
  const files = Object.keys(report.files ?? {})
  const expectedFile = shardFile.get(shard)
  if (files.length !== 1 || files[0] !== expectedFile) {
    fail(`${shard}: report names files [${files.join(', ')}], expected exactly ${expectedFile}`)
  }
  const map = new Map()
  for (const m of report.files[expectedFile].mutants ?? []) {
    if (!KNOWN_STATUSES.has(m.status)) fail(`${shard}: unrecognized mutant status "${m.status}" (${m.mutatorName} at ${m.location.start.line})`)
    const k = keyOf(m)
    if (map.has(k)) fail(`${shard}: duplicate mutant identity in a report: ${k}`)
    map.set(k, m.status)
  }
  if (map.size !== expectedCounts[shard]) {
    fail(`${shard}: report holds ${map.size} mutants, expected ${expectedCounts[shard]}`)
  }
  return map
}

const control = load(controlDir, 'control')
const wrapper = load(wrapperDir, 'first-fail')
if (control.manifest.run_id === wrapper.manifest.run_id) {
  fail(`control and first-fail artifacts come from the same run ${control.manifest.run_id}; the pair must be two separate runs`)
}

let mutants = 0
for (const shard of shards) {
  const a = statusMap(control.artifacts.get(shard).report, shard)
  const b = statusMap(wrapper.artifacts.get(shard).report, shard)
  for (const k of a.keys()) if (!b.has(k)) fail(`${shard}: mutant missing from first-fail report: ${k}`)
  for (const k of b.keys()) if (!a.has(k)) fail(`${shard}: unexpected mutant in first-fail report: ${k}`)
  for (const [k, status] of a) {
    if (b.get(k) !== status) fail(`${shard}: verdict drift on ${k}: control=${status} first-fail=${b.get(k)}`)
  }
  const runnable = [...a.values()].filter((s) => s !== 'Ignored')
  if (runnable.length !== expectedRunnable[shard]) {
    fail(`${shard}: ${runnable.length} runnable mutants, expected ${expectedRunnable[shard]}`)
  }
  if (!runnable.includes('Killed')) fail(`${shard}: control report has no Killed mutant`)
  mutants += runnable.length
  const counts = (list) => list.reduce((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {})
  console.log(`${shard}: ${runnable.length} runnable mutants, verdicts identical (${JSON.stringify(counts(runnable))})`)
}
console.log(`EQUIVALENT: ${shards.length} shards, ${mutants} runnable mutants, all verdicts identical`)
