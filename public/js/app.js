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
    // A recovery link carries the key in the FRAGMENT, which browsers never
    // send to the server: it stays out of request lines, out of edge logs and
    // out of any referrer. It is claimed once, written to this device, and
    // stripped from the address bar so a screenshot of the room does not hand
    // control of it to the room.
    const fromLink = location.hash.startsWith('#k=') ? decodeURIComponent(location.hash.slice(3)) : '';
    if (code && fromLink) {
      remember(code, fromLink, Date.now() + 12 * 3600 * 1000);
      history.replaceState({}, '', '/p/' + code);
    }
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
    onOpenDeck: (deck) => view(function editor() { return showEditor(deck); }),
    onRefresh: () => view(function home() { return showHome(); }),
  });
  if (error) {
    const box = el('p', { class: 'status', 'data-kind': 'error', role: 'status', text: error });
    main.prepend(box);
  }
}

function showEditor(deck = null) {
  renderEditor(main, {
    deck,
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
  // The same two controls the rest of the family carries, built the same way:
  // language as a row of mono codes with aria-current on the active one, and
  // theme as a single icon button that flips light and dark. They were a pair
  // of native <select> menus here, which is the one place this tool did not
  // look like its siblings.
  const langs = el('nav', { class: 'langs', 'aria-label': t('nav.language') },
    LOCALES.map((code) => el('button', {
      type: 'button',
      'data-code': code,
      'aria-current': code === locale() ? 'true' : 'false',
      title: LOCALE_NAMES[code],
      text: code.toUpperCase(),
      onClick: () => {
        setLocale(code);
        buildChrome();
        route();
      },
    })));

  const NS = 'http://www.w3.org/2000/svg';
  const moon = document.createElementNS(NS, 'svg');
  moon.setAttribute('viewBox', '0 0 24 24');
  moon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z');
  moon.append(path);

  const theme = el('button', {
    class: 'icon-btn', type: 'button', id: 'theme',
    'aria-label': t('nav.theme'), title: t('nav.theme'),
    onClick: () => {
      // Whatever is stamped on <html> wins; with nothing stamped yet, the OS
      // preference is what the visitor is currently looking at.
      const dark = document.documentElement.dataset.theme
        ? document.documentElement.dataset.theme === 'dark'
        : matchMedia('(prefers-color-scheme: dark)').matches;
      const next = dark ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('pollen.theme', next); } catch { /* storage off */ }
    },
  }, [moon]);

  document.getElementById('brand-name').textContent = t('brand.name');
  document.getElementById('brand-tagline').textContent = t('brand.tagline');
  const link = document.getElementById('brand-link');
  if (!link.dataset.wired) {
    link.dataset.wired = 'true';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      go('/');
    });
  }
  const slot = document.getElementById('lang-slot');
  clear(slot);
  slot.append(langs, theme);
}

setLocale(detectLocale(), { persist: false });
buildChrome();
addEventListener('popstate', route);
route();
