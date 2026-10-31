// Stops a child process the way the harness stops the server, but a stop
// that has to kill the process on a timeout fails the measurement run
// instead of risking a half-written report.
import { MeasurementFailure } from './validate.mjs'

export async function stopWithTimeout(child, exited, timeoutMs = 10000) {
  child.kill()
  const timeout = new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error('timeout')), timeoutMs)
  )
  try {
    await Promise.race([exited, timeout])
  } catch {
    child.kill('SIGKILL')
    await exited
    throw new MeasurementFailure(
      `server ignored the stop signal for ${timeoutMs}ms and was killed; the measurement run fails rather than risk a half-written report`
    )
  }
}
