// Measurement-only server shutdown. Ordinary helper behavior is unchanged.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MeasurementFailure } from './validate.mjs'

export function validateProcessReceipt(dir, pid, startedAt, sourceUrl) {
  const pattern = new RegExp(`^coverage-${pid}-([0-9]+)-[0-9]+\\.json$`)
  const names = readdirSync(dir).filter((name) => pattern.test(name))
  if (!names.length)
    throw new MeasurementFailure('missing PID-bound server receipt')
  for (const name of names) {
    const stamp = Number(pattern.exec(name)[1])
    if (stamp < startedAt) throw new MeasurementFailure('stale server receipt')
    let raw
    try {
      raw = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      throw new MeasurementFailure('cut-off server receipt')
    }
    if (
      !Array.isArray(raw.result) ||
      !raw.result.some((entry) => entry.url === sourceUrl)
    )
      throw new MeasurementFailure(
        'server receipt missing expected source identity'
      )
  }
  return names
}

export async function stopMeasuredServer(
  child,
  { dir, startedAt, sourceUrl, timeoutMs = 10000 }
) {
  if (child.exitCode !== null || child.signalCode !== null)
    throw new MeasurementFailure('server exited before measurement shutdown')
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  )
  let timer
  let result
  try {
    child.kill('SIGTERM')
    result = await Promise.race([
      exited,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new MeasurementFailure('measurement stop timed out')),
          timeoutMs
        )
      })
    ])
  } catch (error) {
    child.kill('SIGKILL')
    await exited
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (result.code !== 0 || result.signal !== null)
    throw new MeasurementFailure('measurement server did not exit normally')
  return validateProcessReceipt(dir, child.pid, startedAt, sourceUrl)
}
