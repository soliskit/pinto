export { default as libCoverage } from 'istanbul-lib-coverage'

/** @param {unknown} value @returns {value is number} */
export function isFiniteNonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** @param {unknown} value */
export function isPositive(value) {
  return Number(value) > 0
}
