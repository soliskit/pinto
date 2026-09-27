// @ts-check

/**
 * English ordinal of a whole number: 1st, 2nd, 3rd, 4th, 11th, 21st.
 *
 * @param {number} n
 */
export function ordinal(n) {
  const tens = n % 100
  if (tens < 11 || tens > 13) {
    if (n % 10 === 1) return `${n}st`
    if (n % 10 === 2) return `${n}nd`
    if (n % 10 === 3) return `${n}rd`
  }
  return `${n}th`
}
