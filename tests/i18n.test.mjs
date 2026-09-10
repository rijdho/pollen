import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { STRINGS, LOCALES, LOCALE_NAMES } from '../public/js/locales.js?v=1';

const BASE = 'en';
const baseKeys = Object.keys(STRINGS[BASE]);

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'vendor') sourceFiles(path, out);
    } else if (name.endsWith('.js') && name !== 'locales.js') {
      out.push(path);
    }
  }
  return out;
}

// index.html is part of the corpus: the footer strings are reached through
// data-i18n attributes and appear in no JavaScript file at all. Leaving it out
// is how this check reports strings as dead while they are on every page.
const SOURCES = [...sourceFiles('public/js'), ...sourceFiles('worker/src'), 'public/index.html'];
const CODE = SOURCES.map((f) => readFileSync(f, 'utf8')).join('\n');

// Keys the application assembles at run time and therefore never writes down.
// Anything matching these prefixes is exempt from the "is it used" check; the
// prefixes themselves are pinned so the exemption cannot quietly widen.
const ASSEMBLED = ['error.', 'editor.add'];

test('every locale carries exactly the same keys', () => {
  for (const locale of LOCALES) {
    const keys = Object.keys(STRINGS[locale]);
    assert.deepEqual(
      keys.slice().sort(),
      baseKeys.slice().sort(),
      `${locale} does not match ${BASE}`,
    );
  }
});

test('the locale list and the dictionaries agree', () => {
  assert.deepEqual(Object.keys(STRINGS).sort(), LOCALES.slice().sort());
  assert.deepEqual(Object.keys(LOCALE_NAMES).sort(), LOCALES.slice().sort());
  assert.ok(LOCALES.includes('en') && LOCALES.includes('de') && LOCALES.includes('es'),
    'English, German and Spanish are the floor, not a target');
});

test('no string is empty in any language', () => {
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(STRINGS[locale])) {
      assert.equal(typeof value, 'string', `${locale}.${key}`);
      assert.notEqual(value.trim(), '', `${locale}.${key} is empty`);
    }
  }
});

test('placeholders survive translation', () => {
  // A dropped {code} or a translated {n} is invisible until it is on a wall in
  // front of a room, so it is pinned here instead.
  const placeholders = (s) => (s.match(/\{[a-z_]+\}/g) || []).sort().join(',');
  for (const key of baseKeys) {
    const expected = placeholders(STRINGS[BASE][key]);
    for (const locale of LOCALES) {
      assert.equal(placeholders(STRINGS[locale][key]), expected, `${locale}.${key}`);
    }
  }
});

test('every key the code asks for exists', () => {
  // Only complete lookups: the closing quote must be followed by ) or a comma,
  // so t('error.' + code) is left to the assembled-prefix check rather than
  // being read as a key called "error.".
  const asked = new Set([...CODE.matchAll(/\bt\(\s*'([a-zA-Z0-9._]+)'\s*[),]/g)].map((m) => m[1]));
  assert.ok(asked.size > 30, `only ${asked.size} literal lookups found; the scan is broken`);
  for (const key of asked) {
    assert.ok(key in STRINGS[BASE], `t('${key}') has no entry`);
  }
});

test('every key in the dictionary is reachable', () => {
  const unused = baseKeys.filter((key) => {
    if (ASSEMBLED.some((prefix) => key.startsWith(prefix))) return false;
    // Quoted in JavaScript, quoted in a data-i18n attribute, or after a colon
    // in a data-i18n-attr pair like title:footer.cite, where the key carries no
    // quotes of its own.
    return !CODE.includes(`'${key}'`)
      && !CODE.includes(`"${key}"`)
      && !CODE.includes(`:${key}"`)
      && !CODE.includes(`:${key};`);
  });
  assert.deepEqual(unused, [], 'these strings are translated three times and shown never');
});

test('the assembled prefixes are real, not a blanket exemption', () => {
  for (const prefix of ASSEMBLED) {
    assert.ok(
      baseKeys.some((key) => key.startsWith(prefix)),
      `${prefix} exempts nothing, so it should be removed`,
    );
  }
  assert.ok(CODE.includes("t('error.' +"), 'error keys are still assembled from a code');
});
