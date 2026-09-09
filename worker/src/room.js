// One Durable Object per room, SQLite-backed (the only backend on the Workers
// free plan). It holds the questions, the votes and the presenter sockets, and
// it deletes itself when the room expires.
//
// Everything a participant sends is re-checked here. The browser's maxlength
// is a courtesy; this file is the boundary.

import { LIMITS } from '../../public/js/shared/limits.js?v=1';
import { sanitiseText, wordCount } from '../../public/js/shared/sanitize.js?v=1';
import { tallyChoice, tallyScale, tallyCloud } from '../../public/js/shared/aggregate.js?v=1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS questions (
  idx INTEGER PRIMARY KEY, type TEXT NOT NULL, prompt TEXT NOT NULL, spec TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
  q INTEGER NOT NULL, voter TEXT NOT NULL, seq INTEGER NOT NULL,
  value TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (q, voter, seq)
);
CREATE TABLE IF NOT EXISTS voters (
  voter TEXT PRIMARY KEY, first_at INTEGER NOT NULL,
  window_at INTEGER NOT NULL, window_n INTEGER NOT NULL
);
`;

const QUESTION_TYPES = new Set(['choice', 'scale', 'cloud']);

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    // The schema is NOT created here, and that is deliberate twice over.
    //
    // A closed room calls deleteAll(), which drops the tables while this
    // instance stays in memory; recreating them on the way back in would make
    // a deleted room answer 500 instead of 404, or resurrect it as an empty
    // shell that is billed for its own emptiness until something evicts it.
    //
    // It also means that probing codes that do not exist creates nothing: an
    // object with no storage is never materialised at all.
  }

  // --- storage helpers -----------------------------------------------------

  meta(key) {
    const row = this.sql.exec('SELECT v FROM meta WHERE k = ?', key).toArray()[0];
    return row ? JSON.parse(row.v) : null;
  }

  setMeta(key, value) {
    this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', key, JSON.stringify(value));
  }

  /**
   * True only for a room that was created and not closed. The tables may not
   * exist at all, which is not an error: it is the answer.
   */
  exists() {
    try {
      return this.meta('code') !== null;
    } catch {
      return false;
    }
  }

  questions() {
    return this.sql.exec('SELECT idx, type, prompt, spec FROM questions ORDER BY idx').toArray()
      .map((r) => ({ idx: r.idx, type: r.type, prompt: r.prompt, spec: JSON.parse(r.spec) }));
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Claim this object for a room. Object names are the codes, so a second
   * creation with the same code finds a room here and is turned away, and that
   * is the whole collision check.
   *
   * The two ways this fails are kept apart on purpose. A taken code is worth
   * retrying with another code; questions that cannot be used never will be,
   * and reporting both as 409 made the router retry five times and answer with
   * a 503 that named neither cause.
   */
  create({ code, questions, locale, now }) {
    if (this.exists()) return { error: 'taken', status: 409 };

    const clean = [];
    for (const q of questions.slice(0, LIMITS.room.maxQuestions)) {
      const prepared = prepareQuestion(q);
      if (prepared) clean.push(prepared);
    }
    if (clean.length === 0) return { error: 'unusable_questions', status: 422 };

    this.sql.exec(SCHEMA);

    const adminKey = randomKey();
    const expiresAt = now + LIMITS.room.ttlHours * 3600_000;
    this.setMeta('code', code);
    this.setMeta('adminKey', adminKey);
    this.setMeta('locale', typeof locale === 'string' ? locale.slice(0, 5) : 'en');
    this.setMeta('createdAt', now);
    this.setMeta('expiresAt', expiresAt);
    this.setMeta('current', -1);
    this.setMeta('locked', false);
    clean.forEach((q, i) => {
      this.sql.exec('INSERT INTO questions (idx, type, prompt, spec) VALUES (?, ?, ?, ?)',
        i, q.type, q.prompt, JSON.stringify(q.spec));
    });
    this.ctx.storage.setAlarm(expiresAt);
    return { room: { code, adminKey, expiresAt, questions: clean.length } };
  }

  /**
   * The room's whole life is one alarm: when it fires, nothing is left. The
   * schema is not recreated afterwards, so the object holds no storage and the
   * platform reclaims it.
   */
  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ type: 'expired' }));
        ws.close(1000, 'room expired');
      } catch { /* the socket was already gone */ }
    }
    await this.ctx.storage.deleteAll();
  }

  // --- views ---------------------------------------------------------------

  /** What a participant is allowed to know. Never the results, never the key. */
  participantView(voter) {
    const current = this.meta('current');
    const questions = this.questions();
    const q = current >= 0 ? questions[current] : null;
    const mine = q
      ? this.sql.exec('SELECT seq, value, state FROM votes WHERE q = ? AND voter = ? ORDER BY seq',
        current, voter).toArray().map((r) => ({ value: JSON.parse(r.value), state: r.state }))
      : [];
    return {
      code: this.meta('code'),
      locale: this.meta('locale'),
      total: questions.length,
      locked: this.meta('locked'),
      current,
      question: q ? { idx: q.idx, type: q.type, prompt: q.prompt, spec: q.spec } : null,
      mine,
    };
  }

  /** What the projector shows: the same as above plus the tally. */
  presenterView() {
    const base = this.participantView('');
    const current = base.current;
    const questions = this.questions();
    const q = current >= 0 ? questions[current] : null;
    return {
      ...base,
      mine: undefined,
      questions: questions.map((x) => ({ idx: x.idx, type: x.type, prompt: x.prompt })),
      voters: this.sql.exec('SELECT COUNT(*) AS n FROM voters').toArray()[0].n,
      expiresAt: this.meta('expiresAt'),
      results: q ? this.results(q) : null,
      pending: q && q.type === 'cloud' ? this.pending(current) : [],
    };
  }

  results(q) {
    const rows = this.sql.exec(
      "SELECT voter, value FROM votes WHERE q = ? AND state = 'ok'", q.idx).toArray();
    if (q.type === 'choice') {
      const byVoter = new Map();
      for (const r of rows) byVoter.set(r.voter, JSON.parse(r.value));
      return { type: 'choice', options: q.spec.options, ...tallyChoice([...byVoter.values()], q.spec.options.length) };
    }
    if (q.type === 'scale') {
      const byVoter = new Map();
      for (const r of rows) byVoter.set(r.voter, JSON.parse(r.value));
      return { type: 'scale', steps: q.spec.steps, labels: q.spec.labels, ...tallyScale([...byVoter.values()], q.spec.steps) };
    }
    return { type: 'cloud', ...tallyCloud(rows.map((r) => JSON.parse(r.value))) };
  }

  pending(idx) {
    return this.sql.exec(
      "SELECT voter, seq, value FROM votes WHERE q = ? AND state = 'pending' ORDER BY at", idx)
      .toArray().map((r) => ({ voter: r.voter, seq: r.seq, text: JSON.parse(r.value) }));
  }

  // --- voting --------------------------------------------------------------

  vote({ voter, idx, value, now }) {
    if (this.meta('locked')) return { error: 'locked', status: 409 };
    if (idx !== this.meta('current')) return { error: 'not_current', status: 409 };

    const q = this.questions()[idx];
    if (!q) return { error: 'no_question', status: 404 };

    const seen = this.sql.exec('SELECT window_at, window_n FROM voters WHERE voter = ?', voter).toArray()[0];
    if (!seen) {
      const n = this.sql.exec('SELECT COUNT(*) AS n FROM voters').toArray()[0].n;
      if (n >= LIMITS.room.maxVoters) return { error: 'room_full', status: 429 };
      this.sql.exec('INSERT INTO voters (voter, first_at, window_at, window_n) VALUES (?, ?, ?, 0)',
        voter, now, now);
    } else if (now - seen.window_at < 60_000) {
      if (seen.window_n >= LIMITS.rate.votesPerMinute) return { error: 'too_fast', status: 429 };
      this.sql.exec('UPDATE voters SET window_n = window_n + 1 WHERE voter = ?', voter);
    } else {
      this.sql.exec('UPDATE voters SET window_at = ?, window_n = 1 WHERE voter = ?', now, voter);
    }

    const written = q.type === 'cloud'
      ? this.writeCloud(q, voter, value, now)
      : this.writeSingle(q, voter, value, now);
    if (written.error) return written;

    this.broadcast();
    return { ok: true, mine: this.participantView(voter).mine };
  }

  writeSingle(q, voter, value, now) {
    let stored;
    if (q.type === 'choice') {
      const picks = [...new Set((Array.isArray(value) ? value : [value])
        .filter((v) => Number.isInteger(v) && v >= 0 && v < q.spec.options.length))];
      if (picks.length === 0) return { error: 'empty', status: 400 };
      if (!q.spec.multiple && picks.length > 1) return { error: 'single_only', status: 400 };
      stored = picks;
    } else {
      const v = Number(value);
      if (!Number.isInteger(v) || v < 1 || v > q.spec.steps) return { error: 'out_of_range', status: 400 };
      stored = v;
    }
    // seq 0 always: a second answer replaces the first, so changing your mind
    // is free and nobody can stuff the ballot by resubmitting.
    this.sql.exec(
      "INSERT OR REPLACE INTO votes (q, voter, seq, value, state, at) VALUES (?, ?, 0, ?, 'ok', ?)",
      q.idx, voter, JSON.stringify(stored), now);
    return { ok: true };
  }

  writeCloud(q, voter, value, now) {
    const text = sanitiseText(String(value ?? ''), LIMITS.cloud.maxChars);
    if (text === '') return { error: 'empty', status: 400 };
    if (wordCount(text) > LIMITS.cloud.maxWords) return { error: 'too_many_words', status: 400 };

    const mine = this.sql.exec('SELECT seq FROM votes WHERE q = ? AND voter = ? ORDER BY seq',
      q.idx, voter).toArray();
    const allowed = Math.min(q.spec.entries, LIMITS.cloud.maxEntriesPerVoter);
    if (mine.length >= allowed) return { error: 'entries_used', status: 409 };

    const state = q.spec.moderation ? 'pending' : 'ok';
    this.sql.exec('INSERT INTO votes (q, voter, seq, value, state, at) VALUES (?, ?, ?, ?, ?, ?)',
      q.idx, voter, mine.length, JSON.stringify(text), state, now);
    return { ok: true };
  }

  // --- presenter actions ---------------------------------------------------

  admin({ action, payload, now }) {
    if (action === 'goto') {
      const total = this.questions().length;
      const idx = Number(payload.idx);
      if (!Number.isInteger(idx) || idx < -1 || idx >= total) return { error: 'no_question', status: 400 };
      this.setMeta('current', idx);
      this.setMeta('locked', false);
    } else if (action === 'lock') {
      this.setMeta('locked', Boolean(payload.locked));
    } else if (action === 'moderate') {
      const state = payload.approve ? 'ok' : 'hidden';
      this.sql.exec('UPDATE votes SET state = ? WHERE q = ? AND voter = ? AND seq = ?',
        state, this.meta('current'), String(payload.voter), Number(payload.seq));
    } else if (action === 'reset') {
      this.sql.exec('DELETE FROM votes WHERE q = ?', this.meta('current'));
    } else if (action === 'close') {
      return { closed: true };
    } else {
      return { error: 'unknown_action', status: 400 };
    }
    // A moderation call changes only what the projector shows; the others
    // change what every phone in the room should be looking at.
    this.broadcast({ toFollowers: action !== 'moderate' });
    return { ok: true, state: this.presenterView(), now };
  }

  export() {
    const questions = this.questions();
    return {
      code: this.meta('code'),
      createdAt: this.meta('createdAt'),
      exportedAt: Date.now(),
      questions: questions.map((q) => ({
        prompt: q.prompt,
        type: q.type,
        spec: q.spec,
        results: this.results(q),
      })),
    };
  }

  // --- sockets -------------------------------------------------------------

  /**
   * Two kinds of socket, and the difference is what keeps this inside the free
   * plan. Every WebSocket message is a billed request, so what is broadcast to
   * everyone has to be rare.
   *
   *   presenter: the full tally, pushed on every single vote. One or two
   *              sockets, so the cost is linear in votes.
   *   follower:  the current question and nothing else, pushed only when the
   *              presenter moves. Ten or so pushes in a session, times the
   *              size of the room.
   *
   * Pushing the tally to everyone would be the size of the room times the
   * number of votes: 200 people answering ten questions would be 400,000
   * messages, four days of the free daily allowance in one workshop. Making
   * phones poll instead is worse still. This split costs about 6,000 requests
   * for the same session.
   */
  broadcast({ toFollowers = false } = {}) {
    const forPresenter = JSON.stringify({ type: 'state', state: this.presenterView() });
    const forFollowers = toFollowers ? JSON.stringify({ type: 'question', ...this.followerView() }) : null;
    for (const ws of this.ctx.getWebSockets()) {
      const role = (ws.deserializeAttachment() || {}).role;
      const payload = role === 'presenter' ? forPresenter : forFollowers;
      if (!payload) continue;
      try {
        ws.send(payload);
      } catch {
        try { ws.close(1011, 'send failed'); } catch { /* already gone */ }
      }
    }
  }

  /** What is pushed to every phone in the room. No results, no key, no votes. */
  followerView() {
    const current = this.meta('current');
    const questions = this.questions();
    const q = current >= 0 ? questions[current] : null;
    return {
      current,
      total: questions.length,
      locked: this.meta('locked'),
      question: q ? { idx: q.idx, type: q.type, prompt: q.prompt, spec: q.spec } : null,
    };
  }

  webSocketMessage(ws, message) {
    // Read-only. Every action goes over HTTP so that it is authenticated by
    // header on each call rather than once at handshake time.
    if (message === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  }

  webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code, reason); } catch { /* already closing */ }
  }

  // --- entry point ---------------------------------------------------------

  async fetch(request) {
    const url = new URL(request.url);
    const op = url.searchParams.get('op');
    const now = Date.now();

    if (op === 'create') {
      const body = await request.json();
      const made = this.create({ ...body, now });
      return made.error ? json({ error: made.error }, made.status) : json(made.room);
    }

    if (!this.exists()) return json({ error: 'no_room' }, 404);

    if (op === 'view') {
      return json(this.participantView(url.searchParams.get('voter') || ''));
    }

    if (op === 'follow') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ role: 'follower' });
      pair[1].send(JSON.stringify({ type: 'question', ...this.followerView() }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (op === 'vote') {
      const body = await request.json();
      const r = this.vote({
        voter: url.searchParams.get('voter') || '',
        idx: Number(body.idx),
        value: body.value,
        now,
      });
      return r.error ? json({ error: r.error }, r.status) : json(r);
    }

    // Everything below needs the admin key, compared in constant time.
    const key = url.searchParams.get('key') || '';
    if (!timingSafeEqual(key, this.meta('adminKey'))) return json({ error: 'forbidden' }, 403);

    if (op === 'live') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426);
      const pair = new WebSocketPair();
      // Hibernation: the object is evicted from memory between votes and is
      // not billed for duration while it sleeps. A 90-minute workshop with a
      // socket held awake would burn most of a day's free GB-s.
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ role: 'presenter' });
      pair[1].send(JSON.stringify({ type: 'state', state: this.presenterView() }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (op === 'state') return json(this.presenterView());
    if (op === 'export') return json(this.export());

    if (op === 'admin') {
      const body = await request.json();
      const r = this.admin({ action: body.action, payload: body.payload || {}, now });
      if (r.error) return json({ error: r.error }, r.status);
      if (r.closed) {
        await this.alarm();
        return json({ ok: true, closed: true });
      }
      return json(r);
    }

    return json({ error: 'unknown_op' }, 400);
  }
}

// --- helpers ---------------------------------------------------------------

function prepareQuestion(q) {
  if (!q || !QUESTION_TYPES.has(q.type)) return null;
  const prompt = sanitiseText(String(q.prompt ?? ''), LIMITS.prompt.maxChars);
  if (prompt === '') return null;

  if (q.type === 'choice') {
    const options = (Array.isArray(q.options) ? q.options : [])
      .map((o) => sanitiseText(String(o ?? ''), LIMITS.choice.maxOptionChars))
      .filter((o) => o !== '')
      .slice(0, LIMITS.choice.maxOptions);
    if (options.length < 2) return null;
    return { type: 'choice', prompt, spec: { options, multiple: Boolean(q.multiple) } };
  }

  if (q.type === 'scale') {
    const steps = clamp(Number(q.steps) || 5, LIMITS.scale.minSteps, LIMITS.scale.maxSteps);
    return {
      type: 'scale',
      prompt,
      spec: {
        steps,
        labels: {
          min: sanitiseText(String(q.labels?.min ?? ''), LIMITS.choice.maxOptionChars),
          max: sanitiseText(String(q.labels?.max ?? ''), LIMITS.choice.maxOptionChars),
        },
      },
    };
  }

  // Moderation defaults to on, and turning it off is a deliberate act by the
  // person standing next to the screen.
  return {
    type: 'cloud',
    prompt,
    spec: {
      entries: clamp(Number(q.entries) || 1, 1, LIMITS.cloud.maxEntriesPerVoter),
      moderation: q.moderation !== false,
    },
  };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function randomKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Length-independent comparison, so a wrong key leaks nothing by timing. */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
