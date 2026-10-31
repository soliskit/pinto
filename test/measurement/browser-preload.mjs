// Measurement-only preload. Loaded by the measurement runner through
// NODE_OPTIONS; it does nothing unless PINTO_MEASURE is set. While active it
// wraps Chromium launches so every page records V8 JavaScript coverage.
//
// Playwright's own coverage API loses a document's coverage once the page
// navigates away, so this preload drives the CDP Profiler directly:
// - a capture is taken before every navigation-capable page API call
//   (goto, reload, goBack, goForward, click, dblclick, tap, press), which is
//   how the suites drive pages;
// - a poll captures every 250ms as a backstop for navigation the page's own
//   script starts;
// - a final capture is taken before the page, context or browser closes.
// Each take resets V8's counters, so captures never double-count. Every
// navigation and every capture is logged; the runner fails the measurement
// when a navigation has no capture before it, so missing data fails the run
// instead of printing a valid-looking number.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

if (process.env.PINTO_MEASURE === '1') {
  const dir = process.env.PINTO_MEASURE_DIR
  if (!dir) throw new Error('PINTO_MEASURE=1 requires PINTO_MEASURE_DIR')
  const captureDir = join(dir, 'browser')
  mkdirSync(captureDir, { recursive: true })
  const indexFile = join(captureDir, 'captures.index')
  const POLL_MS = 250
  const NAV_APIS = [
    'goto',
    'reload',
    'goBack',
    'goForward',
    'click',
    'dblclick',
    'tap',
    'press'
  ]
  let seq = 0

  async function instrument(page, context) {
    const session = await context.newCDPSession(page)
    await session.send('Page.enable')
    await session.send('Debugger.enable')
    await session.send('Profiler.enable')
    await session.send('Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: true
    })

    const sources = new Map()
    session.on('Debugger.scriptParsed', (event) => {
      if (event.url) sources.set(event.scriptId, event.url)
    })
    const navLog = []
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame())
        navLog.push({ at: Date.now(), url: page.url() })
    })

    async function sourceFor(scriptId) {
      try {
        const r = await session.send('Debugger.getScriptSource', { scriptId })
        return r.scriptSource
      } catch {
        return undefined
      }
    }

    async function take(why) {
      const at = Date.now()
      seq += 1
      const name = `${process.pid}-${seq}.json`
      let result
      try {
        ;({ result } = await session.send('Profiler.takePreciseCoverage'))
      } catch (error) {
        // A poll or close-flush can race a target that is already gone; that
        // is not missing data. Anything else is a failed capture and fails
        // the run. A crashed test process fails the suite itself, so a
        // capture indexed only after success can never look valid.
        if (/closed/i.test(String(error))) return
        writeFileSync(
          join(captureDir, `${name}.failed`),
          `takePreciseCoverage threw during ${why}: ${error}\n`
        )
        return
      }
      appendFileSync(indexFile, `${name}\t${why}\n`)
      const entries = []
      for (const entry of result) {
        if (!entry.url) continue
        entries.push({
          url: entry.url,
          source: await sourceFor(entry.scriptId),
          functions: entry.functions
        })
      }
      writeFileSync(
        join(captureDir, name),
        JSON.stringify({
          pid: process.pid,
          why,
          at,
          navigations: navLog.slice(),
          entries
        })
      )
    }

    const poll = setInterval(() => {
      if (!page.isClosed()) take('poll').catch(() => {})
    }, POLL_MS)
    poll.unref()

    for (const api of NAV_APIS) {
      const original = page[api].bind(page)
      page[api] = async (...args) => {
        await take(`before:${api}`)
        return original(...args)
      }
    }

    const originalClose = page.close.bind(page)
    page.close = async (...args) => {
      clearInterval(poll)
      // A page from browser.newPage owns its context: its close closes the
      // context, which loops back here. Guard so the flush happens once.
      if (!closing.has(page)) {
        closing.add(page)
        await take('page.close')
      }
      return originalClose(...args)
    }
    page.once('close', () => clearInterval(poll))
    return { take }
  }

  const instrumented = new WeakSet()
  const closing = new WeakSet()
  const takesByPage = new WeakMap()

  function watchContext(context) {
    const originalNewPage = context.newPage.bind(context)
    context.newPage = async (...args) => {
      const page = await originalNewPage(...args)
      if (!instrumented.has(page)) {
        instrumented.add(page)
        takesByPage.set(page, await instrument(page, context))
      }
      return page
    }
    const originalClose = context.close.bind(context)
    context.close = async (...args) => {
      // Flush coverage directly; never call page.close here, because a page
      // that owns its context would loop back into this close.
      for (const page of context.pages()) {
        const handle = takesByPage.get(page)
        if (handle && !closing.has(page) && !page.isClosed()) {
          closing.add(page)
          try {
            await handle.take('context.close')
          } catch {
            // The page is already closing; a missed capture here is expected.
          }
        }
      }
      return originalClose(...args)
    }
  }

  const originalLaunch = chromium.launch.bind(chromium)
  chromium.launch = async (...args) => {
    const browser = await originalLaunch(...args)
    // Covers context.newPage, and contexts the browser creates implicitly.
    browser.on('context', watchContext)
    for (const context of browser.contexts()) watchContext(context)
    const originalBrowserNewPage = browser.newPage.bind(browser)
    browser.newPage = async (...pageArgs) => {
      const page = await originalBrowserNewPage(...pageArgs)
      if (!instrumented.has(page)) {
        instrumented.add(page)
        watchContext(page.context())
        takesByPage.set(page, await instrument(page, page.context()))
      }
      return page
    }
    const originalClose = browser.close.bind(browser)
    browser.close = async (...closeArgs) => {
      for (const context of browser.contexts()) {
        try {
          await context.close()
        } catch {
          // The context is already closing; ignore and keep closing the rest.
        }
      }
      return originalClose(...closeArgs)
    }
    return browser
  }
}
