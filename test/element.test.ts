import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Browser, Page } from 'playwright'
import { launchBrowser, startServer, type Server } from './helpers.ts'

let server: Server
let browser: Browser
let page: Page

before(async () => {
  ;[server, browser] = await Promise.all([startServer(), launchBrowser()])
  page = await browser.newPage({ baseURL: server.url })
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
      const { element } = await import(url)
      const constructor = window[type as keyof Window]
      try {
        return element(id, constructor) === document.getElementById(id)
      } catch (error) {
        return (error as Error).message
      }
    },
    [id, type]
  )
}

test('element returns the element with that id', async () => {
  assert.equal(await callElement('room-name', 'HTMLInputElement'), true)
  assert.equal(await callElement('clock', 'HTMLTimeElement'), true)
  assert.equal(await callElement('clock', 'HTMLElement'), true)
})

test('element throws when the element has another type', async () => {
  assert.equal(
    await callElement('room-name', 'HTMLButtonElement'),
    '#room-name is not a HTMLButtonElement'
  )
})

test('element throws when no element has that id', async () => {
  assert.equal(
    await callElement('missing', 'HTMLDivElement'),
    '#missing is not a HTMLDivElement'
  )
})
