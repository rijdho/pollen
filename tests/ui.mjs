// Drives the real interface in a real browser. Not part of `npm test`, because
// it needs both a server and a Chrome: start `npm run dev`, then
//
//   npm i puppeteer --no-save     # or set CHROME_PATH
//   npm run ui
//
// tests/live.mjs proves the server keeps its side of the contract. This proves
// the pages are wired to it: that a set can be saved, that a room opens, that a
// phone never receives the right answer, that the scoreboard fills, and that a
// recovery link hands the room to another device.
//
// Never click a control that opens confirm(): a modal dialog blocks the whole
// automation session and the run hangs with no output. "End and delete" is
// therefore done over the API at the end.

import puppeteer from 'puppeteer';
import { statSync, rmSync } from 'node:fs';
import { makePhotoPng, makeNoisePng } from './pngfixture.mjs';

const BASE = process.env.POLLEN_BASE || 'http://127.0.0.1:8788';
const out = [];
const ok = (label, cond, detail) => (console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ' :: ' + JSON.stringify(detail)}`), out.push(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ' :: ' + JSON.stringify(detail)}`));

async function api(path, { method = 'GET', body, key, who } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (key) headers['x-pollen-key'] = key;
  if (who) headers['x-pollen-voter'] = who;
  const res = await fetch(BASE + path, { method, headers, body: body && JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
  return res.json();
}

// Every request either page makes, recorded from the first navigation, so a
// self-hosted copy can be shown to talk only to itself. Reasoning that the
// paths are relative is not the same as watching where they go.
const requested = [];
const sockets = [];

// WebSocket handshakes do not arrive as page 'request' events, so they need the
// devtools protocol. Without this the socket check was reading an empty list
// and passing on nothing.
async function watchSockets(target) {
  const cdp = await target.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', ({ url }) => sockets.push(url));
}

const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('request', (r) => requested.push(r.url()));
await watchSockets(page);
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.card-lead .btn-brand', { timeout: 8000 });

// Build a set with all four question types, including a right answer.
const built = await page.evaluate(async () => {
  const type = (n, v) => { n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); };
  document.querySelector('.card-lead .btn-brand').click();
  await new Promise((r) => setTimeout(r, 200));
  const addButtons = [...document.querySelectorAll('.add-row .btn')];
  const labels = addButtons.map((b) => b.textContent);
  type(document.querySelector('.q-card input[type=text]'), 'Which year did it start?');
  const opts = document.querySelectorAll('.q-card .opt-row input[type=text]');
  type(opts[0], '1994'); type(opts[1], '2007');
  // Tick the second option as the right answer.
  document.querySelectorAll('.q-card .opt-row input[type=checkbox]')[1].click();
  addButtons.find((b) => b.textContent.includes('Audience')).click();
  await new Promise((r) => setTimeout(r, 150));
  type(document.querySelectorAll('.q-card')[1].querySelector('input[type=text]'), 'Anything to ask?');
  // Save the set to this device.
  const nameField = [...document.querySelectorAll('.input')].find((i) => i.placeholder && i.placeholder.match(/Name|Nombre|Name f/));
  type(nameField, 'Verification set');
  [...document.querySelectorAll('.card .btn')].find((b) => b.textContent.match(/^Save this set|Diesen Satz|Guardar este/))?.click();
  await new Promise((r) => setTimeout(r, 150));
  return {
    types: labels,
    saved: JSON.parse(localStorage.getItem('pollen.decks') || '[]').length,
    questions: document.querySelectorAll('.q-card').length,
  };
});
ok('every question type is offered', built.types.length === 5, built.types);

{
  // The two chrome controls, in the shape the rest of the family uses: a row of
  // language codes with aria-current on the active one, and one icon button
  // that flips the theme. They were native <select> menus, which was the only
  // place this tool did not look like its siblings.
  const chrome = await page.evaluate(async () => {
    const codes = [...document.querySelectorAll('.langs button')];
    const before = {
      codes: codes.map((b) => b.textContent),
      current: codes.filter((b) => b.getAttribute('aria-current') === 'true').map((b) => b.textContent),
      selects: document.querySelectorAll('.site-head select').length,
      iconButtons: document.querySelectorAll('.icon-btn').length,
    };
    const wasDark = document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelector('.icon-btn').click();
    await new Promise((r) => setTimeout(r, 150));
    before.themeFlipped = (document.documentElement.dataset.theme === 'dark') !== wasDark;
    document.querySelector('.icon-btn').click();
    await new Promise((r) => setTimeout(r, 150));
    return before;
  });
  ok('language is a row of codes, not a dropdown',
    chrome.codes.join('') === 'ENDEES' && chrome.selects === 0, chrome);
  ok('and exactly one of them is marked current', chrome.current.length === 1, chrome.current);
  ok('theme is one icon button that flips light and dark',
    chrome.iconButtons === 1 && chrome.themeFlipped, chrome);

  const radius = await page.evaluate(() => ({
    card: getComputedStyle(document.querySelector('.card')).borderRadius,
    control: getComputedStyle(document.querySelector('.btn')).borderRadius,
  }));
  ok('corners are the lowered radius, not the family default',
    radius.card === '8px' && radius.control === '4px', radius);
}

{
  // On a scratch question added for the purpose, then removed. Doing this to
  // question one wiped its right answer, because retype drops what the new
  // type has no meaning for, and every later check that needed a scoreboard
  // then failed: a test that corrupts the state it shares is worse than no
  // test.
  const retyped = await page.evaluate(async () => {
    [...document.querySelectorAll('.add-row .btn')][0].click();
    await new Promise((r) => setTimeout(r, 200));
    const cards = () => [...document.querySelectorAll('.q-card')];
    const scratch = cards()[cards().length - 1];
    const field = scratch.querySelector('input[type=text]');
    field.value = 'Scratch question';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    const picker = scratch.querySelector('.q-type');
    picker.value = 'rank';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const after = cards()[cards().length - 1];
    return {
      prompt: after.querySelector('input[type=text]').value,
      type: after.querySelector('.q-type').value,
    };
  });
  ok('a question is not stuck as the type it was created with',
    retyped.type === 'rank', retyped);
  ok('and changing the type keeps the question already written',
    retyped.prompt === 'Scratch question', retyped);

  const order = await page.evaluate(async () => {
    const prompts = () => [...document.querySelectorAll('.q-card')]
      .map((c) => c.querySelector('input[type=text]').value);
    const arrows = (glyph) => [...document.querySelectorAll('.q-card .q-tools .btn')]
      .filter((b) => b.textContent === glyph);
    const out = {
      firstUpDisabled: arrows('↑')[0].disabled,
      lastDownDisabled: arrows('↓').pop().disabled,
      before: prompts(),
    };
    // Walk the scratch question to the top and back down again.
    const last = arrows('↑').length - 1;
    arrows('↑')[last].click();
    await new Promise((r) => setTimeout(r, 200));
    out.after = prompts();
    arrows('↓')[last - 1].click();
    await new Promise((r) => setTimeout(r, 200));
    out.restored = prompts();
    // And remove it, so the room that opens is the one the rest of the run
    // expects.
    [...document.querySelectorAll('.q-card')].pop()
      .querySelectorAll('.q-tools .btn')[2].click();
    await new Promise((r) => setTimeout(r, 200));
    out.remaining = document.querySelectorAll('.q-card').length;
    return out;
  });
  ok('questions can be reordered after they are all written',
    order.after[order.after.length - 2] === 'Scratch question'
    && order.restored[order.restored.length - 1] === 'Scratch question', order);
  ok('and the arrows are disabled at the ends rather than silently doing nothing',
    order.firstUpDisabled && order.lastDownDisabled, order);
  ok('the scratch question left no trace', order.remaining === 2, order.remaining);
}

ok('a set can be saved to the device', built.saved === 1, built);

await page.evaluate(async () => {
  [...document.querySelectorAll('.actions-end .btn')].pop().click();
  await new Promise((r) => setTimeout(r, 1200));
});
{
  // The tool's own creation limit is thirty rooms an hour per address, and this
  // suite opens four. Running it eight times in an hour exhausts it, and
  // without this the run died on a TypeError twenty lines later that said
  // nothing about why.
  const opened = await page.evaluate(() => ({
    path: location.pathname,
    message: document.querySelector('.status')?.textContent || null,
  }));
  if (!/^\/p\//.test(opened.path)) {
    console.log(`FAIL the room did not open :: ${JSON.stringify(opened)}`);
    console.log('\nIf that message is about too many rooms, this is the creation');
    console.log('throttle, not a defect. Wait for the window and run it again.');
    await browser.close();
    process.exit(1);
  }
}
const room = await page.evaluate(() => ({
  path: location.pathname,
  code: document.querySelector('.join-code')?.textContent,
  key: JSON.parse(localStorage.getItem('pollen.rooms'))[0].adminKey,
  hasAdder: !!document.querySelector('.adder'),
  hasRecovery: !!document.querySelector('.recovery'),
}));
ok('the room opened', /^\/p\/[A-Z0-9]{6}$/.test(room.path), room.path);
ok('the presenter can add a question mid-session', room.hasAdder);
ok('and reopen the room elsewhere', room.hasRecovery);

// Start the quiz question and answer it from a second page.
await page.evaluate(async () => {
  [...document.querySelectorAll('.controls .btn')].find((b) => b.textContent.match(/^Start|Starten|Empezar/)).click();
  await new Promise((r) => setTimeout(r, 400));
});

console.error('  -- opening the phone');
const phone = await browser.newPage();
await phone.setViewport({ width: 420, height: 900 });
phone.on('pageerror', (e) => errors.push('phone: ' + String(e.message)));
phone.on('request', (r) => requested.push(r.url()));
await watchSockets(phone);
await phone.goto(`${BASE}/${room.code}`, { waitUntil: 'domcontentloaded' });
await phone.waitForSelector('.join-stage', { timeout: 8000 });
const phoneState = await phone.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 600));
  return {
    nickOffered: !!document.querySelector('.nick-form'),
    leaksAnswer: document.body.innerHTML.includes('correct'),
    options: [...document.querySelectorAll('.choice')].map((c) => c.textContent),
  };
});
ok('a name is offered because the room can be scored', phoneState.nickOffered);
ok('and the right answer is nowhere in the phone page', !phoneState.leaksAnswer);

