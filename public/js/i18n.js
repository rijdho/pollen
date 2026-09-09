// Language is chosen once per visit: an explicit ?lang wins, then a previous
// choice on this device, then what the browser asks for. Nothing is stored
// server-side and the choice is not a cookie.

import { STRINGS, LOCALES, LOCALE_NAMES } from './locales.js?v=1';

const STORAGE_KEY = 'pollen.lang';

let current = 'en';

export { LOCALES, LOCALE_NAMES };

export function detectLocale(search = location.search, nav = navigator) {
  const asked = new URLSearchParams(search).get('lang');
  if (LOCALES.includes(asked)) return asked;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (LOCALES.includes(saved)) return saved;
  } catch { /* private mode, or storage switched off */ }
  for (const tag of nav.languages || [nav.language || 'en']) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (LOCALES.includes(base)) return base;
  }
  return 'en';
}

export function locale() {
  return current;
}

export function setLocale(code, { persist = true } = {}) {
  current = LOCALES.includes(code) ? code : 'en';
  document.documentElement.lang = current;
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, current); } catch { /* nothing to do */ }
  }
  applyTo(document);
}

/**
 * Look up a string and fill its {placeholders}.
 * A missing key returns the key itself: on a projector a visible "join.submit"
 * is far easier to notice and fix than an empty button.
 */
export function t(key, params = {}) {
  const table = STRINGS[current] || STRINGS.en;
  let out = table[key] ?? STRINGS.en[key] ?? key;
  for (const [name, value] of Object.entries(params)) {
    out = out.split('{' + name + '}').join(String(value));
  }
  return out;
}

/** Translate a subtree in place. Text only; no markup is ever inserted. */
export function applyTo(root) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of node.dataset.i18nAttr.split(',')) {
      const [attr, key] = pair.split(':');
      if (attr && key) node.setAttribute(attr.trim(), t(key.trim()));
    }
  }
}
