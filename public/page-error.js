// Reports page-level failures even when room.js never runs: every
// failure a person can hit names its cause instead of leaving Join
// disabled without a word. Capture phase catches resource load errors.
;(() => {
  const createEntry = () => {
    const entry = document.createElement('div')
    entry.id = 'page-error'
    const heading = document.createElement('h1')
    const detail = document.createElement('h2')
    entry.append(heading, detail)
    return { entry, heading, detail }
  }
  /** @type {ReturnType<typeof createEntry> | null} */
  let parts = null
  /** @param {string} message */
  const showPageError = (message) => {
    const box = document.getElementById('error')
    if (!box) return
    if (!parts) {
      parts = createEntry()
      box.append(parts.entry)
    }
    parts.heading.textContent = 'Page error'
    parts.detail.textContent = message
    box.hidden = false
  }
  window.addEventListener(
    'error',
    (event) => {
      const target = event.target
      if (
        target !== window &&
        target !== null &&
        'src' in target &&
        typeof target.src === 'string' &&
        target.src !== ''
      ) {
        showPageError(
          `Part of the page did not load: ${new URL(target.src).pathname}`
        )
      } else if (event.message) {
        showPageError(`Pinto hit an error: ${event.message}`)
      }
    },
    true
  )
  window.addEventListener('unhandledrejection', (event) => {
    /** @type {unknown} */
    const reason = event.reason
    showPageError(
      `Pinto hit an error: ${reason instanceof Error ? reason.message : String(reason)}`
    )
  })
})()