await phone.evaluate(async () => {
  const input = document.querySelector('.nick-form input');
  input.value = 'Ana';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.nick-form button').click();
  await new Promise((r) => setTimeout(r, 500));
  document.querySelectorAll('.choice')[1].click();
  document.querySelector('.btn-block').click();
  await new Promise((r) => setTimeout(r, 600));
});

console.error('  -- reading the scoreboard');
const board = await page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 600));
  return {
    visible: !document.querySelector('.scores')?.hidden,
    rows: [...document.querySelectorAll('.score-row')].map((r) => r.textContent),
    revealButton: [...document.querySelectorAll('.controls .btn')].some((b) => b.textContent.match(/Show the answer|Antwort zeigen|Mostrar la respuesta/)),
  };
});
ok('the scoreboard appears on the projector', board.visible, board);
ok('with the player who chose a name', board.rows.some((r) => r.includes('Ana')), board.rows);
ok('and the presenter can reveal the answer', board.revealButton);

await page.evaluate(async () => {
  [...document.querySelectorAll('.controls .btn')].find((b) => b.textContent.match(/Show the answer|Antwort zeigen|Mostrar la respuesta/)).click();
  await new Promise((r) => setTimeout(r, 500));
});
const revealed = await page.evaluate(() => ({
  flagged: !!document.querySelector('.bar-row.is-right'),
  flagText: document.querySelector('.right-flag')?.textContent,
}));
ok('the right option is marked once revealed', revealed.flagged, revealed);

