// One Durable Object per room, SQLite-backed (the only backend on the Workers
// free plan). It holds the questions, the votes and the presenter sockets, and
// it deletes itself when the room expires.
//
// Everything a participant sends is re-checked here. The browser's maxlength
// is a courtesy; this file is the boundary.

import { LIMITS } from '../../public/js/shared/limits.js?v=2';
import { sanitiseText, wordCount, cloudKey } from '../../public/js/shared/sanitize.js?v=2';
import { tallyChoice, tallyScale, tallyCloud, tallyRank } from '../../public/js/shared/aggregate.js?v=2';
import { readImage } from '../../public/js/shared/image.js?v=2';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS questions (
  idx INTEGER PRIMARY KEY, type TEXT NOT NULL, prompt TEXT NOT NULL, spec TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
  q INTEGER NOT NULL, voter TEXT NOT NULL, seq INTEGER NOT NULL,
  value TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL,
  -- Public number for an audience question, used only by the qa type. It
  -- exists so the list the whole room reads can name an item without naming
  -- the device that asked it.
  pub INTEGER,
  PRIMARY KEY (q, voter, seq)
);
CREATE TABLE IF NOT EXISTS voters (
  voter TEXT PRIMARY KEY, first_at INTEGER NOT NULL,
  window_at INTEGER NOT NULL, window_n INTEGER NOT NULL,
  nick TEXT
);
-- Question images live apart from the questions on purpose. questions() reads
-- every spec and runs on every vote (see scored(), vote() and the views), so an
-- image kept in the spec would mean re-reading every picture in the room each
-- time one person taps an option: twenty questions at a hundred kilobytes is
-- 2 MB of SQLite read per vote, on a backend billed by rows and bytes read.
-- Here it is loaded only for the question actually being sent to somebody.
CREATE TABLE IF NOT EXISTS images (
  idx INTEGER PRIMARY KEY, src TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS upvotes (
  q INTEGER NOT NULL, target_voter TEXT NOT NULL, target_seq INTEGER NOT NULL,
  voter TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (q, target_voter, target_seq, voter)
);
`;

const QUESTION_TYPES = new Set(['choice', 'scale', 'cloud', 'qa', 'rank']);

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
      if (q.image) this.sql.exec('INSERT INTO images (idx, src) VALUES (?, ?)', i, q.image);
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

  /**
   * The question as a phone may see it. Which options are right is stripped
   * until the presenter reveals them: sending it and merely not drawing it
   * would put the answer one network panel away from anyone in the room.
   */
  publicQuestion(q, revealed) {
    if (!q) return null;
    const spec = { ...q.spec };
    if (q.type === 'choice' && !revealed) delete spec.correct;
    // The picture is fetched here rather than carried in the spec, so the one
    // question going out is the only one read. spec.image is what the editor
    // wrote (the description, or nothing); src is the bytes.
    if (spec.image) spec.image = { ...spec.image, src: this.imageOf(q.idx) };
    return { idx: q.idx, type: q.type, prompt: q.prompt, spec };
  }

  /** The image bytes for one question, or null. One row, read on demand. */
  imageOf(idx) {
    const row = this.sql.exec('SELECT src FROM images WHERE idx = ?', idx).toArray()[0];
    return row?.src || null;
  }

  /** Whether anything in this room can be right, which is what makes a score. */
  hasScores() {
    return this.scored().length > 0;
  }

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
      question: this.publicQuestion(q, Boolean(this.meta('revealed'))),
      startedAt: this.meta('startedAt'),
      revealed: Boolean(this.meta('revealed')),
      scored: this.hasScores(),
      now: Date.now(),
      nick: this.nickOf(voter),
      mine,
    };
  }

  nickOf(voter) {
    const row = this.sql.exec('SELECT nick FROM voters WHERE voter = ?', voter).toArray()[0];
    return row?.nick || null;
  }

  /** Whether the clock has run out on the question now showing. */
  expired(q, now) {
    const seconds = q?.spec?.seconds || 0;
    if (!seconds) return false;
    const startedAt = this.meta('startedAt') || 0;
    return now > startedAt + seconds * 1000;
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
      // The presenter sees the whole question, right answers included: they
      // wrote it, and they are the one who decides when to reveal it.
      question: q ? { idx: q.idx, type: q.type, prompt: q.prompt, spec: q.spec } : null,
      questions: questions.map((x) => ({ idx: x.idx, type: x.type, prompt: x.prompt })),
      voters: this.sql.exec('SELECT COUNT(*) AS n FROM voters').toArray()[0].n,
      expiresAt: this.meta('expiresAt'),
      results: q ? this.results(q) : null,
      pending: q && (q.type === 'cloud' || q.type === 'qa') ? this.pending(current) : [],
      // Only when something in the room can be right or wrong. A scoreboard on
      // an opinion poll would be nonsense dressed as a result.
      scores: this.scored().length > 0 ? this.scoreboard() : null,
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
    if (q.type === 'qa') return { type: 'qa', items: this.qaItems(q.idx, '') };
    if (q.type === 'rank') {
      const byVoter = new Map();
      for (const r of rows) byVoter.set(r.voter, JSON.parse(r.value));
      return { type: 'rank', options: q.spec.options, ...tallyRank([...byVoter.values()], q.spec.options.length) };
    }
    return { type: 'cloud', ...tallyCloud(rows.map((r) => JSON.parse(r.value))) };
  }

  /**
   * Approved audience questions, most supported first. Ties break on arrival,
   * so two questions with the same support keep the order they were asked in
   * rather than shuffling every time the list is drawn.
   */
  qaItems(idx, voter) {
    const rows = this.sql.exec(
      "SELECT voter, seq, value, at, pub FROM votes WHERE q = ? AND state = 'ok' ORDER BY at", idx).toArray();
    const counts = new Map();
    for (const r of this.sql.exec(
      'SELECT target_voter, target_seq, COUNT(*) AS n FROM upvotes WHERE q = ? GROUP BY target_voter, target_seq',
      idx).toArray()) {
      counts.set(r.target_voter + '\u0000' + r.target_seq, r.n);
    }
    const mine = new Set(this.sql.exec(
      'SELECT target_voter, target_seq FROM upvotes WHERE q = ? AND voter = ?', idx, voter)
      .toArray().map((r) => r.target_voter + '\u0000' + r.target_seq));
    return rows.map((r, order) => {
      const key = r.voter + '\u0000' + r.seq;
      return {
        // Never the asker: an audience question is anonymous, and the device
        // token must not leak out through the list everyone can read.
        id: String(r.pub),
        text: JSON.parse(r.value),
        votes: counts.get(key) || 0,
        mine: mine.has(key),
        // Whether the person asking for this list wrote this one. Each viewer
        // learns it about their own items only, which is what lets a phone
        // stop offering to support a question it asked itself.
        own: r.voter === voter,
        order,
      };
    }).sort((a, b) => b.votes - a.votes || a.order - b.order);
  }

  // --- scoring -------------------------------------------------------------

  /** Questions that have a right answer, which is what makes a score exist. */
  scored() {
    return this.questions().filter((q) => q.type === 'choice' && q.spec.correct?.length > 0);
  }

  /**
   * One point per question answered exactly right. Exactly: on a question that
   * allows several answers, picking three of four correct options is not
   * three-quarters right, it is a different answer.
   */
  scoreboard() {
    const scored = this.scored();
    const totals = new Map();
    for (const q of scored) {
      const want = JSON.stringify(q.spec.correct);
      for (const r of this.sql.exec(
        "SELECT voter, value FROM votes WHERE q = ? AND state = 'ok'", q.idx).toArray()) {
        const picks = JSON.parse(r.value);
        const got = JSON.stringify([...new Set(Array.isArray(picks) ? picks : [picks])].sort((a, b) => a - b));
        if (!totals.has(r.voter)) totals.set(r.voter, 0);
        if (got === want) totals.set(r.voter, totals.get(r.voter) + 1);
      }
    }
    const nicks = new Map(this.sql.exec('SELECT voter, nick FROM voters').toArray()
      .map((r) => [r.voter, r.nick]));
    const rows = [...totals.entries()]
      .map(([voter, score]) => ({ nick: nicks.get(voter) || null, score }))
      // Only people who chose a name appear. Someone who never entered one has
      // not agreed to be on a wall in front of the room.
      .filter((r) => r.nick)
      .sort((a, b) => b.score - a.score || a.nick.localeCompare(b.nick))
      .slice(0, LIMITS.quiz.boardSize);
    return { of: scored.length, rows };
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
    if (this.expired(q, now)) return { error: 'time_up', status: 409 };

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
      : q.type === 'qa'
        ? this.writeQa(q, voter, value, now)
        : this.writeSingle(q, voter, value, now);
    if (written.error) return written;

    this.broadcast();
    return { ok: true, mine: this.participantView(voter).mine };
  }

  writeSingle(q, voter, value, now) {
    let stored;
    if (q.type === 'rank') {
      const order = Array.isArray(value) ? value : [];
      const seen = new Set(order.filter((i) => Number.isInteger(i) && i >= 0 && i < q.spec.options.length));
      // A partial ordering is refused rather than stored and discarded later:
      // the person should be told, not quietly left out of the count.
      if (order.length !== q.spec.options.length || seen.size !== q.spec.options.length) {
        return { error: 'incomplete_order', status: 400 };
      }
      stored = order;
    } else if (q.type === 'choice') {
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
    // An entry that folds to nothing is refused here rather than accepted and
    // then dropped by the tally. "'--" is not empty, but the cloud merges on a
    // key with edge punctuation stripped, so it would have been counted as a
    // success and then never appeared, and the person who sent it would have
    // had no way to know.
    if (cloudKey(text) === '') return { error: 'empty', status: 400 };
    if (wordCount(text) > LIMITS.cloud.maxWords) return { error: 'too_many_words', status: 400 };

    const mine = this.sql.exec('SELECT seq FROM votes WHERE q = ? AND voter = ? ORDER BY seq',
      q.idx, voter).toArray();
    const allowed = Math.min(q.spec.entries, LIMITS.cloud.maxEntriesPerVoter);
    if (mine.length >= allowed) return { error: 'entries_used', status: 409 };

    const state = q.spec.moderation ? 'pending' : 'ok';
    // No public number: a cloud entry is never addressed individually, only
    // moderated by the presenter, who already knows who is who.
    this.sql.exec('INSERT INTO votes (q, voter, seq, value, state, at) VALUES (?, ?, ?, ?, ?, ?)',
      q.idx, voter, mine.length, JSON.stringify(text), state, now);
    return { ok: true };
  }

  writeQa(q, voter, value, now) {
    const text = sanitiseText(String(value ?? ''), LIMITS.qa.maxChars);
    if (text === '') return { error: 'empty', status: 400 };

    const mine = this.sql.exec('SELECT seq FROM votes WHERE q = ? AND voter = ? ORDER BY seq',
      q.idx, voter).toArray();
    if (mine.length >= LIMITS.qa.maxPerVoter) return { error: 'entries_used', status: 409 };
    const total = this.sql.exec('SELECT COUNT(*) AS n FROM votes WHERE q = ?', q.idx).toArray()[0].n;
    if (total >= LIMITS.qa.maxItems) return { error: 'room_full', status: 429 };

    const state = q.spec.moderation ? 'pending' : 'ok';
    // The public number is the position in the question, not anything derived
    // from who asked. An id built from the device token would have put that
    // token in the list everyone reads, and two questions from one person
    // would have been linkable by anyone in the room.
    this.sql.exec('INSERT INTO votes (q, voter, seq, value, state, at, pub) VALUES (?, ?, ?, ?, ?, ?, ?)',
      q.idx, voter, mine.length, JSON.stringify(text), state, now, total);
    return { ok: true };
  }

  /**
   * Supporting someone else's question. One per person per question, and it
   * can be taken back, because a list that only ever grows rewards whoever
   * asked first rather than whatever the room actually wants answered.
   */
  upvote({ voter, idx, id, now }) {
    if (idx !== this.meta('current')) return { error: 'not_current', status: 409 };
    const q = this.questions()[idx];
    if (!q || q.type !== 'qa') return { error: 'no_question', status: 404 };
    if (this.meta('locked')) return { error: 'locked', status: 409 };

    const pub = Number(id);
    if (!Number.isInteger(pub) || pub < 0) return { error: 'empty', status: 400 };

    // The public number resolves to a row here, inside the object, and the
    // answer never leaves it.
    const row = this.sql.exec(
      "SELECT voter, seq FROM votes WHERE q = ? AND pub = ? AND state = 'ok'", idx, pub).toArray()[0];
    if (!row) return { error: 'no_question', status: 404 };
    const target = row.voter;
    const seq = row.seq;
    if (target === voter) return { error: 'own_question', status: 409 };

    const had = this.sql.exec(
      'SELECT 1 AS x FROM upvotes WHERE q = ? AND target_voter = ? AND target_seq = ? AND voter = ?',
      idx, target, seq, voter).toArray()[0];
    if (had) {
      this.sql.exec('DELETE FROM upvotes WHERE q = ? AND target_voter = ? AND target_seq = ? AND voter = ?',
        idx, target, seq, voter);
    } else {
      this.sql.exec('INSERT INTO upvotes (q, target_voter, target_seq, voter, at) VALUES (?, ?, ?, ?, ?)',
        idx, target, seq, voter, now);
    }
    this.broadcast();
    return { ok: true, items: this.qaItems(idx, voter) };
  }

  /**
   * A name for the scoreboard, chosen on the device and stored nowhere else.
   * It is optional: without one you can still answer everything, you simply do
   * not appear on the wall.
   */
  setNick({ voter, nick, now }) {
    const clean = sanitiseText(String(nick ?? ''), LIMITS.quiz.maxNickChars);
    if (clean === '') return { error: 'empty', status: 400 };
    const taken = this.sql.exec('SELECT voter FROM voters WHERE nick = ? AND voter != ?', clean, voter)
      .toArray()[0];
    if (taken) return { error: 'nick_taken', status: 409 };
    const seen = this.sql.exec('SELECT voter FROM voters WHERE voter = ?', voter).toArray()[0];
    if (!seen) {
      const n = this.sql.exec('SELECT COUNT(*) AS n FROM voters').toArray()[0].n;
      if (n >= LIMITS.room.maxVoters) return { error: 'room_full', status: 429 };
      this.sql.exec('INSERT INTO voters (voter, first_at, window_at, window_n, nick) VALUES (?, ?, ?, 0, ?)',
        voter, now, now, clean);
    } else {
      this.sql.exec('UPDATE voters SET nick = ? WHERE voter = ?', clean, voter);
    }
    this.broadcast();
    return { ok: true, nick: clean };
  }

  // --- presenter actions ---------------------------------------------------

  admin({ action, payload, now }) {
    if (action === 'goto') {
      const total = this.questions().length;
      const idx = Number(payload.idx);
      if (!Number.isInteger(idx) || idx < -1 || idx >= total) return { error: 'no_question', status: 400 };
      this.setMeta('current', idx);
      this.setMeta('locked', false);
      // The clock is the server's, not the phone's. A countdown driven by the
      // device would let anyone answer late by moving their own clock back.
      this.setMeta('startedAt', now);
      this.setMeta('revealed', false);
    } else if (action === 'lock') {
      this.setMeta('locked', Boolean(payload.locked));
    } else if (action === 'moderate') {
      const state = payload.approve ? 'ok' : 'hidden';
      this.sql.exec('UPDATE votes SET state = ? WHERE q = ? AND voter = ? AND seq = ?',
        state, this.meta('current'), String(payload.voter), Number(payload.seq));
    } else if (action === 'reset') {
      this.sql.exec('DELETE FROM votes WHERE q = ?', this.meta('current'));
    } else if (action === 'add') {
      const questions = this.questions();
      if (questions.length >= LIMITS.room.maxQuestions) {
        return { error: 'room_questions_full', status: 409 };
      }
      const prepared = prepareQuestion(payload.question || {});
      if (!prepared) return { error: 'unusable_questions', status: 422 };
      const idx = questions.length;
      this.sql.exec('INSERT INTO questions (idx, type, prompt, spec) VALUES (?, ?, ?, ?)',
        idx, prepared.type, prepared.prompt, JSON.stringify(prepared.spec));
      if (prepared.image) this.sql.exec('INSERT INTO images (idx, src) VALUES (?, ?)', idx, prepared.image);
    } else if (action === 'reveal') {
      this.setMeta('revealed', Boolean(payload.revealed));
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
    const scored = this.scored().length > 0;
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
      // Present only when something in the room had a right answer, so an
      // opinion poll's export does not carry an empty scoreboard implying one.
      scores: scored ? this.scoreboard() : null,
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
      question: this.publicQuestion(q, Boolean(this.meta('revealed'))),
      startedAt: this.meta('startedAt'),
      revealed: Boolean(this.meta('revealed')),
      scored: this.hasScores(),
      now: Date.now(),
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
      if (this.ctx.getWebSockets().length >= LIMITS.room.maxSockets) {
        return json({ error: 'room_full' }, 429);
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ role: 'follower' });
      pair[1].send(JSON.stringify({ type: 'question', ...this.followerView() }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (op === 'qa') {
      // Fetched on demand rather than pushed. A room supporting each other's
      // questions generates a change every second or two, and streaming that
      // to every phone would multiply it by the size of the room, which is the
      // one thing the whole design exists to avoid.
      const idx = Number(url.searchParams.get('idx'));
      const q = this.questions()[idx];
      if (!q || q.type !== 'qa') return json({ error: 'no_question' }, 404);
      return json({ items: this.qaItems(idx, url.searchParams.get('voter') || '') });
    }

    if (op === 'image') {
      // A question's picture, served as an image rather than carried in the
      // presenter's socket. That socket pushes the tally on every single vote,
      // so nothing large may ride on it: a hundred kilobytes there would be a
      // hundred kilobytes per vote. Phones get the picture inline instead,
      // because their push happens only when the presenter moves.
      //
      // One request per question, on one device, and the browser caches it for
      // as long as the room can live. Going back to a question costs nothing.
      const idx = Number(url.searchParams.get('idx'));
      const image = Number.isInteger(idx) ? readImage(this.imageOf(idx)) : null;
      if (!image) return json({ error: 'no_image' }, 404);
      return new Response(base64ToBytes(image.src.slice(image.src.indexOf(',') + 1)), {
        status: 200,
        headers: {
          // The type comes from the allowlist in LIMITS.image, never from the
          // request, so this can only ever be one of three raster types. With
          // nosniff and a policy of its own, a direct hit on this URL is a
          // picture and cannot become a document.
          'content-type': image.mime,
          'cache-control': 'private, max-age=43200, immutable',
          'content-security-policy': "default-src 'none'; sandbox",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        },
      });
    }

    if (op === 'results') {
      // Fetched by a phone, once, and only for a question whose author chose to
      // share the tally. Still a fetch and not a push: one request per person
      // per question is linear, streaming it would not be.
      const idx = Number(url.searchParams.get('idx'));
      const q = this.questions()[idx];
      if (!q) return json({ error: 'no_question' }, 404);
      if (!q.spec.showResults) return json({ error: 'forbidden' }, 403);
      return json({ results: this.results(q) });
    }

    if (op === 'upvote') {
      const body = await request.json();
      const r = this.upvote({
        voter: url.searchParams.get('voter') || '',
        idx: Number(body.idx),
        id: body.id,
        now,
      });
      return r.error ? json({ error: r.error }, r.status) : json(r);
    }

    if (op === 'nick') {
      const body = await request.json();
      const r = this.setNick({ voter: url.searchParams.get('voter') || '', nick: body.nick, now });
      return r.error ? json({ error: r.error }, r.status) : json(r);
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
      if (this.ctx.getWebSockets().length >= LIMITS.room.maxSockets) {
        return json({ error: 'room_full' }, 429);
      }
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

/**
 * A question as it will be stored. The image is handled here rather than in
 * each of the five type branches, because it means the same thing on all of
 * them: a picture the question is about.
 *
 * The bytes come back on `image`, separate from the spec, because they are
 * stored in their own table. The spec keeps only the description, which is
 * small, belongs with the question, and is read on every vote anyway.
 */
function prepareQuestion(q) {
  const prepared = prepareQuestionBody(q);
  if (!prepared) return null;
  const image = readImage(q.image?.src);
  if (image) {
    prepared.image = image.src;
    prepared.spec.image = { alt: sanitiseText(String(q.image?.alt ?? ''), LIMITS.image.maxAltChars) };
  }
  return prepared;
}

function prepareQuestionBody(q) {
  if (!q || !QUESTION_TYPES.has(q.type)) return null;
  const prompt = sanitiseText(String(q.prompt ?? ''), LIMITS.prompt.maxChars);
  if (prompt === '') return null;

  const seconds = clamp(Number(q.seconds) || 0, 0, LIMITS.question.maxSeconds);

  if (q.type === 'choice') {
    const options = (Array.isArray(q.options) ? q.options : [])
      .map((o) => sanitiseText(String(o ?? ''), LIMITS.choice.maxOptionChars))
      .filter((o) => o !== '')
      .slice(0, LIMITS.choice.maxOptions);
    if (options.length < 2) return null;
    // Which options are right, if any. An empty list means this is a poll and
    // there is nothing to be right about, which stays the default.
    const correct = [...new Set((Array.isArray(q.correct) ? q.correct : [])
      .filter((i) => Number.isInteger(i) && i >= 0 && i < options.length))]
      .sort((a, b) => a - b);
    // How the projector draws it. Bars unless asked otherwise: they are the
    // most legible of the three from the back of a room.
    const chart = ['bars', 'donut', 'dots'].includes(q.chart) ? q.chart : 'bars';
    return {
      type: 'choice',
      prompt,
      spec: { options, multiple: Boolean(q.multiple), correct, seconds, chart, showResults: q.showResults === true },
    };
  }

  if (q.type === 'qa') {
    return { type: 'qa', prompt, spec: { moderation: q.moderation !== false, seconds } };
  }

  if (q.type === 'rank') {
    const options = (Array.isArray(q.options) ? q.options : [])
      .map((o) => sanitiseText(String(o ?? ''), LIMITS.choice.maxOptionChars))
      .filter((o) => o !== '')
      .slice(0, LIMITS.choice.maxOptions);
    if (options.length < 2) return null;
    return { type: 'rank', prompt, spec: { options, seconds, showResults: q.showResults === true } };
  }

  if (q.type === 'scale') {
    const steps = clamp(Number(q.steps) || 5, LIMITS.scale.minSteps, LIMITS.scale.maxSteps);
    return {
      type: 'scale',
      prompt,
      spec: {
        steps,
        showResults: q.showResults === true,
        labels: {
          min: sanitiseText(String(q.labels?.min ?? ''), LIMITS.choice.maxOptionChars),
          max: sanitiseText(String(q.labels?.max ?? ''), LIMITS.choice.maxOptionChars),
        },
      },
    };
  }

  // A word cloud publishes straight to the screen. The entries are one to three
  // words, already stripped of anything that could reorder or overflow what is
  // displayed, and holding each one for approval turned every cloud into a
  // queue the presenter had to work through while the room waited. Approval is
  // still available per question, off unless asked for.
  //
  // Audience questions are the other way round: whole sentences, and long
  // enough to say something the presenter would not want on a wall, so those
  // still default to waiting.
  return {
    type: 'cloud',
    prompt,
    spec: {
      entries: clamp(Number(q.entries) || 1, 1, LIMITS.cloud.maxEntriesPerVoter),
      moderation: q.moderation === true,
      showResults: q.showResults === true,
    },
  };
}

/** base64 to bytes. The payload has already been checked by readImage(). */
function base64ToBytes(payload) {
  const binary = atob(payload);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
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
