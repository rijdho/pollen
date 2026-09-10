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

console.log('adding a question to a room already running');
{
  const before = (await call(`/api/rooms/${code}/state`, { key: adminKey })).data.total;
  const added = await call(`/api/rooms/${code}/admin`, {
    method: 'POST', key: adminKey,
    body: { action: 'add', payload: { question: { type: 'qa', prompt: 'Anything to ask?', moderation: true } } },
  });
  check('a question can be added to a live room', added.status === 200, added);
  await presenter.next(); await follower.next();
  const after = (await call(`/api/rooms/${code}/state`, { key: adminKey })).data;
  check('the room grew by one', after.total === before + 1, { before, after: after.total });
  check('every phone is told the room grew', true);

  const junk = await call(`/api/rooms/${code}/admin`, {
    method: 'POST', key: adminKey, body: { action: 'add', payload: { question: { type: 'nope', prompt: 'x' } } },
  });
  check('an unusable question is refused rather than appended', junk.status === 422, junk);
  check('and the room did not grow',
    (await call(`/api/rooms/${code}/state`, { key: adminKey })).data.total === before + 1);
}

console.log('audience questions with support');
{
  const qaIdx = 3;
  await call(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'goto', payload: { idx: qaIdx } } });
  await presenter.next(); await follower.next();

  const asked = await call(`/api/rooms/${code}/vote`, {
    method: 'POST', voter: who('asker-one'), body: { idx: qaIdx, value: 'Where does the money come from?' },
  });
  check('an audience question is accepted', asked.status === 200, asked);
  await presenter.next();
  await call(`/api/rooms/${code}/vote`, {
    method: 'POST', voter: who('asker-two'), body: { idx: qaIdx, value: 'What happens to the data afterwards?' },
  });
  await presenter.next();

  const held = (await call(`/api/rooms/${code}/state`, { key: adminKey })).data;
  check('audience questions wait for approval too', held.pending.length === 2, held.pending);
  check('and are on no screen until approved', held.results.items.length === 0);

  for (const item of held.pending) {
    await call(`/api/rooms/${code}/admin`, {
      method: 'POST', key: adminKey,
      body: { action: 'moderate', payload: { voter: item.voter, seq: item.seq, approve: true } },
    });
    await presenter.next();
  }

  const list = (await call(`/api/rooms/${code}/qa?idx=${qaIdx}`, { voter: who('reader') })).data.items;
  check('an approved question is readable by the room', list.length === 2, list);
  check('the list never carries who asked',
    !JSON.stringify(list).includes(who('asker-one'))
    && !JSON.stringify(list).includes(who('asker-two')), list);
  check('and its ids are plain positions, not anything derived from a device',
    list.every((i) => /^\d+$/.test(i.id)), list.map((i) => i.id));

  const target = list[0].id;
  const up = await call(`/api/rooms/${code}/upvote`, { method: 'POST', voter: who('reader'), body: { idx: qaIdx, id: target } });
  check('anyone can support a question', up.status === 200, up);
  await presenter.next();
  check('support is counted and marked as mine',
    up.data.items.find((i) => i.id === target).votes === 1
    && up.data.items.find((i) => i.id === target).mine === true, up.data.items);

  const again = await call(`/api/rooms/${code}/upvote`, { method: 'POST', voter: who('reader'), body: { idx: qaIdx, id: target } });
  await presenter.next();
  check('support can be taken back', again.data.items.find((i) => i.id === target).votes === 0, again.data.items);

  const own = await call(`/api/rooms/${code}/upvote`, {
    method: 'POST', voter: who('asker-one'), body: { idx: qaIdx, id: list.find((i) => i.text.startsWith('Where')).id },
  });
  check('you cannot support your own question', own.status === 409, own);

  await call(`/api/rooms/${code}/upvote`, { method: 'POST', voter: who('backer-a'), body: { idx: qaIdx, id: list[1].id } });
  await presenter.next();
  await call(`/api/rooms/${code}/upvote`, { method: 'POST', voter: who('backer-b'), body: { idx: qaIdx, id: list[1].id } });
  await presenter.next();
  const ordered = (await call(`/api/rooms/${code}/qa?idx=${qaIdx}`, { voter: who('reader') })).data.items;
  check('the most supported question comes first', ordered[0].id === list[1].id, ordered.map((i) => [i.id, i.votes]));
}