const phoneVerdict = await phone.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 700));
  return document.querySelector('.verdict')?.textContent || null;
});
ok('and the phone is told how it did', phoneVerdict !== null, phoneVerdict);

// Audience questions.
await page.evaluate(async () => {
  [...document.querySelectorAll('.controls .btn')].find((b) => b.textContent.match(/^Next|Weiter|Siguiente/)).click();
  await new Promise((r) => setTimeout(r, 500));
});
console.error('  -- asking a question');
const asked = await phone.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 700));
  const input = document.querySelector('input.input');
  input.value = 'How is this paid for?';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.btn-block').click();
  await new Promise((r) => setTimeout(r, 700));
  return { list: document.querySelector('.qa-list')?.textContent, own: !!document.querySelector('.qa-own') };
});
ok('a phone can ask the room a question', typeof asked.list === 'string', asked);

console.error('  -- moderating it');
const moderated = await page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 500));
  const queue = [...document.querySelectorAll('.queue-item')];
  const texts = queue.map((q) => q.querySelector('.queue-text').textContent);
  queue[0]?.querySelector('.btn-brand')?.click();
  await new Promise((r) => setTimeout(r, 600));
  return { queued: texts, board: [...document.querySelectorAll('.qa-board-item')].map((i) => i.textContent) };
});
ok('an audience question waits for approval', moderated.queued.length === 1, moderated.queued);
ok('and reaches the projector once approved', moderated.board.length === 1, moderated.board);


