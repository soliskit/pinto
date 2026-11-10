import { appendFileSync } from 'node:fs'

/** Fixture-only, checked writes. A missing receipt sink is a failed run. */
export function resourceReceipt(id: string, event: string): void {
  const path = process.env.PINTO_RESOURCE_RECEIPT
  if (!path) throw Error('Missing resource receipt path')
  appendFileSync(path, JSON.stringify({ pid: process.pid, id, event }) + '\n')
}
