// Build run-manifest.json for one experiment run from GitHub API data only.
//
//   GITHUB_TOKEN=... node .github/scripts/make-run-manifest.mjs <runId> <outDir> <shard...>
//
// Everything in the manifest is fetched live and cross-checked:
//   - the run's id, head_sha, head_branch, event, workflow path and
//     run_attempt (runs API);
//   - every named shard's mutation job conclusion and attempt (jobs API,
//     fully paginated);
//   - the run's artifact listing (artifacts API, fully paginated): the
//     mutation-report artifacts for this run must be EXACTLY one per named
//     shard, all with one uniform mode and attempt, matching the run attempt
//     - the manifest's command_mode and selection are DERIVED from those
//     names, never from a hand-supplied label;
//   - sha256 of the workflow file, package.json and
//     .github/mutation-ranges.json fetched AT the run's head SHA (contents
//     API); STRYKER_VERSION parsed from that workflow file.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [runId, outDir, ...shards] = process.argv.slice(2)
if (!runId || !outDir || shards.length === 0) {
  console.error('Usage: make-run-manifest.mjs <runId> <outDir> <shard...>')
  process.exit(2)
}
const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error('GITHUB_TOKEN is required')
  process.exit(2)
}
const fail = (msg) => {
  console.error(`manifest: ${msg}`)
  process.exit(1)
}

const api = async (path) => {
  const res = await fetch(`https://api.github.com/repos/soliskit/pinto/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) fail(`GET ${path}: HTTP ${res.status}`)
  return res.json()
}
const paged = async (path, key) => {
  const all = []
  for (let page = 1; ; page++) {
    const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    all.push(...data[key])
    if (all.length >= data.total_count) return all
  }
}
const fileAt = async (sha, path) => {
  const data = await api(`contents/${path}?ref=${sha}`)
  if (data.encoding !== 'base64' || typeof data.content !== 'string') fail(`contents ${path}@${sha}: unexpected shape`)
  return Buffer.from(data.content, 'base64')
}

const run = await api(`actions/runs/${runId}`)
if (run.event !== 'workflow_dispatch') fail(`run ${runId} event is ${run.event}, expected workflow_dispatch`)

const jobs = await paged(`actions/runs/${runId}/jobs`, 'jobs')
const jobEntries = {}
for (const shard of shards) {
  const job = jobs.find((j) => j.name === `mutation (${shard})`)
  if (!job) fail(`run ${runId} has no job "mutation (${shard})"`)
  jobEntries[shard] = { conclusion: job.conclusion, attempt: job.run_attempt, started_at: job.started_at, completed_at: job.completed_at }
}

// Mode and selection come from the run's actual artifact names.
const artifacts = await paged(`actions/runs/${runId}/artifacts`, 'artifacts')
const reportArtifacts = artifacts.filter((a) => a.name.startsWith(`mutation-report-${runId}-`))
const parsed = reportArtifacts.map((a) => {
  const m = /^mutation-report-(\d+)-(\d+)-(control|first-fail)-(.+)$/.exec(a.name)
  if (!m) fail(`unparseable artifact name ${a.name}`)
  return { name: a.name, runId: m[1], attempt: m[2], mode: m[3], shard: m[4], expired: a.expired }
})
const expected = new Set(shards)
const seen = new Set()
for (const a of parsed) {
  if (a.expired) fail(`artifact ${a.name} is expired`)
  if (!expected.has(a.shard)) fail(`run ${runId} produced unexpected report artifact for shard ${a.shard}`)
  if (seen.has(a.shard)) fail(`run ${runId} produced duplicate report artifacts for shard ${a.shard}`)
  seen.add(a.shard)
}
for (const shard of shards) if (!seen.has(shard)) fail(`run ${runId} produced no report artifact for shard ${shard}`)
const modes = new Set(parsed.map((a) => a.mode))
const attempts = new Set(parsed.map((a) => a.attempt))
if (modes.size !== 1) fail(`run ${runId} report artifacts mix modes: ${[...modes].join(', ')}`)
if (attempts.size !== 1) fail(`run ${runId} report artifacts mix attempts: ${[...attempts].join(', ')}`)
if ([...attempts][0] !== String(run.run_attempt)) fail(`artifact attempt ${[...attempts][0]} != run attempt ${run.run_attempt}`)

const workflowText = (await fileAt(run.head_sha, run.path)).toString('utf8')
const m = /STRYKER_VERSION:\s*'([^']+)'/.exec(workflowText)
if (!m) fail(`STRYKER_VERSION not found in ${run.path}@${run.head_sha}`)
const manifest = {
  run_id: run.id,
  run_attempt: run.run_attempt,
  head_sha: run.head_sha,
  head_branch: run.head_branch,
  event: run.event,
  workflow_path: run.path,
  created_at: run.created_at,
  command_mode: [...modes][0],
  stryker_version: m[1],
  source_hashes: {
    workflow: createHash('sha256').update(workflowText).digest('hex'),
    package_json: createHash('sha256').update(await fileAt(run.head_sha, 'package.json')).digest('hex'),
    mutation_ranges: createHash('sha256').update(await fileAt(run.head_sha, '.github/mutation-ranges.json')).digest('hex')
  },
  jobs: jobEntries
}
writeFileSync(join(outDir, 'run-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`manifest: run ${run.id} attempt ${run.run_attempt} head ${run.head_sha.slice(0, 8)} mode ${manifest.command_mode} stryker ${manifest.stryker_version}, ${parsed.length} report artifacts cross-checked`)