{
  // The three chart kinds, driven through the presenter's own add-a-question
  // panel so the setting travels the whole way: form, server, and back out to
  // the projected screen.
  for (const [kind, selector] of [['Donut', '.donut-svg'], ['Dots', '.dots-grid']]) {
    const drawn = await page.evaluate(async (k, sel) => {
      const open = document.querySelector('.adder');
      open.open = true;
      await new Promise((r) => setTimeout(r, 150));
      [...open.querySelectorAll('.actions .btn')]
        .find((b) => /Multiple choice|Auswahlfrage|Opción múltiple/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 200));
      const type = (n, v) => { n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); };
      type(open.querySelector('input[type=text]'), 'Chart ' + k);
      const opts = open.querySelectorAll('.opt-row input[type=text]');
      type(opts[0], 'One'); type(opts[1], 'Two');
      const picker = [...open.querySelectorAll('select')]
        .find((sel2) => [...sel2.options].some((o) => o.textContent === k));
      picker.value = k.toLowerCase();
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      [...open.querySelectorAll('.btn-lg')].pop().click();
      await new Promise((r) => setTimeout(r, 700));
      open.open = false;
      // Walk to it and put one answer in.
      for (let i = 0; i < 12; i += 1) {
        const next = [...document.querySelectorAll('.controls .btn')]
          .find((b) => /^Next|^Weiter|^Siguiente/.test(b.textContent));
        if (!next || next.disabled) break;
        next.click();
        await new Promise((r) => setTimeout(r, 220));
      }
      return document.querySelector('.stage-prompt')?.textContent;
    }, kind, selector);
    ok(`a question can be set to draw as ${kind.toLowerCase()}`, drawn === 'Chart ' + kind, drawn);
  }

  // Both need an answer before anything is drawn.
  const rendered = await page.evaluate(async () => {
    const room = location.pathname.split('/').pop();
    const voter = 'chartprobe01';
    const idx = Number(document.querySelector('.stage-step').textContent.match(/\d+/)[0]) - 1;
    await fetch(`/api/rooms/${room}/vote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pollen-voter': voter },
      body: JSON.stringify({ idx, value: [0] }),
    });
    await new Promise((r) => setTimeout(r, 800));
    return { dots: !!document.querySelector('.dots-grid .dot') };
  });
  ok('and dots are drawn one per answer', rendered.dots, rendered);
}

{
  // The join block is a quarter of the projected screen and stops earning it
  // after the first minute, so it collapses. Measured rather than eyeballed.
  const heights = await page.evaluate(async () => {
    const head = document.querySelector('.present-head');
    const before = head.getBoundingClientRect().height;
    head.querySelector('.join-toggle').click();
    await new Promise((r) => setTimeout(r, 200));
    const after = head.getBoundingClientRect().height;
    const codeStillShown = !!document.querySelector('.join-code-small');
    head.querySelector('.join-toggle').click();
    await new Promise((r) => setTimeout(r, 200));
    return { before, after, codeStillShown, restored: head.getBoundingClientRect().height };
  });
  ok('collapsing the join block gives the screen back',
    heights.after < heights.before / 2, heights);
  ok('and the code stays readable for whoever arrives late', heights.codeStillShown, heights);
  ok('and it opens again', Math.abs(heights.restored - heights.before) < 2, heights);

  // Full screen is refused without a gesture the browser recognises, so the
  // mode is checked by driving the attribute the button sets rather than by
  // pretending the request succeeded.
  const presenting = await page.evaluate(async () => {
    document.body.dataset.presenting = 'true';
    await new Promise((r) => setTimeout(r, 100));
    const hidden = (sel) => {
      const node = document.querySelector(sel);
      return !node || getComputedStyle(node).display === 'none';
    };
    const out = {
      headerHidden: hidden('.site-head'),
      footerHidden: hidden('.site-foot'),
      toolsHidden: hidden('.present-tools'),
      promptSize: parseFloat(getComputedStyle(document.querySelector('.stage-prompt')).fontSize),
    };
    document.body.dataset.presenting = 'false';
    await new Promise((r) => setTimeout(r, 100));
    out.promptSizeNormal = parseFloat(getComputedStyle(document.querySelector('.stage-prompt')).fontSize);
    return out;
  });
  ok('presenting mode hides this page\'s own chrome',
    presenting.headerHidden && presenting.footerHidden && presenting.toolsHidden, presenting);
  ok('and gives the question the space it frees',
    presenting.promptSize > presenting.promptSizeNormal, presenting);
  ok('there is a button for it',
    await page.evaluate(() => [...document.querySelectorAll('.controls .btn')]
      .some((b) => /Full screen|Vollbild|Pantalla completa/.test(b.textContent))));
}

// Ranking, ordered from a phone with the buttons rather than by dragging.
console.log('');
await page.evaluate(async () => {
  const open = document.querySelector('.adder');
  open.open = true;
  await new Promise((r) => setTimeout(r, 150));
  [...open.querySelectorAll('.actions .btn')].find((b) => b.textContent.match(/Ranking|Reihenfolge|Ordenar/)).click();
  await new Promise((r) => setTimeout(r, 200));
  const type = (n, v) => { n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); };
  type(open.querySelector('input[type=text]'), 'Order these');
  // Switching type carries the options already written, so the draft arrives
  // with however many the previous type had, not with a fixed three.
  while (open.querySelectorAll('.opt-row').length < 3) {
    [...open.querySelectorAll('.btn')].find((b) => b.textContent.match(/Add option|Antwort hinzu|Añadir opción/)).click();
    await new Promise((r) => setTimeout(r, 120));
  }
  const opts = open.querySelectorAll('.opt-row input[type=text]');
  type(opts[0], 'Cost'); type(opts[1], 'Speed'); type(opts[2], 'Quality');
  // Share the tally with the phones, which is off unless asked for.
  [...open.querySelectorAll('.check input')].pop().click();
  [...open.querySelectorAll('.btn-lg')].pop().click();
  await new Promise((r) => setTimeout(r, 600));
  const last = document.querySelectorAll('.controls .btn');
  // Walk to the question just added.
  for (let i = 0; i < 6; i += 1) {
    const next = [...last].find((b) => b.textContent.match(/^Next|Weiter|Siguiente/));
    if (!next || next.disabled) break;
    next.click();
    await new Promise((r) => setTimeout(r, 250));
  }
});
const ranking = await phone.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const items = [...document.querySelectorAll('.rank-item .rank-label')].map((n) => n.textContent);
  if (items.length === 0) return { items };
  // Move the last option to the top with its own button.
  const ups = [...document.querySelectorAll('.rank-item .rank-tools .btn')].filter((b) => b.textContent === '↑');
  ups[ups.length - 1].click();
  await new Promise((r) => setTimeout(r, 150));
  const after = [...document.querySelectorAll('.rank-item .rank-label')].map((n) => n.textContent);
  document.querySelector('.btn-block').click();
  await new Promise((r) => setTimeout(r, 900));
  return { items, after, results: document.querySelector('.phone-results')?.textContent || null };
});
// One press moves one place, which is the whole point of buttons over a drag.
ok('a phone can reorder a ranking with the buttons',
  ranking.items.length === 3
  && ranking.after[1] === ranking.items[2]
  && ranking.after[2] === ranking.items[1], ranking);
ok('and sees the tally when the question shares it',
  typeof ranking.results === 'string' && ranking.results.length > 0, ranking.results);

const rankBoard = await page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 600));
  return [...document.querySelectorAll('.rank-board-item')].map((i) => i.textContent);
});
ok('and the projector shows the average position', rankBoard.length === 3, rankBoard);

// No page ever reads as a stringified nothing. DOM append() turns a null child
// into the word "null", and it reached a screen three times: twice on the
// presenter view and once on the home page, which this check was not looking at
// because it had been written for the two pages that happened to be open.
// EVERY view goes through it now, in the state a first-time visitor sees.
const fresh = await browser.createBrowserContext();
async function noStrayNothing(name, target) {
  const stray = await target.evaluate(() => {
    const text = document.body.innerText;
    return ['null', 'undefined', 'false', 'NaN', '[object Object]']
      .filter((word) => new RegExp('(^|\\s)' + word + '(\\s|$)').test(text));
  });
  ok(`no stringified nothing on ${name}`, stray.length === 0, stray);
}

await noStrayNothing('the projector', page);
await noStrayNothing('the phone', phone);

{
  // A device that has never opened a room and has saved nothing, which is the
  // state the home page got wrong.
  const visitor = await fresh.newPage();
  await visitor.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await visitor.waitForSelector('.card-lead .btn-brand', { timeout: 8000 });
  await noStrayNothing('the home page, on a device with nothing saved', visitor);

  await visitor.click('.card-lead .btn-brand');
  await visitor.waitForSelector('.q-card', { timeout: 8000 });
  await noStrayNothing('the editor', visitor);

  // And on the home page of a device that has opened a room, which is the other
  // branch of the same conditional.
  await noStrayNothing('the home page, on a device that has opened a room',
    await (async () => {
      const returning = await browser.newPage();
      await returning.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await returning.waitForSelector('.card-lead .btn-brand', { timeout: 8000 });
      return returning;
    })());
}
await fresh.close();

// A payload, in a browser, on the screen it would be projected on. This is the
// only place that can prove the page renders it as characters rather than as an
// element: everything before it proves the server stores it faithfully, which
// is necessary and not sufficient.
console.log('');
{
  const PAYLOAD = '<img src=x onerror="window.__pwned = true">';
  const attacked = await api('/api/rooms', {
    method: 'POST',
    body: { questions: [{ type: 'cloud', prompt: PAYLOAD }] },
  });
  await api(`/api/rooms/${attacked.code}/admin`, {
    method: 'POST', key: attacked.adminKey,
    body: { action: 'goto', payload: { idx: 0 } },
  });
  await api(`/api/rooms/${attacked.code}/vote`, {
    method: 'POST', who: 'payload00000', body: { idx: 0, value: PAYLOAD.slice(0, 30) },
  });

  const victim = await browser.newPage();
  const victimErrors = [];
  victim.on('pageerror', (e) => victimErrors.push(String(e.message)));
  await victim.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await victim.evaluate((c, k) => {
    localStorage.setItem('pollen.rooms', JSON.stringify([{ code: c, adminKey: k, expiresAt: Date.now() + 3600e3 }]));
  }, attacked.code, attacked.adminKey);
  await victim.goto(`${BASE}/p/${attacked.code}`, { waitUntil: 'domcontentloaded' });
  await victim.waitForSelector('.stage-prompt', { timeout: 8000 });

  const result = await victim.evaluate(async (payload) => {
    await new Promise((r) => setTimeout(r, 800));
    return {
      pwned: window.__pwned === true,
      // Only what this payload would have created. Counting every <script>
      // counted the page's own two and made this fail while proving nothing.
      injectedElements: document.querySelectorAll('img[src="x"], iframe, [onerror], [onload]').length,
      promptShowsCharacters: document.querySelector('.stage-prompt').textContent === payload,
      cloudWords: [...document.querySelectorAll('.cloud-svg text')].map((t) => t.textContent),
    };
  }, PAYLOAD);

  ok('a markup payload never runs on the projected screen', result.pwned === false, result);
  ok('and creates no element of its own', result.injectedElements === 0, result);
  ok('it is read out as the characters that were typed', result.promptShowsCharacters, result);
  ok('including inside the word cloud, which draws text into an SVG',
    result.cloudWords.length === 1 && result.cloudWords[0].includes('<img'), result.cloudWords);
  ok('and the page raised no error doing it', victimErrors.length === 0, victimErrors);

  const phoneVictim = await browser.newPage();
  await phoneVictim.goto(`${BASE}/${attacked.code}`, { waitUntil: 'domcontentloaded' });
  await phoneVictim.waitForSelector('.join-stage', { timeout: 8000 });
  const onPhone = await phoneVictim.evaluate(async (payload) => {
    await new Promise((r) => setTimeout(r, 600));
    return {
      pwned: window.__pwned === true,
      injected: document.querySelectorAll('img[src="x"], iframe, [onerror], [onload]').length,
      shows: document.querySelector('.card-title')?.textContent === payload,
    };
  }, PAYLOAD);
  ok('nor on the phone', onPhone.pwned === false && onPhone.injected === 0, onPhone);
  ok('where it is also read out as characters', onPhone.shows, onPhone);

  await victim.close();
  await phoneVictim.close();
  await api(`/api/rooms/${attacked.code}/admin`, {
    method: 'POST', key: attacked.adminKey, body: { action: 'close' },
  });
}

{
  // The question a self-hoster actually has: does a clone end up using someone
  // else's Worker? Everything above ran against this origin, so every request
  // either page made should have stayed on it.
  const origin = new URL(BASE).origin;
  const elsewhere = [...new Set(requested)]
    .filter((url) => url.startsWith('http'))
    .filter((url) => new URL(url).origin !== origin);
  // Confirmatory, and worth being honest about: it was not possible to make
  // this go red by planting a defect, because three independent layers stop a
  // cross-origin call before it happens. Every URL in the code is relative;
  // connect-src 'self' forbids the connection; and the API sends no CORS
  // headers, so even with the policy loosened the browser refuses the reply.
  // Loosening the policy AND hardcoding the production host still only produced
  // "no connection". This check watches a real session and confirms what those
  // three already guarantee.
  ok('a running copy talks only to the origin that served it', elsewhere.length === 0, elsewhere);
  ok('and it made real requests, so this is not an empty check',
    requested.filter((u) => u.includes('/api/')).length > 10, requested.length);
  ok('including its WebSockets, which are the long-lived ones',
    sockets.length > 0 && sockets.every((u) => new URL(u).host === new URL(BASE).host),
    { opened: sockets.length, sample: sockets.slice(0, 2) });
}

// The recovery link: a second device, with nothing in its storage, claiming the
// room from the fragment alone.
console.log('');
const second = await browser.newPage();
await second.goto(`${BASE}/p/${room.code}#k=${encodeURIComponent(room.key)}`, { waitUntil: 'domcontentloaded' });
await second.waitForSelector('.join-code, .status', { timeout: 8000 });
const recovered = await second.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 700));
  return {
    code: document.querySelector('.join-code')?.textContent || null,
    controls: document.querySelectorAll('.controls .btn').length,
    hash: location.hash,
    path: location.pathname,
    storedCodes: JSON.parse(localStorage.getItem('pollen.rooms') || '[]').map((r) => r.code),
  };
});
ok('a recovery link opens the room on a device that had nothing',
  recovered.code === room.code && recovered.controls > 0, recovered);
