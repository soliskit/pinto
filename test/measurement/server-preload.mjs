// Measurement-only preload. Loaded by the measurement runner through
// NODE_OPTIONS; it does nothing unless PINTO_MEASURE is set, so the
// existing suites behave exactly as today when it is absent or inactive.
// The server installs no signal handlers and the test helpers stop it with
// SIGTERM, which skips Node's coverage flush. Catching the signal here and
// exiting normally lets Node write NODE_V8_COVERAGE for the server process.
if (process.env.PINTO_MEASURE === '1') {
  process.on('SIGTERM', () => process.exit(0))
  // A mid-run snapshot: Node writes coverage so far and resets the counters,
  // so the snapshot and the exit write together keep every path executed
  // before and after the signal exactly once.
  const { takeCoverage } = await import('node:v8')
  process.on('SIGUSR2', () => takeCoverage())
}
