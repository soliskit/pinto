import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser, Page } from 'playwright'
import { launchBrowser, startServer, type Server } from './helpers.ts'

let server: Server | undefined
let browser: Browser | undefined
let page: Page

// Test bodies require successful setup; cleanup may also run after failure.
function ready<T>(resource: T | undefined, name: string): T {
  assert.ok(resource, `${name} setup did not complete`)
  return resource
}

before(async () => {
  ;[server, browser] = await Promise.all([startServer(), launchBrowser()])
  page = await ready(browser, 'browser').newPage({
    baseURL: ready(server, 'server').url
  })
  await page.goto('/')
})
after(async () => {
  await browser?.close()
  await server?.stop()
})

/** Calls element() from public/element.js in the home page */
function callElement(id: string, type: string) {
  return page.evaluate(
    async ([id, type]) => {
      const url = '/element.js'
      const elementModule = (await import(url)) as {
        element: (id: string, constructor: new () => Element) => Element
      }
      const constructor = Reflect.get(window, type) as new () => Element
      try {
        return (
          elementModule.element(id, constructor) === document.getElementById(id)
        )
      } catch (error) {
        return (error as Error).message
      }
    },
    [id, type]
  )
}

void test('element returns the element with that id', async () => {
  assert.equal(await callElement('room-name', 'HTMLInputElement'), true)
  assert.equal(await callElement('clock', 'HTMLTimeElement'), true)
  assert.equal(await callElement('clock', 'HTMLElement'), true)
})

void test('element throws when the element has another type', async () => {
  assert.equal(
    await callElement('room-name', 'HTMLButtonElement'),
    '#room-name is not a HTMLButtonElement'
  )
})

void test('element throws when no element has that id', async () => {
  assert.equal(
    await callElement('missing', 'HTMLDivElement'),
    '#missing is not a HTMLDivElement'
  )
})
