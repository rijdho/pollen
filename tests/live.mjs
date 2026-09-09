// End-to-end check against a running Worker. Not part of `npm test`, because it
// needs a server: start `npm run dev` in another terminal, then `npm run live`.
//
// The unit tests cover the arithmetic and the folding. This covers the parts
// only the runtime can answer: that the Durable Object stores what it is told,
// that the key gate holds, that both kinds of socket carry what they should,
// and that closing a room really removes it.

const BASE = process.env.POLLEN_BASE || 'http://127.0.0.1:8788';

// Every run gets its own client address, from the documentation range. The
// creation throttle is real storage with a one-hour window, so a fixed address
// would make the second run of the day fail on the first room it asks for.
const hex = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
const RUN_ADDRESS = `2001:db8:${hex()}:${hex()}::1`;
const FLOOD_ADDRESS = `2001:db8:${hex()}:${hex()}::2`;
const OTHER_ADDRESS = `2001:db8:${hex()}:${hex()}::3`;

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  ok   ' + label);
  } else {
    failures.push(label + (detail ? ' :: ' + JSON.stringify(detail) : ''));
    console.log('  FAIL ' + label + (detail ? ' :: ' + JSON.stringify(detail) : ''));
  }
}

async function call(path, { method = 'GET', body, voter, key, address } = {}) {
  const headers = {};
  if (voter) headers['x-pollen-voter'] = voter;
  if (key) headers['x-pollen-key'] = key;
  // Cloudflare sets this at the edge; wrangler dev sets it to the loopback
  // address, which every run would then share. Sending it explicitly keeps the
  // throttle's storage separate per run.
  headers['cf-connecting-ip'] = address || RUN_ADDRESS;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

function socket(path) {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + path);
  const messages = [];
  const waiters = [];
  ws.addEventListener('message', (event) => {
    const parsed = JSON.parse(event.data);
    // Deliver to a waiter or queue it, never both: queueing a message that was
    // already handed over leaves a stale copy that the next read picks up, and
    // every later assertion is then one message behind.
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else messages.push(parsed);
  });
  return {
    ws,
    messages,
    next(timeout = 3000) {
      if (messages.length > 0) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no message within ' + timeout + 'ms')), timeout);
        waiters.push((msg) => { clearTimeout(timer); resolve(msg); });
      });
    },
    open() {
      return new Promise((resolve, reject) => {
        if (ws.readyState === WebSocket.OPEN) return resolve();
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('socket failed to open')), { once: true });
      });
    },
    close() { ws.close(); },
  };
}

/**
 * A voter token in the shape the browser actually sends. The Worker refuses
 * anything shorter than eight characters, so a test using "w1" as a token gets
 * a flat 400 and no broadcast, and the socket read that follows hangs. Learned
 * the hard way.
 */
const who = (name) => name.replace(/[^A-Za-z0-9_-]/g, '-').padEnd(12, '0');

const QUESTIONS = [
  { type: 'choice', prompt: 'Which one?', options: ['Alpha', 'Beta', 'Gamma'], multiple: false },
  { type: 'scale', prompt: 'How clear was that?', steps: 5, labels: { min: 'Not at all', max: 'Completely' } },
  { type: 'cloud', prompt: 'One word for it', entries: 2, moderation: true },
];

console.log('creating a room');
const made = await call('/api/rooms', { method: 'POST', body: { questions: QUESTIONS, locale: 'en' } });
check('a room is created', made.status === 200, made);
const { code, adminKey } = made.data;
check('the code is six characters from the safe alphabet', /^[23456789BCDFGHJKMNPQRSTVWXYZ]{6}$/.test(code), code);
check('an admin key comes back', typeof adminKey === 'string' && adminKey.length > 20);
check('the room expires on its own', made.data.expiresAt > Date.now(), made.data.expiresAt);

console.log('before the first question');
const idle = await call(`/api/rooms/${code}`, { voter: who('voter-one') });
check('the room starts before question one', idle.data.current === -1, idle.data.current);
check('a participant is told how many questions there are', idle.data.total === 3, idle.data);
check('a participant is never handed the admin key', !JSON.stringify(idle.data).includes(adminKey));

console.log('the key gate');
check('no key is refused', (await call(`/api/rooms/${code}/state`)).status === 403);
check('a wrong key is refused', (await call(`/api/rooms/${code}/state`, { key: 'not-the-key' })).status === 403);
check('a key of the right length is still refused',
  (await call(`/api/rooms/${code}/state`, { key: 'x'.repeat(adminKey.length) })).status === 403);
