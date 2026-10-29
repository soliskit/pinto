import { test } from 'node:test';
import assert from 'node:assert/strict';

test('negative control: a test that always fails', () => {
  assert.equal(1, 2);
});