ok('the key is claimed and taken out of the address bar',
  recovered.hash === '' && recovered.storedCodes.includes(room.code), recovered);

// An isolated context, because a second tab in the same browser shares local
// storage and would already be holding the key claimed above. That mistake
// made this check pass while proving nothing.
const strangerContext = await browser.createBrowserContext();
const stranger = await strangerContext.newPage();
await stranger.goto(`${BASE}/p/${room.code}`, { waitUntil: 'domcontentloaded' });
await stranger.waitForSelector('.status, .join-code', { timeout: 8000 });
const refused = await stranger.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 500));
  return { controls: document.querySelectorAll('.controls .btn').length, message: document.querySelector('.status')?.textContent || null };
});
ok('and without it the presenter view is refused', refused.controls === 0, refused);
await strangerContext.close();

// The picture on a question, end to end through a real browser: this is the
// only place the rescale-and-re-encode loop in imagefile.js can run at all,
// because it needs a canvas. Node cannot see it, so if this block goes it goes
// untested wholesale.
{
  const shot = await browser.newPage();
  const shotErrors = [];
  shot.on('pageerror', (e) => shotErrors.push(String(e.message)));
  await shot.setViewport({ width: 1280, height: 900 });
  await shot.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await shot.waitForSelector('.card-lead .btn-brand', { timeout: 8000 });
  await shot.evaluate(() => document.querySelector('.card-lead .btn-brand').click());
  await shot.waitForSelector('.q-card input[type=file]', { timeout: 8000 });
  await shot.evaluate(() => {
    const n = document.querySelector('.q-card input[type=text]');
    n.value = 'Which of these two plots?';
    n.dispatchEvent(new Event('input', { bubbles: true }));
    const o = document.querySelectorAll('.q-card .opt-row input[type=text]');
    o[0].value = 'left'; o[0].dispatchEvent(new Event('input', { bubbles: true }));
    o[1].value = 'right'; o[1].dispatchEvent(new Event('input', { bubbles: true }));
  });

  // A photograph-sized, noisy image: 2400x1600 is larger than the 1280 cap, so
  // the rescale runs, and the noise stops the encoder reaching the size cap for
  // free the way a flat colour would.
  const picture = new URL('../.tmp-ui-picture.png', import.meta.url).pathname;
  makePhotoPng(picture, 2400, 1600);
  const before = statSync(picture).size;
  const input = await shot.$('.q-card input[type=file]');
  await input.uploadFile(picture);
  await shot.waitForSelector('.q-image-thumb', { timeout: 15000 });

  const shrunk = await shot.evaluate(() => ({
    note: document.querySelector('.q-image .hint[role=status]')?.textContent || '',
    src: document.querySelector('.q-image-thumb')?.getAttribute('src') || '',
    hasAlt: !!document.querySelector('.q-image input[type=text]'),
  }));
  const kb = Number((shrunk.note.match(/(\d+)\s*KB/) || [])[1]);
  ok('a photograph larger than the cap is accepted, not refused',
    shrunk.src.startsWith('data:image/'), shrunk.src.slice(0, 40));
  ok('and comes out under a hundred kilobytes', kb > 0 && kb <= 100, { kb, before });
  ok('the browser did the shrinking, not the presenter', before > 400 * 1024, before);
  ok('a description can be written once there is a picture', shrunk.hasAlt);

  // The other branch, which a picture that fits can never reach: an image no
  // quality setting will squeeze under the cap is refused, and the refusal
  // names a cause the presenter can act on rather than apologising.
  {
    const impossible = new URL('../.tmp-ui-noise.png', import.meta.url).pathname;
    makeNoisePng(impossible, 2400, 1600);
    const solo = await browser.newPage();
    await solo.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await solo.waitForSelector('.card-lead .btn-brand', { timeout: 8000 });
    await solo.evaluate(() => document.querySelector('.card-lead .btn-brand').click());
    await solo.waitForSelector('.q-card input[type=file]', { timeout: 8000 });
    await (await solo.$('.q-card input[type=file]')).uploadFile(impossible);
    await solo.waitForFunction(
      () => (document.querySelector('.q-image [role=status]')?.textContent || '').length > 20
        && !document.querySelector('.q-image [role=status]').textContent.includes('…'),
      { timeout: 20000 },
    );
    const refusal = await solo.evaluate(() => ({
      note: document.querySelector('.q-image [role=status]')?.textContent || '',
      thumb: !!document.querySelector('.q-image-thumb'),
      cleared: document.querySelector('.q-card input[type=file]')?.value === '',
    }));
    ok('an image that cannot fit is refused rather than mangled', !refusal.thumb, refusal);
    ok('and the refusal says what to do about it', /crop|recort|zuschneiden/i.test(refusal.note), refusal.note);
    ok('the field is cleared so the same file can be tried again', refusal.cleared, refusal);
    await solo.close();
    rmSync(impossible, { force: true });
  }

  await shot.evaluate(() => {
    const alt = document.querySelector('.q-image input[type=text]');
    alt.value = 'Two scatter plots'; alt.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.actions-end .btn-brand').click();
  });
  await shot.waitForSelector('.join-code', { timeout: 15000 });
  const picCode = await shot.evaluate(() => document.querySelector('.join-code').textContent.trim());
  const picKey = await shot.evaluate(() => JSON.parse(localStorage.getItem('pollen.rooms') || '[]').find((r) => r.code === document.querySelector('.join-code').textContent.trim())?.key || '');
  // The controls appear when the presenter socket opens, not when the page
  // renders. Clicking without waiting worked on a warm run and threw on a cold
  // one, which is the definition of a flaky check rather than a passing one.
  await shot.waitForSelector('.controls .btn-brand', { timeout: 15000 });
  await shot.evaluate(() => document.querySelector('.controls .btn-brand').click());
  await shot.waitForSelector('.stage-image', { timeout: 10000 });
  // The element existing is not the picture arriving. Waiting only for the
  // selector measured an <img> that had not decoded yet, which reported a
  // width of zero, and the "at most 1280 across" check below passed on that
  // zero: a green line proving nothing.
  await shot.waitForFunction(
    () => { const i = document.querySelector('.stage-image'); return i && i.complete && i.naturalWidth > 0; },
    { timeout: 15000 },
  );

  const onStage = await shot.evaluate(() => {
    const img = document.querySelector('.stage-image');
    return { src: img.getAttribute('src'), alt: img.getAttribute('alt'), width: img.naturalWidth, complete: img.complete };
  });
  ok('the projected screen shows the picture', onStage.complete && onStage.width > 0, onStage);
  ok('and fetches it rather than carrying it in the socket',
    onStage.src.startsWith('/api/rooms/') && onStage.src.includes('/image?idx='), onStage.src);
  ok('the description reaches the projected screen', onStage.alt === 'Two scatter plots', onStage.alt);
  ok('the picture is at most 1280 across, as the cap says',
    onStage.width > 0 && onStage.width <= 1280, onStage.width);

  // The phone gets it inline, which is the half that costs no request.
  const phoneContext = await browser.createBrowserContext();
  const phone = await phoneContext.newPage();
  await phone.setViewport({ width: 390, height: 780 });
  const phoneRequests = [];
  phone.on('request', (r) => phoneRequests.push(r.url()));
  await phone.goto(`${BASE}/${picCode}`, { waitUntil: 'domcontentloaded' });
  await phone.waitForSelector('.q-image-shown', { timeout: 10000 });
  await phone.waitForFunction(
    () => { const i = document.querySelector('.q-image-shown'); return i && i.complete && i.naturalWidth > 0; },
    { timeout: 15000 },
  );
  const onPhone = await phone.evaluate(() => {
    const img = document.querySelector('.q-image-shown');
    return { src: img.getAttribute('src').slice(0, 24), alt: img.getAttribute('alt'), width: img.naturalWidth };
  });
  ok('a phone shows the picture too', onPhone.width > 0, onPhone);
  ok('a phone gets it inline, at no request of its own',
    onPhone.src.startsWith('data:image/') && !phoneRequests.some((u) => u.includes('/image?idx=')),
    { src: onPhone.src, fetched: phoneRequests.filter((u) => u.includes('/image')) });
  ok('the description reaches the phone', onPhone.alt === 'Two scatter plots', onPhone.alt);
  ok('the picture page raised no errors', shotErrors.length === 0, shotErrors);

  await phoneContext.close();
  rmSync(picture, { force: true });
  await fetch(`${BASE}/api/rooms/${picCode}/admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pollen-key': picKey },
    body: JSON.stringify({ action: 'close' }),
  });
}

await browser.close();
await fetch(`${BASE}/api/rooms/${room.code}/admin`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-pollen-key': room.key },
  body: JSON.stringify({ action: 'close' }),
});

// Checks are printed as they happen, so a run that hangs still shows how far it
// reached. Only the tally is printed here.
const failed = out.filter((line) => line.startsWith('FAIL'));
console.log(`\n${out.length - failed.length} passed, ${failed.length} failed`);
console.log(errors.length === 0 ? 'no page errors' : 'PAGE ERRORS:\n' + [...new Set(errors)].join('\n'));
process.exit(out.some((l) => l.startsWith('FAIL')) || errors.length ? 1 : 0);
