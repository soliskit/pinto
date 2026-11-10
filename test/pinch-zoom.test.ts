import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { startServer, type Server } from './helpers.ts'

// REQ 16: both pages can be pinch-zoomed. Browsers that honor the
// viewport's user-scalable=no or maximum-scale directives block the
// gesture, so neither page may declare them.

let server: Server

before(async () => {
  server = await startServer()
})
after(async () => {
  await server.stop()
})

/** Reads the viewport meta content declared by the page at `path` */
async function viewportContent(path: string) {
  const response = await fetch(server.url + path)
  assert.equal(response.status, 200)
  const match = (await response.text()).match(
    /<meta[^>]*name="viewport"[^>]*content="([^"]*)"/
  )
  assert.ok(match, `no viewport meta at ${path}`)
  return match[1]
}

void describe('Pinch zoom (REQ 16)', () => {
  for (const [name, path] of [
    ['lobby', '/'],
    ['room', '/room/zoom-check']
  ] as const) {
    void test(`the ${name} page allows pinch zoom`, async () => {
      const content = await viewportContent(path)
      assert.ok(!content.includes('user-scalable=no'), content)
      assert.ok(!content.includes('maximum-scale'), content)
    })
  }
})
