import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { CODE_ALPHABET, generateCode, normaliseCode, isCode } from '../public/js/shared/codes.js?v=1';

test('the alphabet excludes every shape collision and every vowel', () => {
  for (const banned of ['0', 'O', '1', 'I', 'L', 'A', 'E', 'U']) {
    assert.equal(CODE_ALPHABET.includes(banned), false, `${banned} must not be in the alphabet`);
  }
  assert.equal(CODE_ALPHABET.length, 28);
  assert.equal(new Set(CODE_ALPHABET).size, 28, 'no character appears twice');
});

test('generated codes are six characters from the alphabet', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateCode(webcrypto);
    assert.equal(code.length, 6);
    for (const ch of code) assert.ok(CODE_ALPHABET.includes(ch), `${ch} is not in the alphabet`);
  }
});

test('rejection sampling leaves no character starved', () => {
  // 252 of 256 bytes are accepted, and 252 is 9 times 28, so every character
  // must appear with the same probability. A modulo bias would show up as the
  // first characters of the alphabet running ahead of the rest.
  const seen = new Map([...CODE_ALPHABET].map((ch) => [ch, 0]));
  for (let i = 0; i < 3000; i += 1) {
    for (const ch of generateCode(webcrypto)) seen.set(ch, seen.get(ch) + 1);
  }
  const counts = [...seen.values()];
  const expected = (3000 * 6) / 28;
  for (const [ch, n] of seen) {
    assert.ok(Math.abs(n - expected) < expected * 0.35, `${ch} appeared ${n} times, expected about ${expected}`);
  }
  assert.equal(counts.reduce((a, b) => a + b, 0), 18000);
});

test('typed codes fold case and separators but never guess a character', () => {
  assert.equal(normaliseCode('k7rm2q'), 'K7RM2Q');
  assert.equal(normaliseCode(' K7 RM-2Q '), 'K7RM2Q');
  assert.equal(normaliseCode('k7rm2q.'), 'K7RM2Q');
  // O is not in the alphabet, so it could have been a misread D or Q. Guessing
  // would send someone into a stranger's room.
  assert.equal(normaliseCode('K7RM2O'), null);
  assert.equal(normaliseCode('K7RM2'), null);
  assert.equal(normaliseCode('K7RM2QQ'), null);
  assert.equal(normaliseCode(null), null);
  assert.equal(normaliseCode(42), null);
});

test('isCode accepts only the canonical form', () => {
  assert.equal(isCode('K7RM2Q'), true);
  assert.equal(isCode('k7rm2q'), false);
});