check('a code that does not exist is a 404', (await call('/api/rooms/BCDFGH')).status === 404);
check('a malformed code is a 400', (await call('/api/rooms/OOOOOO')).status === 400);

console.log('sockets');
const presenter = socket(`/api/rooms/${code}/live?k=${encodeURIComponent(adminKey)}`);
await presenter.open();
const first = await presenter.next();
check('the presenter socket opens with the current state', first.type === 'state', first);
const follower = socket(`/api/rooms/${code}/follow`);
await follower.open();
const followFirst = await follower.next();
check('a follower socket opens with the current question', followFirst.type === 'question', followFirst);
check('a follower is not sent results', followFirst.results === undefined && followFirst.state === undefined);

console.log('multiple choice');
await call(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'goto', payload: { idx: 0 } } });
const moved = await follower.next();
check('moving a question is pushed to every phone', moved.type === 'question' && moved.current === 0, moved);
await presenter.next();

const v1 = await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('voter-one'), body: { idx: 0, value: [0] } });
check('a vote is accepted', v1.status === 200, v1);
const pushed = await presenter.next();
check('the presenter sees the vote arrive', pushed.state.results.counts[0] === 1, pushed.state.results);
check('the follower is not woken by a vote', follower.messages.length === 0, follower.messages);

await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('voter-two'), body: { idx: 0, value: [1] } });
await presenter.next();
const changed = await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('voter-two'), body: { idx: 0, value: [2] } });
check('changing your mind replaces your vote', changed.status === 200);
const afterChange = (await presenter.next()).state;
check('a replaced vote is not counted twice',
  afterChange.results.counts.reduce((a, b) => a + b, 0) === 2, afterChange.results.counts);
check('two people are counted, not three', afterChange.voters === 2, afterChange.voters);
check('percentages of the two answers sum to 100',
  afterChange.results.percentages.reduce((a, b) => a + b, 0) === 100, afterChange.results.percentages);

check('a vote outside the option list is refused',
  (await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('voter-three'), body: { idx: 0, value: [99] } })).status === 400);
check('two answers to a single-choice question are refused',
  (await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('voter-three'), body: { idx: 0, value: [0, 1] } })).status === 400);
check('a vote on a question that is not showing is refused',
  (await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('voter-three'), body: { idx: 2, value: [0] } })).status === 409);
check('a vote with no voter token is refused',
  (await call(`/api/rooms/${code}/vote`, { method: 'POST', body: { idx: 0, value: [0] } })).status === 400);

await call(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'lock', payload: { locked: true } } });
await presenter.next(); await follower.next();
check('a locked question refuses votes',
  (await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('voter-four'), body: { idx: 0, value: [0] } })).status === 409);
await call(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'lock', payload: { locked: false } } });
await presenter.next(); await follower.next();

console.log('rating scale');
await call(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'goto', payload: { idx: 1 } } });
await presenter.next(); await follower.next();
for (const [voter, value] of [['a', 1], ['b', 2], ['c', 4], ['d', 5]]) {
  await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('scale-' + voter), body: { idx: 1, value } });
  await presenter.next();
}
const scale = (await call(`/api/rooms/${code}/state`, { key: adminKey })).data.results;
check('the histogram matches the votes', JSON.stringify(scale.histogram) === '[1,1,0,1,1]', scale.histogram);
check('the mean is exact', scale.mean === 3, scale.mean);
check('the median is a step someone could have chosen', scale.median === 2, scale.median);
check('a value off the scale is refused',
  (await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('scale-z'), body: { idx: 1, value: 9 } })).status === 400);

console.log('word cloud with moderation');
await call(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'goto', payload: { idx: 2 } } });
await presenter.next(); await follower.next();
await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('w1'), body: { idx: 2, value: 'Reuse' } });
const held = (await presenter.next()).state;
check('a word waits for approval', held.pending.length === 1 && held.results.items.length === 0, held.pending);
check('an unapproved word is not on the projector', held.results.items.length === 0);

const control = String.fromCodePoint(0x202e);
await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('w2'), body: { idx: 2, value: 'fa' + control + 'ir' } });
const cleaned = (await presenter.next()).state;
check('an override character is stripped before a moderator ever sees it',
  cleaned.pending.some((p) => p.text === 'fair'), cleaned.pending);

check('too many words is refused',
  (await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('w3'), body: { idx: 2, value: 'one two three four' } })).status === 400);
check('an empty entry is refused',
  (await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('w3'), body: { idx: 2, value: '   ' } })).status === 400);

await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('w1'), body: { idx: 2, value: 'reuse' } });
await presenter.next();
check('a third entry from the same person is refused after two',
  (await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('w1'), body: { idx: 2, value: 'again' } })).status === 409);

