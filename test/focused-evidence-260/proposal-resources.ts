import { randomUUID } from 'node:crypto'
import type { Browser } from 'playwright'
import { launchBrowser, startServer, type Server } from './helpers.ts'
import { resourceReceipt } from './resource-receipt.ts'

export async function withBrowser(
  use: (server: Server, browser: Browser) => Promise<void>
): Promise<void> {
  let server: Server | undefined
  let browser: Browser | undefined
  const id = `browser-${randomUUID()}`
  const errors: unknown[] = []
  try {
    server = await startServer()
    resourceReceipt(id, 'acquire-start')
    browser = await launchBrowser()
    resourceReceipt(id, 'acquired')
    await use(server, browser)
  } catch (error) {
    errors.push(error)
  } finally {
    if (browser) {
      try {
        await browser.close()
        resourceReceipt(id, 'closed')
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      await server?.stop()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1)
    throw new AggregateError(errors, 'Fixture operation or cleanup failed', {
      cause: errors[0]
    })
}
