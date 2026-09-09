// Entry point and router. There is no framework and no build step for the
// browser: the platform serves these files as they are, so what is deployed is
// what is in the repository, line for line.

import { detectLocale, setLocale, locale, t, LOCALES, LOCALE_NAMES } from './i18n.js?v=1';
import { el, clear, status } from './ui.js?v=1';
import { normaliseCode } from './shared/codes.js?v=1';
import { api, ApiError } from './api.js?v=1';
import { remember, keyFor } from './rooms.js?v=1';
import { renderHome } from './views/home.js?v=1';
import { renderEditor } from './views/editor.js?v=1';
import { renderPresent } from './views/present.js?v=1';
import { renderJoin } from './views/join.js?v=1';

const main = document.getElementById('app');
let teardown = null;

function go(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  route();
}

function view(render) {
  if (teardown) teardown();
  teardown = null;
  document.body.dataset.view = render.name;
  const cleanup = render();
  if (typeof cleanup === 'function') teardown = cleanup;
}

function route() {
  const parts = location.pathname.split('/').filter(Boolean);

  if (parts.length === 0) return view(function home() { return showHome(); });

  if (parts[0] === 'p' && parts.length === 2) {
    const code = normaliseCode(parts[1]);
    const key = code && keyFor(code);
    if (!key) return view(function home() { return showHome(t('error.forbidden')); });
    return view(function present() {
      return renderPresent(main, { code, adminKey: key, onHome: () => go('/') });
    });
  }

  if (parts.length === 1) {
    const code = normaliseCode(parts[0]);
    if (!code) return view(function home() { return showHome(t('error.bad_code')); });
    return view(function join() { return renderJoin(main, { code }); });
  }

  return view(function home() { return showHome(t('error.bad_code')); });
}

function showHome(error) {
  renderHome(main, {
    onCreate: () => view(function editor() { return showEditor(); }),
    onJoin: (code) => go('/' + code),
    onPresent: (code) => go('/p/' + code),
  });
  if (error) {
    const box = el('p', { class: 'status', 'data-kind': 'error', role: 'status', text: error });
    main.prepend(box);
  }
}

function showEditor() {
  renderEditor(main, {
    onBack: () => go('/'),
    onCreate: async (questions, message) => {
      try {
        const room = await api.createRoom(questions, locale());
        remember(room.code, room.adminKey, room.expiresAt);
        go('/p/' + room.code);
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'internal';
        // retryAfter comes back in seconds; nobody counts in seconds.
        const minutes = Math.max(1, Math.ceil((err.data?.retryAfter || 0) / 60));
        status(message, t('error.' + code, { minutes }), 'error');
      }
    },
  });
}

function buildChrome() {
  const picker = el('select', {
    class: 'lang', 'aria-label': t('nav.language'),
    onChange: (event) => {
      setLocale(event.target.value);
      route();
    },
  }, LOCALES.map((code) => el('option', { value: code, selected: code === locale(), text: LOCALE_NAMES[code] })));

  document.getElementById('brand-name').textContent = t('brand.name');
  document.getElementById('brand-tagline').textContent = t('brand.tagline');
  document.getElementById('brand-link').addEventListener('click', (event) => {
    event.preventDefault();
    go('/');
  });
  const themes = ['system', 'light', 'dark'];
  let theme = 'system';
  try { theme = localStorage.getItem('pollen.theme') || 'system'; } catch { /* storage off */ }
  const themePicker = el('select', {
    class: 'lang', 'aria-label': t('nav.theme'),
    onChange: (event) => {
      const chosen = event.target.value;
      if (chosen === 'system') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', chosen);
      try { localStorage.setItem('pollen.theme', chosen); } catch { /* storage off */ }
    },
  }, themes.map((code) => el('option', { value: code, selected: code === theme, text: t('theme.' + code) })));

  clear(document.getElementById('lang-slot'));
  document.getElementById('lang-slot').append(picker, themePicker);
}

setLocale(detectLocale(), { persist: false });
buildChrome();
addEventListener('popstate', route);
route();