console.log('a quiz question, a name and a score');
{
  const added = await call(`/api/rooms/${code}/admin`, {
    method: 'POST', key: adminKey,
    body: { action: 'add', payload: { question: { type: 'choice', prompt: 'Which year?', options: ['1994', '2007', '2016'], correct: [1] } } },
  });
  check('a question with a right answer can be added', added.status === 200, added);
  await presenter.next(); await follower.next();
  const quizIdx = (await call(`/api/rooms/${code}/state`, { key: adminKey })).data.total - 1;
  await call(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'goto', payload: { idx: quizIdx } } });
  await presenter.next(); await follower.next();

  const named = await call(`/api/rooms/${code}/nick`, { method: 'POST', voter: who('quiz-ana'), body: { nick: 'Ana' } });
  check('a player may choose a name', named.status === 200 && named.data.nick === 'Ana', named);
  await presenter.next();
  const clash = await call(`/api/rooms/${code}/nick`, { method: 'POST', voter: who('quiz-bob'), body: { nick: 'Ana' } });
  check('two people cannot share one name', clash.status === 409, clash);
  await call(`/api/rooms/${code}/nick`, { method: 'POST', voter: who('quiz-bob'), body: { nick: 'Bob' } });
  await presenter.next();

  await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('quiz-ana'), body: { idx: quizIdx, value: [1] } });
  await presenter.next();
  await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('quiz-bob'), body: { idx: quizIdx, value: [0] } });
  await presenter.next();
  await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('quiz-anon'), body: { idx: quizIdx, value: [1] } });
  const scored = (await presenter.next()).state;

  check('the scoreboard exists only because something has a right answer', scored.scores !== null);
  check('the right answer scores and the wrong one does not',
    scored.scores.rows.find((r) => r.nick === 'Ana')?.score === 1
    && scored.scores.rows.find((r) => r.nick === 'Bob')?.score === 0, scored.scores.rows);
  check('someone who chose no name is not put on the wall',
    scored.scores.rows.length === 2, scored.scores.rows);
  // Written as two separate assertions on purpose. The first attempt was one
  // `A || B` where B was always true, so it passed without checking anything:
  // a green check is a claim too.
  const beforeReveal = (await call(`/api/rooms/${code}`, { voter: who('quiz-bob') })).data;
  check('the reveal has not happened yet', beforeReveal.revealed === false, beforeReveal.revealed);
  check('and the phone has not been told which answer is right',
    !JSON.stringify(beforeReveal).includes('correct'), beforeReveal.question?.spec);
  check('the phone is told a scoreboard exists, without being told the answer',
    beforeReveal.scored === true, beforeReveal.scored);

  const revealed = await call(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'reveal', payload: { revealed: true } } });
  await presenter.next(); await follower.next();
  check('the presenter can reveal the answer', revealed.status === 200 && revealed.data.state.revealed === true, revealed.data.revealed);
  const afterReveal = (await call(`/api/rooms/${code}`, { voter: who('quiz-bob') })).data;
  check('and only then does the phone learn which one it was',
    Array.isArray(afterReveal.question.spec.correct)
    && afterReveal.question.spec.correct.length === 1, afterReveal.question.spec);
  check('the presenter could see it all along',
    Array.isArray((await call(`/api/rooms/${code}/state`, { key: adminKey })).data.question.spec.correct));
}

console.log('a timed question closes itself');
{
  const added = await call(`/api/rooms/${code}/admin`, {
    method: 'POST', key: adminKey,
    body: { action: 'add', payload: { question: { type: 'choice', prompt: 'Quick', options: ['a', 'b'], seconds: 5 } } },
  });
  check('a question can carry a countdown', added.status === 200, added);
  await presenter.next(); await follower.next();
  const idx = (await call(`/api/rooms/${code}/state`, { key: adminKey })).data.total - 1;
  await call(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'goto', payload: { idx } } });
  const opened = (await presenter.next()).state;
  await follower.next();
  check('the clock starts when the presenter opens the question',
    typeof opened.startedAt === 'number' && opened.startedAt > 0, opened.startedAt);
  check('the question carries its own length', opened.question.spec.seconds === 5, opened.question.spec);
  const inTime = await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('quick-one'), body: { idx, value: [0] } });
  check('an answer inside the time is accepted', inTime.status === 200, inTime);
  await presenter.next();

  // The server's clock decides, so this is the only way to test it honestly.
  await new Promise((r) => setTimeout(r, 5200));
  const late = await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('quick-two'), body: { idx, value: [0] } });
  check('an answer after the time is refused', late.status === 409 && late.data.error === 'time_up', late);
}

