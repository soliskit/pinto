# CI Speedup Effort

A closed effort to shorten the time Pinto's CI takes to report. It ended on October 7, 2026 with no change to CI. This page records what was learned and the method to reuse if the effort reopens. It does not authorize restarting.

## Outcome

- No workflow changes, pull requests or benchmark runs were made.
- The one measurement is an existing run of the Test workflow at commit `5897e6f`: the Test job took 53 seconds ([run 37490676521](https://github.com/soliskit/pinto/actions/runs/37490676521/job/112362267629)). Chromium and OS dependency install took 21 seconds, type check 3, lint 2, tests 16.
- The best case for overlapping the static checks with the tests saves about 5 seconds (9.43%). That is a projection, not a measured speedup, and it falls below the 10% keep rule below.

## What was looked at

Source and test inventory, test fixtures, deployment isolation, the job time limit and cancellation behavior, and running checks in parallel inside the same job. Not evaluated: caching the browser install, and changes to the tests. This is not a claim that nothing else would help.

## Current setup

`.github/workflows/test.yml` runs on push and on pull requests from forks. It uses one job with a 10-minute limit: checkout, Node setup with npm cache, `npm ci`, Chromium install, type check, lint, `npm test`. A newer push to the same branch cancels a run still in progress.

## Method to reuse

1. Fix the commit being measured. Keep the benchmark harness separate from it.
2. Take a declared sample before running: seven normal control runs and matching candidate runs, paired or interleaved, plus three cold-cache runs kept apart.
3. Measure the critical path, from the first job starting to the last job finishing, with queue time excluded.
4. Report every run, plus median, quartiles, range, mean and spread. Do not stop sampling once the result looks good. At most one predeclared extension, only when the gain is positive but unclear.
5. Keep a change only if the median gain is at least 10% of the control median and larger than the control quartile range. These are judgment rules, not statistical proof.
6. Keep every check. A faster run must not drop or weaken any test, and the 10-minute limit must still apply to the whole gate. Check that a failing test still fails.
7. Check that benchmark branches do not deploy the app and are never merged. Use a separate branch per sample, because a newer push cancels the older run.
8. Do not delete bad runs or count retries. Explain every failure. Watch for runner image changes, and if one happens, start a fresh baseline.
9. Finish with seven more paired runs of the final candidate as a reliability check. Clean runs do not prove the absence of flakiness.
