// Measurement-only server shutdown. Ordinary helper behavior is unchanged.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MeasurementFailure } from './validate.mjs'

/**
 * @param {string} dir
 * @param {number | undefined} pid
 * @param {number} startedAt
 * @param {string} sourceUrl
 */
export function validateProcessReceipt(dir, pid, startedAt, sourceUrl) {
  const pattern = new RegExp(`^coverage-${String(pid)}-([0-9]+)-[0-9]+\\.json$`)
  const names = readdirSync(dir).filter((name) => pattern.test(name))
  if (!names.length)
    throw new MeasurementFailure('missing PID-bound server receipt')
  for (const name of names) {
    const stamp = Number(pattern.exec(name)[1])
    if (stamp < startedAt) throw new MeasurementFailure('stale server receipt')
    /** @type {unknown} */
    let raw
    try {
      raw = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      throw new MeasurementFailure('cut-off server receipt')
    }
    // A null report or null entry threw a TypeError here before; it is now a
    // measurement failure. Every other value is judged as it was.
    if (raw === null)
      throw new MeasurementFailure(
        'server receipt missing expected source identity'
      )
    const result =
      typeof raw === 'object' && 'result' in raw ? raw.result : undefined
    if (!Array.isArray(result))
      throw new MeasurementFailure(
        'server receipt missing expected source identity'
      )
    /** @type {unknown[]} */
    const entries = result
    let found = false
    for (const entry of entries) {
      if (entry === null || entry === undefined)
        throw new MeasurementFailure(
          'server receipt missing expected source identity'
        )
      if (
        typeof entry === 'object' &&
        'url' in entry &&
        entry.url === sourceUrl
      )
        found = true
    }
    if (!found)
      throw new MeasurementFailure(
        'server receipt missing expected source identity'
      )
  }
  return names
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ dir: string, startedAt: number, sourceUrl: string, timeoutMs?: number }} options
 */
export async function stopMeasuredServer(
  child,
  { dir, startedAt, sourceUrl, timeoutMs = 10000 }
) {
  if (child.exitCode !== null || child.signalCode !== null)
    throw new MeasurementFailure('server exited before measurement shutdown')
  /** @type {Promise<{ code: number | null, signal: NodeJS.Signals | null }>} */
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => {
      resolve({ code, signal })
    })
  )
  let timer
  /** @type {{ code: number | null, signal: NodeJS.Signals | null }} */
  let result
  try {
    child.kill('SIGTERM')
    /** @type {Promise<never>} */
    const timedOut = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new MeasurementFailure('measurement stop timed out'))
      }, timeoutMs)
    })
    result = await Promise.race([exited, timedOut])
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
