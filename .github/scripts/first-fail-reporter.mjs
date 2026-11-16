// Signals fatal test failures to run-tests-first-fail.mjs over fd 3.
//
// A failure is fatal exactly when `node --test` itself would exit nonzero
// for it, grounded empirically on Node 26.13.0: the reporter event stream
// carries todo/skip as TOP-LEVEL fields on the fail event, and a test is
// todo whenever the field is PRESENT - even an empty string (todo: '' still
// exits 0 in node). Skipped tests report as pass. Tests marked
// { failing: true } exit 1 in 26.13.0, so they count as fatal here. Nested
// subtest failures arrive as their own events the moment they happen (a
// parent whose only failures are todo still reports test:pass), so the
// wrapper stops at the first real failure, not at the top-level summary.
// TAP "not ok" parsing was rejected: it marks todo failures identically to
// real ones.
//
// The reporter yields nothing except a lexically required empty chunk: it
// must not alter the log stream. When fd 3 is closed (the command is run
// without the wrapper) it does nothing.
import { writeSync } from 'node:fs'

export default async function* firstFailReporter(source) {
  for await (const event of source) {
    if (event.type === 'test:fail' && event.data.todo === undefined && event.data.skip === undefined) {
      try {
        writeSync(3, 'FIRST-FAIL\n')
      } catch {
        // No wrapper listening: reporting is best-effort only.
      }
      yield '' // Reporters are generators; this empty chunk writes nothing.
      return
    }
  }
}
