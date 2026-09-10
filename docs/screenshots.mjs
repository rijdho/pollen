// Regenerates the README screenshots in this folder by driving the real
// application, so they cannot quietly go stale. Puppeteer is a tooling-only
// dependency: the app ships with none and this file is never deployed.
//
//   npm run dev                                    # in another terminal
//   npm i puppeteer --no-save                      # or set CHROME_PATH
//   node docs/screenshots.mjs
//
// The votes below are fixed on purpose. They are the numbers in the README's
// alt text, and a random seed would make the two drift apart.

import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const BASE = process.env.POLLEN_BASE || 'http://127.0.0.1:8788';
const OUT = 'docs';
mkdirSync(OUT, { recursive: true });

const QUESTIONS = [
  { type: 'choice', prompt: 'Which of these worries you most?', options: ['Cost', 'Time', 'Nobody reads it'] },
  { type: 'scale', prompt: 'How clear was that session?', steps: 5, labels: { min: 'Not at all', max: 'Completely' } },
  { type: 'cloud', prompt: 'One word for open science', entries: 1 },
  { type: 'qa', prompt: 'What should we cover next?', moderation: true },
];
const CHOICES = [[0], [0], [0], [0], [1], [1], [1], [2], [2], [2], [2], [2]]; // 4 / 3 / 5
const RATINGS = [3, 4, 4, 4, 5, 5, 3, 4, 2, 5, 4, 4]; // mean 3.9, median 4
const WORDS = [
  'Access', 'access', 'Access', 'Access', 'ACCESS',
  'Reuse', 'reuse', 'Reuse', 'Reuse',
  'Transparency', 'transparency', 'Transparency',
  'Rigour', 'Rigour', 'Funding', 'Funding', 'Trust',
  'Slower', 'Credit', 'Messy', 'Provenance', 'Licences', 'Care', 'Metadata',
];
const ASKED = [
  'How do you fund the repository after the grant ends?',
  'Does this work for a department with no metadata staff?',
  'What happens to the data if the platform shuts down?',
  'Can we reuse your rubric for our own audit?',
];
const BACKING = [3, 1, 2, 0]; // supports per question, in the order above

const voter = (n) => 'shot' + String(n).padStart(8, '0');

async function api(path, { method = 'GET', body, key, who } = {}) {
  // Only against a local dev server. Cloudflare's edge refuses a request that
  // carries its own cf-connecting-ip header outright, with a 403, which is also
  // why the creation throttle cannot be dodged by spoofing an address.
  const headers = BASE.includes('127.0.0.1') || BASE.includes('localhost')
    ? { 'cf-connecting-ip': '2001:db8:5ec7:5ec7::1' }
    : {};
  if (body) headers['content-type'] = 'application/json';
  if (key) headers['x-pollen-key'] = key;
  if (who) headers['x-pollen-voter'] = who;
  const res = await fetch(BASE + path, { method, headers, body: body && JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
  return res.json();
}

const { code, adminKey } = await api('/api/rooms', { method: 'POST', body: { questions: QUESTIONS, locale: 'en' } });
console.log('room', code);

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: process.env.CHROME_PATH || undefined,
});

async function shot(page, name, size) {
  await page.setViewport({ ...size, deviceScaleFactor: 2 });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('wrote', `${OUT}/${name}.png`);
}

// The presenter's key lives in localStorage, so it has to be put there before
// the page routes, exactly as opening the room would have done.
const presenter = await browser.newPage();
await presenter.goto(BASE + '/', { waitUntil: 'networkidle0' });
await presenter.evaluate((c, k) => {
  localStorage.setItem('pollen.rooms', JSON.stringify([{ code: c, adminKey: k, expiresAt: Date.now() + 3600e3 }]));
}, code, adminKey);

// The editor, before any room exists: the type of every question is a control,
// and the arrows that reorder them are disabled at the ends.
const editor = await browser.newPage();
await editor.goto(BASE + '/', { waitUntil: 'networkidle0' });
await editor.click('.card-lead .btn-brand');
await editor.waitForSelector('.q-card', { timeout: 8000 });
await editor.evaluate(async () => {
  const type = (n, v) => { n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); };
  type(document.querySelector('.q-card input[type=text]'), 'Which of these worries you most?');
  const opts = document.querySelectorAll('.q-card .opt-row input[type=text]');
  type(opts[0], 'Cost'); type(opts[1], 'Time');
  [...document.querySelectorAll('.add-row .btn')][1].click();
  await new Promise((r) => setTimeout(r, 150));
  type(document.querySelectorAll('.q-card')[1].querySelector('input[type=text]'), 'How clear was that session?');
  window.scrollTo(0, 0);
});
await shot(editor, 'editor', { width: 1000, height: 760 });
await editor.close();

await api(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'goto', payload: { idx: 0 } } });
for (const [i, pick] of CHOICES.entries()) {
  await api(`/api/rooms/${code}/vote`, { method: 'POST', who: voter(i), body: { idx: 0, value: pick } });
}
await presenter.goto(`${BASE}/p/${code}`, { waitUntil: 'networkidle0' });
await shot(presenter, 'presenter-choice', { width: 1280, height: 760 });

await api(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'goto', payload: { idx: 1 } } });
for (const [i, value] of RATINGS.entries()) {
  await api(`/api/rooms/${code}/vote`, { method: 'POST', who: voter(50 + i), body: { idx: 1, value } });
}
await shot(presenter, 'presenter-scale', { width: 1280, height: 800 });
await api(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'goto', payload: { idx: 0 } } });

const phone = await browser.newPage();
await phone.goto(`${BASE}/${code}`, { waitUntil: 'networkidle0' });
await shot(phone, 'participant', { width: 420, height: 720 });

await api(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'goto', payload: { idx: 2 } } });
for (const [i, word] of WORDS.entries()) {
  await api(`/api/rooms/${code}/vote`, { method: 'POST', who: voter(100 + i), body: { idx: 2, value: word } });
}
// No approval queue on a cloud: entries go straight to the screen.
await shot(presenter, 'presenter-cloud', { width: 1280, height: 1120 });

// Audience questions, moderated and supported, on the projected screen.
await api(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'goto', payload: { idx: 3 } } });
for (const [i, text] of ASKED.entries()) {
  await api(`/api/rooms/${code}/vote`, { method: 'POST', who: voter(200 + i), body: { idx: 3, value: text } });
}
const waiting = await api(`/api/rooms/${code}/state`, { key: adminKey });
for (const item of waiting.pending) {
  await api(`/api/rooms/${code}/admin`, {
    method: 'POST', key: adminKey,
    body: { action: 'moderate', payload: { voter: item.voter, seq: item.seq, approve: true } },
  });
}
const listed = await api(`/api/rooms/${code}/qa?idx=3`);
for (const [i, item] of listed.items.entries()) {
  const wanted = BACKING[ASKED.indexOf(item.text)] ?? 0;
  for (let n = 0; n < wanted; n += 1) {
    await api(`/api/rooms/${code}/upvote`, { method: 'POST', who: voter(300 + i * 10 + n), body: { idx: 3, id: item.id } });
  }
}
await shot(presenter, 'presenter-qa', { width: 1280, height: 820 });

await api(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'close' } });
await browser.close();
console.log('room closed and deleted');
