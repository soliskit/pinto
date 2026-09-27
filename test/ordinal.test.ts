import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ordinal } from '../public/ordinal.js'

test('ordinal adds st, nd, rd and th', () => {
  const cases: [number, string][] = [
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [9, '9th'],
    [10, '10th'],
    [20, '20th'],
    [21, '21st'],
    [22, '22nd'],
    [23, '23rd'],
    [101, '101st'],
    [102, '102nd'],
    [103, '103rd']
  ]
  for (const [n, expected] of cases) assert.equal(ordinal(n), expected)
})

test('ordinal uses th for 11, 12 and 13 in every hundred', () => {
  for (const n of [11, 12, 13, 111, 112, 113, 1011, 1012, 1013]) {
    assert.equal(ordinal(n), `${n}th`)
  }
})
