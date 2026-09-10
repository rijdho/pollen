import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { sanitiseText, cloudKey } from '../public/js/shared/sanitize.js?v=1';
import { normaliseCode } from '../public/js/shared/codes.js?v=1';
import { parseDeckFile } from '../public/js/decks.js?v=1';

// Payloads that would run if any of this reached a page as markup rather than
// as text. They are asserted to survive as inert characters, NOT to be escaped
// or stripped: the defence here is that nothing is ever parsed as HTML, and a
// test expecting escaping would be testing a defence this code does not use
// and would go green if that real defence were removed.
const XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg onload=alert(1)>',
  'javascript:alert(document.domain)',
  '<iframe src="javascript:alert(1)">',
  '{{constructor.constructor("alert(1)")()}}',
  '<a href="#" onclick="alert(1)">click</a>',
];

const SQLI = [
  "' OR 1=1 --",
  "'; DROP TABLE votes; --",
  "1' UNION SELECT nick FROM voters --",
  'admin"--',
];

const CONTROL = String.fromCodePoint(0x0000);
const ESCAPE = String.fromCodePoint(0x001b);

test('markup payloads survive as text, unescaped and unmangled', () => {
  for (const payload of XSS) {
    const out = sanitiseText(payload, 240);
    assert.equal(out.includes('&lt;'), false, 'nothing is escaped: ' + payload);
    if (payload.includes('<')) assert.ok(out.includes('<'), 'nor stripped: ' + payload);
  }
});

test('control characters never survive, whatever they are wrapped in', () => {
  const out = sanitiseText('a' + CONTROL + 'b' + ESCAPE + '[31m' + 'c', 240);
  assert.equal(out.includes(CONTROL), false);
  assert.equal(out.includes(ESCAPE), false, 'a terminal escape reaching a log is its own problem');
  assert.ok(out.startsWith('a'));
});

test('a payload longer than the cap is cut, not smuggled through', () => {
  const long = '<script>' + 'a'.repeat(5000) + '</script>';
  assert.ok([...sanitiseText(long, 40)].length <= 40);
});

test('SQL metacharacters are data, and the folding invents no quoting', () => {
  for (const payload of SQLI) {
    const out = sanitiseText(payload, 240);
    assert.ok(out.length > 0, payload);
    // No backslash is added. Escaping would mean the value is being pasted into
    // a statement somewhere, and it never is.
    assert.equal((out.match(/\\/g) || []).length, (payload.match(/\\/g) || []).length, payload);
  }
});

test('every SQL statement in the Worker is a plain literal with placeholders', () => {
  // The real defence, checked by reading the source rather than by guessing
  // inputs: a parameterised query cannot be talked out of being one query.
  const sources = ['worker/src/room.js', 'worker/src/throttle.js'];
  let statements = 0;
  for (const file of sources) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(/sql\.exec\(\s*(.)/g)) {
      statements += 1;
      const opener = match[1];
      // A quote of either kind, or the SCHEMA constant. What must never appear
      // is a backtick, because that is the only way a value could be spliced
      // into the statement itself.
      assert.ok(opener === "'" || opener === '"' || opener === 'S',
        file + ': a statement opens with ' + JSON.stringify(opener) + ', so it is not a plain literal');
      assert.notEqual(opener, '`', file + ': a statement is a template literal');
    }
  }
  assert.ok(statements > 30, 'only ' + statements + ' statements found; the scan is broken');
});

test('nothing anywhere parses a string as markup or as code', () => {
  const banned = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|\beval\(|new Function\(/;
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (name.endsWith('.js')) out.push(path);
    }
    return out;
  };
  const files = [...walk('public/js'), ...walk('worker/src')];
  const offenders = files
    .filter((f) => banned.test(readFileSync(f, 'utf8')))
    // ui.js names innerHTML exactly once, inside the guard that refuses it.
    .filter((f) => !f.endsWith('ui.js'));
  assert.deepEqual(offenders, []);
  assert.ok(files.length > 12, 'only ' + files.length + ' files scanned');
});

test('el() refuses to be handed markup at all', async () => {
  const { el } = await import('../public/js/ui.js?v=1');
  assert.throws(() => el('div', { html: '<b>x</b>' }), /markup is never inserted/);
});

test('a room code cannot carry a path, a scheme or a lookalike', () => {
  const attempts = [
    '../../etc/passwd', 'ABCDEF/../ZZZZZZ', 'javascript:x', '%2e%2e%2f', 'AB CDEF',
    'ABCDE*', "ABC'EF", '<b>ABC</b>', 'ABCDEF\n', 'A'.repeat(200),
    String.fromCodePoint(0xff21).repeat(6),
  ];
  for (const attempt of attempts) {
    assert.equal(normaliseCode(attempt), null, JSON.stringify(attempt) + ' was accepted');
  }
});

test('an imported set cannot bring its own prototype', () => {
  const attack = '{"format":"pollen.deck/1","name":"x",'
    + '"questions":[{"type":"choice","prompt":"p"}],'
    + '"__proto__":{"polluted":true}}';
  const deck = parseDeckFile(attack);
  assert.ok(deck, 'a well-formed file is still accepted');
  assert.equal({}.polluted, undefined, 'Object.prototype was touched');
  assert.equal(Object.prototype.polluted, undefined);
});

test('an imported set that is not one is refused rather than half-read', () => {
  for (const bad of [
    '', 'null', '[]', '{}', '{"format":"pollen.deck/1"}',
    '{"format":"other","questions":[{"type":"choice","prompt":"p"}]}',
    '{"format":"pollen.deck/1","questions":[]}',
    '{"format":"pollen.deck/1","questions":[{"nope":1}]}',
    '{"format":"pollen.deck/1","questions":"not an array"}',
  ]) {
    assert.equal(parseDeckFile(bad), null, JSON.stringify(bad));
  }
});

test('one answer cannot be made to absorb another', () => {
  // Cloud entries merge only when they are the same word, so no payload lets
  // somebody overwrite or swallow a different answer.
  assert.notEqual(cloudKey('a'), cloudKey('b'));
  assert.notEqual(cloudKey('fair'), cloudKey('fair x'));
  assert.equal(cloudKey('  FAIR!  '), cloudKey('fair'));
});