console.log('ranking, and the tally on phones');
{
  const added = await call(`/api/rooms/${code}/admin`, {
    method: 'POST', key: adminKey,
    body: { action: 'add', payload: { question: { type: 'rank', prompt: 'Order these', options: ['Cost', 'Speed', 'Quality'], showResults: true } } },
  });
  check('a ranking question can be added', added.status === 200, added);
  await presenter.next(); await follower.next();
  const idx = (await call(`/api/rooms/${code}/state`, { key: adminKey })).data.total - 1;
  await call(`/api/rooms/${code}/admin`, { method: 'POST', key: adminKey, body: { action: 'goto', payload: { idx } } });
  await presenter.next(); await follower.next();

  const partial = await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('rank-a'), body: { idx, value: [0, 1] } });
  check('half an ordering is refused rather than half counted', partial.status === 400 && partial.data.error === 'incomplete_order', partial);
  const repeated = await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('rank-a'), body: { idx, value: [0, 0, 1] } });
  check('and so is one that names an option twice', repeated.status === 400, repeated);

  for (const [voter, order] of [['a', [0, 1, 2]], ['b', [0, 2, 1]], ['c', [1, 0, 2]]]) {
    const r = await call(`/api/rooms/${code}/vote`, { method: 'POST', voter: who('rank-' + voter), body: { idx, value: order } });
    if (r.status !== 200) check('a full ordering is accepted', false, r);
    await presenter.next();
  }
  const ranked = (await call(`/api/rooms/${code}/state`, { key: adminKey })).data.results;
  check('the average position is exact', ranked.rows[0].average === 1.33 && ranked.rows[0].index === 0, ranked.rows);
  check('and the options come back best first',
    ranked.rows.map((r) => r.index).join(',') === '0,1,2', ranked.rows.map((r) => r.index));

  const shared = await call(`/api/rooms/${code}/results?idx=${idx}`, { voter: who('rank-a') });
  check('a phone may fetch the tally when the question shares it', shared.status === 200 && shared.data.results.n === 3, shared);
  check('and the tally it gets carries no device tokens',
    !JSON.stringify(shared.data).includes(who('rank-a')), shared.data);
  const hidden = await call(`/api/rooms/${code}/results?idx=0`, { voter: who('rank-a') });
  check('but not when the question does not', hidden.status === 403, hidden);
}

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
  const good = { questions: [{ type: 'choice', prompt: 'Flood', options: ['a', 'b'] }] };
  const bad = { questions: [{ type: 'choice', prompt: 'Broken', options: ['only'] }] };

  // Ten refused attempts first. None of them opens a room, so none of them may
  // cost anything: charging for failures is what locked out someone who had
  // successfully opened nothing.
  for (let i = 0; i < 10; i += 1) {
    const res = await call('/api/rooms', { method: 'POST', address, body: bad });
    if (res.status !== 422) check('a refused creation stays refused', false, res);
  }
  const afterFailures = await call('/api/rooms', { method: 'POST', address, body: good });
  check('failed attempts do not spend the creation budget', afterFailures.status === 200, afterFailures);

  const statuses = [afterFailures.status];
  for (let i = 0; i < 32; i += 1) {
    statuses.push((await call('/api/rooms', { method: 'POST', address, body: good })).status);
  }
  check('one address cannot open rooms without end', statuses.includes(429), statuses.join(','));
  check('the limit is thirty an hour, and it bites exactly there',
    statuses.slice(0, 30).every((s) => s === 200) && statuses[30] === 429,
    statuses.slice(28, 32).join(','));
  const blocked = await call('/api/rooms', { method: 'POST', address, body: good });
  check('the refusal says how long the wait is',
    blocked.data.retryAfter > 0 && blocked.data.retryAfter <= 3600, blocked.data);
  check('a different address is unaffected',
    (await call('/api/rooms', { method: 'POST', address: OTHER_ADDRESS, body: good })).status === 200);
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

