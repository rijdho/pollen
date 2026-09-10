// One object per client-address hash, holding nothing but a counter and the
// alarm that wipes it. Creating a room is the only unauthenticated write in
// the whole application, so it is the only thing worth throttling here.
//
// The address is never stored: the object's own name is a truncated hash of
// it, and the object holds a count and a timestamp.

import { LIMITS } from '../../public/js/shared/limits.js?v=2';

const WINDOW_MS = 3600_000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export class Throttle {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }

  /**
   * Two operations, and keeping them apart matters.
   *
   *   check: is there budget left? Reads, never writes.
   *   spend: a room actually opened, so charge for it.
   *
   * They were one call once, charged before the room was built, so a request
   * with unusable questions or a code collision used up an hour's budget for a
   * room that never existed. Someone preparing a workshop then hit the limit
   * having successfully opened nothing.
   */
  async fetch(request) {
    const now = Date.now();
    const op = new URL(request.url).searchParams.get('op') || 'check';
    // Created here rather than in the constructor: the alarm below drops these
    // tables while the instance is still in memory, and a constructor that
    // recreated them would resurrect a counter that was meant to be gone.
    this.sql.exec('CREATE TABLE IF NOT EXISTS window (id INTEGER PRIMARY KEY CHECK (id = 1), started INTEGER NOT NULL, n INTEGER NOT NULL)');
    const row = this.sql.exec('SELECT started, n FROM window WHERE id = 1').toArray()[0];
    const fresh = !row || now - row.started >= WINDOW_MS;
    const used = fresh ? 0 : row.n;

    if (used >= LIMITS.rate.roomsPerHourPerIp) {
      const retryAfter = Math.ceil((row.started + WINDOW_MS - now) / 1000);
      return json({ ok: false, retryAfter }, 429);
    }
    if (op === 'spend') {
      if (fresh) {
        this.sql.exec('INSERT OR REPLACE INTO window (id, started, n) VALUES (1, ?, 1)', now);
        this.ctx.storage.setAlarm(now + WINDOW_MS);
      } else {
        this.sql.exec('UPDATE window SET n = n + 1 WHERE id = 1');
      }
    }
    return json({ ok: true, used: used + (op === 'spend' ? 1 : 0), of: LIMITS.rate.roomsPerHourPerIp });
  }
}