const pending = (await call(`/api/rooms/${code}/state`, { key: adminKey })).data.pending;
for (const item of pending.filter((p) => p.text.toLowerCase() === 'reuse')) {
  await call(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'moderate', payload: { voter: item.voter, seq: item.seq, approve: true } } });
  await presenter.next();
}
const approved = (await call(`/api/rooms/${code}/state`, { key: adminKey })).data;
check('approved words merge on their folded key',
  approved.results.items.length === 1 && approved.results.items[0].count === 2, approved.results.items);
check('approving does not wake every phone in the room', follower.messages.length === 0, follower.messages);

const hide = (await call(`/api/rooms/${code}/state`, { key: adminKey })).data.pending[0];
await call(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'moderate', payload: { voter: hide.voter, seq: hide.seq, approve: false } } });
await presenter.next();
const hidden = (await call(`/api/rooms/${code}/state`, { key: adminKey })).data;
check('a rejected word is on no screen at all',
  !JSON.stringify(hidden.results.items).includes('fair') && hidden.pending.length === 0, hidden);

console.log('abuse controls');
{
  const voter = who('flooder');
  await call(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'goto', payload: { idx: 1 } } });
  await presenter.next(); await follower.next();
  const statuses = [];
  for (let i = 0; i < 22; i += 1) {
    const res = await call(`/api/rooms/${code}/vote`, { method: 'POST', voter, body: { idx: 1, value: 3 } });
    statuses.push(res.status);
    if (res.status === 200) await presenter.next();
  }
  check('one device cannot hammer a question forever',
    statuses.includes(429), statuses.join(','));
  check('the limit bites at twenty per minute, not before',
    statuses.slice(0, 20).every((s) => s === 200), statuses.slice(0, 20).join(','));
}

{
  const address = FLOOD_ADDRESS;
  const statuses = [];
  for (let i = 0; i < 12; i += 1) {
    const res = await call('/api/rooms', {
      method: 'POST', address,
      body: { questions: [{ type: 'choice', prompt: 'Flood', options: ['a', 'b'] }] },
    });
    statuses.push(res.status);
  }
  check('one address cannot open rooms without end', statuses.includes(429), statuses.join(','));
  check('ten rooms an hour is the point it stops',
    statuses.slice(0, 10).every((s) => s === 200), statuses.slice(0, 10).join(','));
  check('a different address is unaffected',
    (await call('/api/rooms', { method: 'POST', address: OTHER_ADDRESS, body: { questions: [{ type: 'choice', prompt: 'Fine', options: ['a', 'b'] }] } })).status === 200);
}

{
  const empty = await call('/api/rooms', { method: 'POST', body: { questions: [] } });
  check('a room with no questions is refused', empty.status === 400, empty);
  // 422, not 409: a taken code is worth retrying and this never is. Sharing a
  // status made the router retry five times and answer 503.
  const junk = await call('/api/rooms', { method: 'POST', body: { questions: [{ type: 'nonsense', prompt: 'x' }] } });
  check('an unknown question type is refused, and not as a collision',
    junk.status === 422 && junk.data.error === 'unusable_questions', junk);
  const oneOption = await call('/api/rooms', { method: 'POST', body: { questions: [{ type: 'choice', prompt: 'x', options: ['only'] }] } });
  check('a choice with one option is refused', oneOption.status === 422, oneOption);
  const noPrompt = await call('/api/rooms', { method: 'POST', body: { questions: [{ type: 'choice', prompt: '   ', options: ['a', 'b'] }] } });
  check('a question with no text is refused', noPrompt.status === 422, noPrompt);
  const mixed = await call('/api/rooms', { method: 'POST', body: { questions: [{ type: 'nonsense', prompt: 'x' }, { type: 'choice', prompt: 'Real', options: ['a', 'b'] }] } });
  check('one usable question among the rubbish still opens a room', mixed.status === 200, mixed);
}

console.log('export and close');
const exported = (await call(`/api/rooms/${code}/export`, { key: adminKey })).data;
check('the export carries every question', exported.questions.length === 3, exported.questions?.length);
check('the export carries the results', exported.questions[1].results.mean === 3, exported.questions[1].results);
check('the export carries no admin key', !JSON.stringify(exported).includes(adminKey));

await call(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'close' } });
const after = await call(`/api/rooms/${code}`, { voter: who('voter-one') });
check('a closed room is gone', after.status === 404, after);
check('its results are gone with it', (await call(`/api/rooms/${code}/export`, { key: adminKey })).status === 404);

presenter.close();
follower.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log('  ' + failure);
process.exit(failures.length === 0 ? 0 : 1);
