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
const BASE = process.env.POLLEN_BASE || 'http://127.0.0.1:8788';
const out = [];
const ok = (label, cond, detail) => (console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ' :: ' + JSON.stringify(detail)}`), out.push(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ' :: ' + JSON.stringify(detail)}`));

const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
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
ok('a set can be saved to the device', built.saved === 1, built);

await page.evaluate(async () => {
  [...document.querySelectorAll('.actions-end .btn')].pop().click();
  await new Promise((r) => setTimeout(r, 1200));
});
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

// Nothing on either page ever reads as a stringified nothing. DOM append()
// turns a null child into the word "null", and it has reached a screen twice.
for (const [name, target] of [['the projector', page], ['the phone', phone]]) {
  const stray = await target.evaluate(() => {
    const text = document.body.innerText;
    return ['null', 'undefined', 'false', 'NaN', '[object Object]']
      .filter((word) => new RegExp('(^|\\s)' + word + '(\\s|$)').test(text));
  });
  ok(`no stringified nothing on ${name}`, stray.length === 0, stray);
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
    stored: JSON.parse(localStorage.getItem('pollen.rooms') || '[]').length,
  };
});
ok('a recovery link opens the room on a device that had nothing',
  recovered.code === room.code && recovered.controls > 0, recovered);
ok('the key is claimed and taken out of the address bar',
  recovered.hash === '' && recovered.stored === 1, recovered);

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
