import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startServer, launchBrowser } from './helpers.ts'
import { runEvidenceCase } from './phase-evidence.mjs'

const selected = process.env.PINTO_ATTRIBUTION_CASE
const allowed = [
  '188-500',
  '188-abort',
  '168-pending',
  '168-abort',
  '168-invalid-json',
  '168-500-text'
]
assert.ok(
  allowed.includes(selected || ''),
  'exact bounded attribution case required'
)
assert.ok(
  ['chromium', 'webkit'].includes(process.env.PINTO_BROWSER || ''),
  'explicit native engine required'
)
const identity = {
  case: selected,
  mode: selected,
  engine: process.env.PINTO_BROWSER,
  arm: 'baseline'
}

test(`baseline attribution ${selected}`, async () => {
  const steps: Record<string, (mark: () => void) => Promise<void>> = {}
  let assertionId: string | null = null
  function oracle(mark: () => void, id: string) {
    mark()
    assertionId = id
    console.log(JSON.stringify({ assertionEntered: id, ...identity }))
  }
  steps.operation = async (mark: () => void) => {
    const server = await startServer()
    steps.serverStop = () => server.stop()
    const browser = await launchBrowser()
    steps.browserClose = () => browser.close()
    const context = await browser.newContext({ baseURL: server.url })
    steps.contextClose = () => context.close()
    const page = await context.newPage()
    if (selected!.startsWith('188-')) {
      const mode = selected!.slice(4)
      let idRequests = 0
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/pinto/id') idRequests++
      })
      await page.route('**/pinto/id*', (route) =>
        mode === 'abort'
          ? route.abort()
          : route.fulfill({ status: 500, body: 'controlled failure' })
      )
      await page.goto('/room/id-error')
      await page.locator('#error:not([hidden])').waitFor()
      const started = Date.now()
      await new Promise((resolve) => setTimeout(resolve, 5500))
      const entries = await page.locator('#error > div').evaluateAll((nodes) =>
        nodes.map((node) => ({
          heading: node.querySelector('h1')?.textContent,
          detail: node.querySelector('h2')?.textContent
        }))
      )
      const evidence = {
        mode,
        observationMs: Date.now() - started,
        idRequests,
        entries,
        joinDisabled: await page.locator('#call').isDisabled()
      }
      console.log(JSON.stringify({ peerFailureEvidence: evidence }))
      oracle(mark, '188.single-entry')
      assert.equal(entries.length, 1, 'single error entry')
      oracle(mark, '188.heading')
      assert.equal(entries[0].heading, 'Connection problem')
      oracle(mark, '188.fallback-detail')
      assert.equal(
        entries[0].detail,
        'server-error: No further error details are available.'
      )
      oracle(mark, '188.id-request-count')
      assert.equal(idRequests, 1, 'one initial ID request and no retry')
      oracle(mark, '188.join-disabled')
      assert.equal(evidence.joinDisabled, true)
    } else if (selected === '168-pending') {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let arrived!: () => void
      const requested = new Promise<void>((resolve) => {
        arrived = resolve
      })
      steps.contextClose = async () => {
        release()
        await context.close()
      }
      await page.route('**/config', async (route) => {
        arrived()
        await gate
        await route.continue()
      })
      await page.goto('/room/config-readiness', {
        waitUntil: 'domcontentloaded'
      })
      await requested
      const muteDisabled = await page.locator('#mute').isDisabled()
      console.log(JSON.stringify({ pendingConfigEvidence: { muteDisabled } }))
      oracle(mark, '168.pending-mute-disabled')
      assert.equal(muteDisabled, true)
      oracle(mark, '168.pending-camera-disabled')
      assert.equal(await page.locator('#camera').isDisabled(), true)
      oracle(mark, '168.pending-join-disabled')
      assert.equal(await page.locator('#call').isDisabled(), true)
      const before = await page.locator('#mute').textContent()
      await page
        .locator('#mute')
        .evaluate((el) => (el as HTMLButtonElement).click())
      oracle(mark, '168.pending-mute-inert')
      assert.equal(await page.locator('#mute').textContent(), before)
      release()
      await page.locator('#call:enabled').waitFor()
      await page.locator('#mute').click()
      oracle(mark, '168.pending-handler-ready')
      assert.equal(await page.locator('#mute').textContent(), 'Unmute')
    } else {
      const mode = selected!.slice(4)
      await page.route('**/config', (route) =>
        mode === 'abort'
          ? route.abort()
          : route.fulfill({
              status: mode === '500-text' ? 500 : 200,
              contentType: 'text/plain',
              body: 'not JSON'
            })
      )
      await page.goto('/room/config-nonregression')
      await page.locator('#page-error').waitFor()
      const message = (await page.locator('#page-error').textContent()) || ''
      const muteDisabled = await page.locator('#mute').isDisabled()
      const joinDisabled = await page.locator('#call').isDisabled()
      console.log(
        JSON.stringify({
          configPreservationEvidence: {
            mode,
            message,
            muteDisabled,
            joinDisabled
          }
        })
      )
      oracle(mark, '168.preservation-visible-length')
      assert.ok(message.length > 10)
      oracle(mark, '168.preservation-mute-disabled')
      assert.equal(muteDisabled, true)
      oracle(mark, '168.preservation-join-disabled')
      assert.equal(joinDisabled, true)
    }
  }
  await runEvidenceCase(identity, steps, (receipt: object) => {
    console.log(JSON.stringify({ phaseEvidence: { ...receipt, assertionId } }))
  })
})
