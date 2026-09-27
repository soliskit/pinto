// @ts-check

/**
 * Finds an element by id and checks its type, so callers get a typed
 * element instead of `HTMLElement | null`.
 *
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type
 * @returns {T}
 */
export function element(id, type) {
  const found = document.getElementById(id)
  if (!(found instanceof type)) {
    throw Error(`#${id} is not a ${type.name}`)
  }
  return found
}
