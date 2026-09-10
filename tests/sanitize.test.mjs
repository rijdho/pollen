import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitiseText, cloudKey, wordCount } from '../public/js/shared/sanitize.js?v=2';

const RLO = String.fromCodePoint(0x202e);
const LRI = String.fromCodePoint(0x2066);
const ZWSP = String.fromCodePoint(0x200b);
const ZWJ = String.fromCodePoint(0x200d);
const BOM = String.fromCodePoint(0xfeff);
const ACUTE = String.fromCodePoint(0x0301);

test('bidirectional overrides never reach the projector', () => {
  // Without this, a moderator approves one string and the room reads another,
  // because the override reverses what is displayed and not what is stored.
  assert.equal(sanitiseText('hello' + RLO + 'world', 40), 'helloworld');
  assert.equal(sanitiseText(LRI + 'abc', 40), 'abc');
});

test('zero-width characters cannot fork one word into two bubbles', () => {
  assert.equal(sanitiseText('fa' + ZWSP + 'ir', 40), 'fair');
  assert.equal(sanitiseText(BOM + 'fair' + ZWJ, 40), 'fair');
  assert.equal(cloudKey(sanitiseText('fa' + ZWSP + 'ir', 40)), cloudKey('fair'));
});

test('an entry is one line', () => {
  assert.equal(sanitiseText('one\ntwo\tthree', 40), 'one two three');
  assert.equal(sanitiseText('  padded   out  ', 40), 'padded out');
});

test('stacked combining marks cannot overflow their row', () => {
  const zalgo = 'e' + ACUTE.repeat(30) + 'x';
  const out = sanitiseText(zalgo, 40);
  const marks = [...out].filter((ch) => /\p{Mn}/u.test(ch)).length;
  assert.ok(marks <= 2, `expected at most two combining marks, found ${marks}`);
  assert.ok(out.endsWith('x'), 'the rest of the entry survives');
});

test('truncation counts characters, not code units', () => {
  assert.equal(sanitiseText('abcdefghij', 4), 'abcd');
  // A naive slice would cut this emoji in half and leave a lone surrogate.
  const out = sanitiseText('ab' + String.fromCodePoint(0x1f33c).repeat(4), 4);
  assert.equal([...out].length, 4);
  assert.equal(out, 'ab' + String.fromCodePoint(0x1f33c).repeat(2));
});

test('non-strings are not an error, they are empty', () => {
  assert.equal(sanitiseText(null, 10), '');
  assert.equal(sanitiseText(undefined, 10), '');
  assert.equal(sanitiseText(7, 10), '');
});

test('the cloud key folds case and edge punctuation only', () => {
  assert.equal(cloudKey('Reuse'), 'reuse');
  assert.equal(cloudKey('  reuse,  '), 'reuse');
  assert.equal(cloudKey('"FAIR!"'), 'fair');
  assert.equal(cloudKey('open access'), 'open access', 'inner spaces are part of the word');
  // Accents are meaning, not noise. Folding them would merge these two into one
  // bubble, and in Spanish that particular merge is a joke at the room's
  // expense projected in letters a foot high.
  assert.notEqual(cloudKey('año'), cloudKey('ano'));
  assert.equal(cloudKey('Año'), 'año');
});

test('word counting matches what the cap promises', () => {
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('   '), 0);
  assert.equal(wordCount('one'), 1);
  assert.equal(wordCount('one  two   three'), 3);
});
