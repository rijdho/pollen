import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { STRINGS, LOCALES, LOCALE_NAMES } from '../public/js/locales.js?v=3';

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
const ASSEMBLED = ['error.', 'editor.add', 'editor.chart_', 'editor.imageFailed_', 'editor.setFailed_'];

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

// The register, pinned. Every tool in this family writes its Spanish and German
// without addressing the reader: orcid-finder says "Encuentra las cuentas ORCID
// que declaran una institución" and "Anstellungsdatensätze werden gelesen", not
// "Busque..." or "Suchen Sie...". This one was written by translating the
// English sentence by sentence, which produced formal address throughout and
// calques like "vea llegar las respuestas". Infinitives, impersonal `se`,
// passives and noun phrases instead.
// This was a list of eleven capitalised verbs until 2026-09-21, which is a rule
// written for the instances it had already seen rather than for the class.
// Four Spanish strings walked through it in plain sight, and so did a German
// one, because the list named Ihr and Ihre but not Ihren. What follows is in
// two halves, because Spanish only lets one of them be mechanical.
//
// The pronouns and clitics ARE the class, and they are matched whatever their
// case. What they cannot do is tell a third person from the reader: "su" is
// both "their" and the polite "your", and "le" is both an indirect object and
// the person being spoken to. So the few strings where the third person really
// is a third person are named below, with who they refer to, and the test
// after this one fails if one of them stops matching. An exemption cannot
// outlive the string it was written for.
const ES_PRONOUNS = /\b(usted|ustedes|suyo|suya|suyos|suyas|su|sus|le|les)\b/i;
// The other half cannot be a class at all: an usted imperative is spelled
// exactly like a third-person subjunctive, so "tantas como haga falta" and
// "Haga clic" are the same form. This stays a list, and it is matched only
// capitalised, which is where an imperative to the reader actually lands in a
// catalogue of labels and hints. Widening it to any case put two innocent
// strings in the dock, which is how a guard gets switched off.
const ES_IMPERATIVES = /\b(Haga|Vea|Elija|Escriba|Ponga|Revise|Espere|Int[eé]ntelo|A[ñn]ada|Exporte|Act[ií]velo|Marque|Pregunte|Empiece|Comparta|Pulse|Toque|Introduzca|Seleccione|Recuerde|Podr[áa])\b/;
const ES_THIRD_PERSON = {
  'editor.showResultsHint': 'su móvil: the phone belonging to "cada persona"',
  'editor.imageFailed_detail': 'Le pasa a una diapositiva, not to the reader',
  'present.closed': 'sus respuestas: the room\'s own',
};

const addressesEs = (value) => ES_PRONOUNS.test(value) || ES_IMPERATIVES.test(value);

test('the Spanish never addresses the reader', () => {
  const offenders = Object.entries(STRINGS.es)
    .filter(([key, value]) => addressesEs(value) && !(key in ES_THIRD_PERSON))
    .map(([key]) => key);
  assert.deepEqual(offenders, [],
    'these use the usted imperative, pronoun or possessive; the rest of the family does not');
});

test('the Spanish exemptions are real, not a blanket', () => {
  for (const [key, why] of Object.entries(ES_THIRD_PERSON)) {
    assert.ok(key in STRINGS.es, `${key} is gone; remove its exemption (${why})`);
    assert.ok(addressesEs(STRINGS.es[key]),
      `${key} no longer matches the rule, so its exemption hides nothing (${why})`);
  }
});

test('the rule catches the forms that once walked through it', () => {
  // Every one of these was in the catalogue and passed the old check. A rule
  // that cannot fail on the strings that caused it to be rewritten is not a
  // rule, it is a memory.
  for (const planted of [
    'Pregunte algo', 'Todavía nadie ha preguntado. Empiece usted.', 'Suya',
    'le quedan {n} preguntas', 'Volver a abrir su sala',
    'No puede apoyar su propia pregunta.',
  ]) {
    assert.ok(addressesEs(planted), `${planted} should be refused`);
  }
  // And it still lets the register the family actually writes through.
  for (const fine of [
    'Volver a abrir la sala', 'Preguntar algo', 'Propia', 'quedan {n} preguntas',
    'Se pueden añadir tantas como haga falta.', 'Una pregunta propia no se puede apoyar.',
  ]) {
    assert.ok(!addressesEs(fine), `${fine} should pass`);
  }
});

test('the German never addresses the reader', () => {
  // The whole paradigm, not the three cases that happened to be in the
  // catalogue: Ihren walked through the old list and was in home.resume.
  const forms = /\b(Sie|Ihr|Ihre|Ihrem|Ihren|Ihrer|Ihres|Ihnen|Bitte)\b/;
  const offenders = Object.entries(STRINGS.de)
    .filter(([, value]) => forms.test(value))
    .map(([key]) => key);
  assert.deepEqual(offenders, [],
    'these use Sie, Ihr in some case, or Bitte; the rest of the family uses infinitives and passives');
  assert.ok(forms.test('Ihren Raum wieder öffnen'), 'the case that got through before is covered');
});

test('and the English does, because that is the language it was written in', () => {
  // Not a double standard: the English is the original and reads naturally with
  // "you". The point is that the other two are not translations of its grammar.
  const you = Object.values(STRINGS.en).filter((value) => /\byou\b/i.test(value));
  assert.ok(you.length > 3, 'the English addresses the reader, and that is fine');
});
