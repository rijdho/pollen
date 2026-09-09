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
  { type: 'cloud', prompt: 'One word for open science', entries: 1, moderation: true },
];
const CHOICES = [[0], [0], [0], [0], [1], [1], [1], [2], [2], [2], [2], [2]]; // 4 / 3 / 5
const WORDS = ['Reuse', 'reuse', 'REUSE', 'Transparency', 'transparency', 'Access',
  'access', 'Access', 'Rigour', 'Funding', 'Trust', 'Slower'];

const voter = (n) => 'shot' + String(n).padStart(8, '0');

async function api(path, { method = 'GET', body, key, who } = {}) {
  const headers = { 'cf-connecting-ip': '2001:db8:5ec7:5ec7::1' };
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

await api(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'goto', payload: { idx: 0 } } });
for (const [i, pick] of CHOICES.entries()) {
  await api(`/api/rooms/${code}/vote`, { method: 'POST', who: voter(i), body: { idx: 0, value: pick } });
}
await presenter.goto(`${BASE}/p/${code}`, { waitUntil: 'networkidle0' });
await shot(presenter, 'presenter-choice', { width: 1280, height: 760 });

const phone = await browser.newPage();
await phone.goto(`${BASE}/${code}`, { waitUntil: 'networkidle0' });
await shot(phone, 'participant', { width: 420, height: 720 });

await api(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'goto', payload: { idx: 1 } } });
for (const [i, word] of WORDS.entries()) {
  await api(`/api/rooms/${code}/vote`, { method: 'POST', who: voter(100 + i), body: { idx: 1, value: word } });
}
// Approve everything except the last two, so the queue is visibly doing its job.
const state = await api(`/api/rooms/${code}/state`, { key: adminKey });
for (const item of state.pending.slice(0, -2)) {
  await api(`/api/rooms/${code}/admin`, {
    method: 'POST', key: adminKey,
    body: { action: 'moderate', payload: { voter: item.voter, seq: item.seq, approve: true } },
  });
}
await shot(presenter, 'presenter-cloud', { width: 1280, height: 900 });

await api(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'close' } });
await browser.close();
console.log('room closed and deleted');