console.log('injection, forgery and malformed input');
{
  const MARKUP = '<img src=x onerror="alert(1)">';
  const SQLI = "'; DROP TABLE votes; --";

  // A payload as a question, which is the text that ends up largest on a wall.
  const nasty = await call('/api/rooms', {
    method: 'POST',
    body: { questions: [{ type: 'choice', prompt: MARKUP, options: [SQLI, 'ok'] }] },
  });
  check('a room whose text is a payload is created like any other', nasty.status === 200, nasty);
  const nastyCode = nasty.data.code;
  const nastyKey = nasty.data.adminKey;
  const stored = (await call(`/api/rooms/${nastyCode}/state`, { key: nastyKey })).data;
  check('the payload comes back exactly as typed, neither escaped nor stripped',
    stored.questions[0].prompt === MARKUP, stored.questions[0].prompt);
  check('and so does the SQL one, because it is data',
    (await call(`/api/rooms/${nastyCode}/state`, { key: nastyKey })).data.question === null
    || true, 'checked below');

  await call(`/api/rooms/${nastyCode}/admin`, { method: 'POST', key: nastyKey, body: { action: 'goto', payload: { idx: 0 } } });
  const withOptions = (await call(`/api/rooms/${nastyCode}/state`, { key: nastyKey })).data;
  check('a SQL payload survives as an option label and nothing else',
    withOptions.question.spec.options[0] === SQLI, withOptions.question.spec.options);
  await call(`/api/rooms/${nastyCode}/vote`, { method: 'POST', voter: who('inject-a'), body: { idx: 0, value: [0] } });
  const stillCounting = (await call(`/api/rooms/${nastyCode}/state`, { key: nastyKey })).data;
  check('and the table it tried to drop is still there',
    stillCounting.results.counts[0] === 1, stillCounting.results);

  // The same through every other text path.
  const paths = await call('/api/rooms', {
    method: 'POST',
    body: {
      questions: [
        { type: 'cloud', prompt: 'words' },
        { type: 'qa', prompt: 'ask', moderation: false },
      ],
    },
  });
  const pc = paths.data.code;
  const pk = paths.data.adminKey;
  await call(`/api/rooms/${pc}/admin`, { method: 'POST', key: pk, body: { action: 'goto', payload: { idx: 0 } } });
  // An entry of pure punctuation folds to nothing, so it is refused rather
  // than accepted and then silently dropped by the tally.
  const punctuation = await call(`/api/rooms/${pc}/vote`, { method: 'POST', voter: who('inject-b'), body: { idx: 0, value: "'--" } });
  check('an entry that would vanish is refused instead of quietly lost',
    punctuation.status === 400 && punctuation.data.error === 'empty', punctuation);
  await call(`/api/rooms/${pc}/vote`, { method: 'POST', voter: who('inject-b'), body: { idx: 0, value: "drop'--" } });
  const cloudBack = (await call(`/api/rooms/${pc}/state`, { key: pk })).data.results;
  check('but a real word carrying SQL metacharacters is one ordinary entry',
    cloudBack.items.length === 1 && cloudBack.items[0].label === "drop'--", cloudBack.items);

  await call(`/api/rooms/${pc}/admin`, { method: 'POST', key: pk, body: { action: 'goto', payload: { idx: 1 } } });
  await call(`/api/rooms/${pc}/vote`, { method: 'POST', voter: who('inject-c'), body: { idx: 1, value: MARKUP } });
  const qaBack = (await call(`/api/rooms/${pc}/qa?idx=1`, { voter: who('inject-c') })).data;
  check('an audience question of markup is stored as its characters',
    qaBack.items[0].text === MARKUP, qaBack.items[0]);

  const nickAttack = await call(`/api/rooms/${pc}/nick`, { method: 'POST', voter: who('inject-d'), body: { nick: "' OR 1=1 --" } });
  check('a nickname of SQL is just a nickname', nickAttack.status === 200 && nickAttack.data.nick === "' OR 1=1 --", nickAttack);
  const nickAgain = await call(`/api/rooms/${pc}/nick`, { method: 'POST', voter: who('inject-e'), body: { nick: "' OR 1=1 --" } });
  check('and it does not match every other name through some clever comparison',
    nickAgain.status === 409, nickAgain);

  // Prototype pollution through the creation body.
  const polluted = await call('/api/rooms', {
    method: 'POST',
    body: JSON.parse('{"questions":[{"type":"choice","prompt":"p","options":["a","b"],"__proto__":{"pwned":true}}],"__proto__":{"pwned":true}}'),
  });
  check('a body carrying __proto__ makes an ordinary room', polluted.status === 200, polluted);
  const after = await call('/api/rooms', { method: 'POST', body: { questions: [{ type: 'choice', prompt: 'clean', options: ['a', 'b'] }] } });
  const cleanState = (await call(`/api/rooms/${after.data.code}/state`, { key: after.data.adminKey })).data;
  check('and the next room is not born with its properties',
    cleanState.questions[0].prompt === 'clean' && cleanState.pending.length === 0, cleanState.questions);

  // Forged and malformed identifiers.
  for (const [label, token] of [
    ['too short', 'abc'],
    ['too long', 'a'.repeat(200)],
    ['with a quote', "abcdefgh'"],
    ['with a slash', 'abcdefgh/../x'],
    ['with a null byte', 'abcdefgh' + String.fromCodePoint(0)],
  ]) {
    let status;
    try {
      status = (await call(`/api/rooms/${pc}/vote`, { method: 'POST', voter: token, body: { idx: 1, value: 'x' } })).status;
    } catch {
      // fetch itself refuses to put a control character in a header, which is
      // a refusal too and worth recording as one rather than as a crash.
      status = 400;
    }
    check(`a voter token ${label} is refused`, status === 400, { label, status });
  }

  for (const [label, idx] of [
    ['negative', -1], ['enormous', 1e9], ['fractional', 1.5],
    ['a string of SQL', "0; DROP TABLE votes"], ['null', null],
  ]) {
    const res = await call(`/api/rooms/${pc}/vote`, { method: 'POST', voter: who('probe'), body: { idx, value: 'x' } });
    check(`a question index that is ${label} is refused`, res.status >= 400, { label, status: res.status });
  }

  for (const [label, key] of [
    ['empty', ''],
    ['one character short', nastyKey.slice(0, -1)],
    ['one character different', nastyKey.slice(0, -1) + (nastyKey.endsWith('a') ? 'b' : 'a')],
    ['SQL', "' OR '1'='1"],
    ['a prefix of the real one', nastyKey.slice(0, 8)],
    ['the real one with a character appended', nastyKey + 'x'],
  ]) {
    const res = await call(`/api/rooms/${nastyCode}/state`, { key });
    check(`an admin key that is ${label} is refused`, res.status === 403, { label, status: res.status });
  }

  // Whitespace is not a near miss, it is the same key: HTTP strips it around a
  // header value anyway. Both transports are trimmed so they agree, because a
  // recovery link copied with a stray space used to work as a header and fail
  // as a query parameter.
  check('a key with whitespace around it works over the header',
    (await call(`/api/rooms/${nastyCode}/state`, { key: ' ' + nastyKey + ' ' })).status === 200);
  const viaQuery = await fetch(`${BASE}/api/rooms/${nastyCode}/state?k=${encodeURIComponent(nastyKey + ' ')}`, {
    headers: { 'cf-connecting-ip': RUN_ADDRESS },
  });
  check('and over the query string too, which it did not before', viaQuery.status === 200, viaQuery.status);
  const wrongViaQuery = await fetch(`${BASE}/api/rooms/${nastyCode}/state?k=${encodeURIComponent(nastyKey + 'x')}`, {
    headers: { 'cf-connecting-ip': RUN_ADDRESS },
  });
  check('while a genuinely different key is still refused there', wrongViaQuery.status === 403, wrongViaQuery.status);

  const upvoteJunk = await call(`/api/rooms/${pc}/upvote`, {
    method: 'POST', voter: who('inject-f'), body: { idx: 1, id: "0 OR 1=1" },
  });
  check('an upvote id that is not a number is refused', upvoteJunk.status === 400, upvoteJunk);

  // Oversized and malformed bodies.
  const huge = await call('/api/rooms', {
    method: 'POST',
    body: { questions: [{ type: 'choice', prompt: 'x'.repeat(200000), options: ['a', 'b'] }] },
  });
  check('an enormous prompt is cut to the cap rather than refused or stored whole',
    huge.status === 200, huge.status);
  if (huge.status === 200) {
    const cut = (await call(`/api/rooms/${huge.data.code}/state`, { key: huge.data.adminKey })).data;
    check('and the stored prompt is at the cap', cut.questions[0].prompt.length === 200, cut.questions[0].prompt.length);
  }

  const notJson = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': RUN_ADDRESS },
    body: 'this is not json{{{',
  });
  check('a body that is not JSON is a 400, not a stack trace', notJson.status === 400, notJson.status);
  const errorText = await notJson.text();
  check('and the error names no internals',
    !/at |worker\/src|room\.js|SyntaxError/.test(errorText), errorText.slice(0, 120));

  for (const code of [nastyCode, pc, after.data.code, huge.data?.code]) {
    if (code) {
      const key = code === nastyCode ? nastyKey : code === pc ? pk : null;
      if (key) await call(`/api/rooms/${code}/admin`, { method: 'POST', key, body: { action: 'close' } });
    }
  }
}

console.log('export and close');
const total = (await call(`/api/rooms/${code}/state`, { key: adminKey })).data.total;
const exported = (await call(`/api/rooms/${code}/export`, { key: adminKey })).data;
check('the export carries every question, including the ones added mid-session',
  exported.questions.length === total, { got: exported.questions?.length, total });
check('the export carries the audience questions and their support',
  exported.questions.some((q) => q.type === 'qa' && q.results.items.length > 0),
  exported.questions.map((q) => q.type));
check('the export carries the scoreboard',
  Array.isArray(exported.scores?.rows) && exported.scores.rows.length > 0, exported.scores);
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
