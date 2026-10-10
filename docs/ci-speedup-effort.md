# CI Speedup Effort

A closed effort to shorten the time Pinto's CI takes to report. It ended on October 7, 2026 with no change to CI. This page records what was learned and keeps the full method for use if the effort reopens. It is a record and a reference. It does not authorize restarting, running benchmarks, changing CI, or merging anything. Any restart needs separate written approval.

## Outcome

- No workflow changes, pull requests, or benchmark runs were made.
- The only measurement is an existing run of the Test workflow at commit `5897e6f`: the Test job took 53 seconds ([run 37490676521](https://github.com/soliskit/pinto/actions/runs/37490676521/job/112362267629)). Chromium and OS dependency install took 21 seconds, type check 3, lint 2, tests 16. These figures come from the closure record and were not re-measured for this page.
- Overlapping the static checks with the tests would save about 5 seconds (9.43%) in the best case. That is a projection, not a measured speedup, and it is below the 10% rule in the method.

## What was looked at

Source and test inventory, test fixtures, deployment isolation, the job time limit and cancellation behavior, and overlapping checks inside the same job. Not evaluated: caching the browser install, and changes to the tests. This is not a claim that nothing else would help.

## Current setup

`.github/workflows/test.yml` runs on push and on pull requests from forks. Same-repository pull requests rely on the push run, which is deliberate and not a missing check. One job has a 10-minute limit: checkout, Node setup with npm cache, `npm ci`, Chromium install, type check, lint, `npm test`. The limit applies per job, not to a whole workflow. A newer push to the same branch cancels a run still in progress.

## Method if the effort reopens

The rules below are the full reusable protocol. Thresholds are judgment rules, not statistical proof.

### Before any run

1. Get separate written approval for the scope and the resource limits.
2. Freeze the exact app, tests, lockfile, and workflow commit. List the discovered tests, what counts as pass or skip, timeouts, assertions, expected jobs, and required check names.
3. Find where checks are actually enforced, and how same-repository and fork pull request results attach to a commit.
4. Confirm that pushing a benchmark branch or merging later cannot deploy the running app. If that cannot be confirmed, hold the write and report the gap.
5. Keep the harness separate from the target, and have the measurement and gate protocol reviewed independently.

### Fixed-tree comparison

- Every directly compared run uses the same target commit and tree, lockfile, tests, and configuration. Change only the mechanism under study.
- Check out the target and the harness in separate paths. Record both identities before and after each run, and verify the harness did not change tracked target files. A needed patch is declared as "target plus explicit patch", with checksum and reason, and applied equally to control and candidate.
- Each report names the target, harness, effective configuration, and toolchain, and the producing workflow run, attempt, and job, with a checksum. Reject an artifact from a prior run even if names match. Never accept incomplete output as an empty passing test set.

### What to measure

- Record queue and provisioning delay separately from execution.
- The primary metric is the queue-excluded execution critical path through the whole required gate. Compute it from job execution durations and the job dependency graph. Count checkout, setup, installs, cache restore and save, artifact work, and gate work.
- Record separately: elapsed time to the gate result, total workflow wall clock, total runner time, and per-step durations.
- Write down the graph, its endpoints and the exact duration definition before looking at candidate timings.
- Check the metric: the same execution durations with different queue waits between jobs must give the same value. Timing only the final collector job is not CI timing. Queue luck is not a gain.

### Sampling

- Declared sample: seven ordinary control runs and three deliberately cold-cache diagnostic runs, with matching candidate runs. Pair or interleave control and candidate runs. Keep cold-cache runs separate.
- Report every run, plus median, 25th and 75th percentiles, range, mean, standard deviation, and coefficient of variation. The coefficient of variation is descriptive, not a stop rule.
- No stopping when the result looks good.
- At most one extension, and only when the safeguards already pass, the median gain is positive and the keep rule is still inconclusive. Before it starts, declare the paired schedule and the combined calculation. An extension adds the same number of runs, n, to both the control and the candidate series. Keep all original runs. Recompute the control quartile range and both medians from the full 2n samples. Recheck runner image drift across original and extension runs. No second extension. A zero or negative gain rejects the candidate with no extension.

### When to keep a change

- Keep a complete step only if the median critical-path gain is at least 10% of the current control median and larger than the control quartile range, with every protection and negative control satisfied.
- Extra-job setup is already in the measured critical path, so do not subtract it again. Projections made before a build subtract added setup once. Compare each step against the control that includes earlier kept improvements.
- Reliability must not get worse. Record failures, crashes, abnormal exits, timeouts, memory pressure, and cleanup faults, and explain each before accepting. An explanation is not a waiver. Do not delete bad runs or count retries as acceptance.
- If no safe setup clears the rule, keep the current one. That is a valid result.
- The final candidate gets seven more paired runs against the control as a reliability check. Keep every result. Clean runs do not prove there is no flakiness.
- If faster feedback, total resource use, and deployment time conflict, that goes to the owner and is not silently traded.

### What must not change

Test removal, weaker assertions, hidden skips, longer timeouts that hide faults, retries that turn failure into success, narrower test discovery, repository or production settings, and deployment shortcuts are out of bounds. Required check names, branch protection, workflow permissions, triggers, and the effective timeout and failure rules stay as they are unless the owner approves a change. Merge, release, deployment, accounts, and spending are separate approvals.

### Gate behavior and negative controls

- Before counting timings, write the expected manifest for each event type: every required component succeeds exactly, with complete evidence from the current run. Required component and check names, skip and discovery meaning, and assertion outcomes are part of that manifest.
- Tell a deliberate skip (the same-repository pull request rule) apart from an unexpected one. The collector must not accept a skipped result when a dependency fails.
- Check these negative cases: type check failure, lint failure, unit test failure, server or integration failure, Chromium launch or test failure, test timeout, a required job that failed, was cancelled, or was skipped unexpectedly, a missing or stale report, a duplicate report or test identity, incomplete discovery, and a zero-test false success. If caching is tried, check a cache mismatch. If concurrency changes, check cleanup, port, and resource faults.
- Deadline: the current 10-minute limit is per job. When splitting a job, keep the original effective deadline for the whole gate. Do not give each new job a fresh ten minutes, and do not lengthen the total budget or weaken detection that way. Test the deadline failure path: a run that hits the limit must fail the gate and never count as passing.
- Cancellation: a cancelled workflow must never count as a complete passing result or allow a deploy. If the platform stops the collector from running, check that the safety property still holds instead of demanding a red collector.

### Benchmark route (only if a reopened effort is authorized)

- Use dedicated benchmark branches with push triggers. Check out the target and the harness separately.
- Benchmark branches are never merged.
- The normal Test workflow also runs on every branch push. Each harness push must account for that extra run, its resource load, and any deployment consequences. Check the branch push against deployment hooks before first use.
- The workflow's cancel-in-progress rule can cancel a sample when the same branch is pushed again. Use a distinct branch for each queued sample, or let a sample finish before the next push to the same branch. Never count a cancelled sample as evidence.
- No benchmark-only workflow on `main`. If isolation cannot be shown, do not work around it by changing production settings or switching to a default-branch workflow without new approval.
- Delete the temporary benchmark branches after the authorized work is complete.

### Runner identity and cost

- Record the runner label and image when shown, architecture, CPU count, available parallelism, memory, disk, Node, npm and Playwright versions, the Chromium revision, the OS, and any cgroup limits. Check the installed packages against the lockfile.
- Keep the production runner label unchanged unless approved. A material runner image change ends a mixed comparison. Keep the record and start a fresh baseline.
- Use standard hosted runners on the public repository. Use no paid runners, services, TURN, or live media. At most three required jobs at once per run including the collector. One measurement at a time. Keep only nonsecret artifacts, for seven days or less. Check account concurrency and storage limits first. These are proposed limits, not a grant.
- Other work on the same account (such as other repositories' CI) can load the runners. Record it and interleave comparisons.

### Candidates to try, in order

1. Find redundant work, keeping existing event coverage, obsolete-run cancellation, and the fork rule.
2. Run type check and lint alongside the tests, only if the critical path gets shorter than the added checkout, install, and gate cost.
3. Split non-browser tests from browser tests using an exhaustive file list that never double-runs or omits a file.
4. Tune Node test-file concurrency after confirming process isolation. Shared mocks and timers rule out blind concurrency within a process.
5. Cache the Chromium binary only if it still pays off. Playwright guidance advises against it, so it stays off unless the full candidate wins safely.

Adding browser or device coverage, or new coverage rules, is a separate reliability change and cannot be narrowed later for speed.

### Finish

Done means: a fixed-tree comparison, unchanged test, trigger, and check meaning, passing negative controls, fresh complete reports, reliability evidence, cost confirmation, and an independent review of the exact patch. Compare test, assertion, and skip lists, not just a smaller green count. Report to the owner: what got faster and by how much, all latency and resource numbers, what stayed protected, rejected candidates, remaining doubt, the exact commit, and a rollback plan. If there is no safe gain, say so and leave CI unchanged. After a separately approved merge, check the real post-merge result and any deployment effect.

## Short summary (not the operating rules)

Measure the critical path with queue time excluded, on a fixed tree, with a declared sample. Keep a change only at 10% and above the control spread. Keep every check. The full text above governs.
