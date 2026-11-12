import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapeLogId } from '../src/escape-log-id.ts'

void test('plain ids pass through unchanged', () => {
  assert.equal(escapeLogId('real-user'), 'real-user')
})

void test('a line break becomes the two characters \\n', () => {
  assert.equal(escapeLogId('real-user\nFORGED'), 'real-user\\nFORGED')
})

void test('a carriage return becomes the two characters \\r', () => {
  assert.equal(escapeLogId('a\rb'), 'a\\rb')
})

void test('a backslash doubles, so an escaped break never reads as typed text', () => {
  assert.equal(escapeLogId('\\'), '\\\\')
  assert.notEqual(escapeLogId('\n'), escapeLogId('\\n'))
})

void test('U+2028 and U+2029 become their six-character \\u forms', () => {
  assert.equal(escapeLogId('\u2028'), '\\u2028')
  assert.equal(escapeLogId('\u2029'), '\\u2029')
})

void test('escape, delete and the other C0 controls become \\u forms', () => {
  assert.equal(escapeLogId('\x1b'), '\\u001b')
  assert.equal(escapeLogId('\x00'), '\\u0000')
  assert.equal(escapeLogId('\x07'), '\\u0007')
  assert.equal(escapeLogId('\x1f'), '\\u001f')
  assert.equal(escapeLogId('\x7f'), '\\u007f')
})

void test('the C1 controls become \\u forms', () => {
  assert.equal(escapeLogId('\x80'), '\\u0080')
  assert.equal(escapeLogId('\x85'), '\\u0085')
  assert.equal(escapeLogId('\x9f'), '\\u009f')
})

void test('every bidi control becomes its \\u form', () => {
  const bidi = [
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
    0x2067, 0x2068, 0x2069
  ]
  for (const cp of bidi) {
    assert.equal(
      escapeLogId(String.fromCodePoint(cp)),
      `\\u${cp.toString(16).padStart(4, '0')}`
    )
  }
})

void test('a forged multi-line id stays on one log line', () => {
  const id = 'real-user\nFORGED - user: admin - joined: lobby'
  const escaped = escapeLogId(id)
  assert.equal(escaped, 'real-user\\nFORGED - user: admin - joined: lobby')
  assert.ok(!escaped.includes('\n'))
})
