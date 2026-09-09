// One object per client-address hash, holding nothing but a counter and the
// alarm that wipes it. Creating a room is the only unauthenticated write in
// the whole application, so it is the only thing worth throttling here.
//
// The address is never stored: the object's own name is a truncated hash of
// it, and the object holds a count and a timestamp.

import { LIMITS } from '../../public/js/shared/limits.js?v=1';

const WINDOW_MS = 3600_000;

export class Throttle {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }

  async fetch() {
    const now = Date.now();
    // Created here rather than in the constructor: the alarm below drops these
    // tables while the instance is still in memory, and a constructor that
    // recreated them would resurrect a counter that was meant to be gone.
    this.sql.exec('CREATE TABLE IF NOT EXISTS window (id INTEGER PRIMARY KEY CHECK (id = 1), started INTEGER NOT NULL, n INTEGER NOT NULL)');
    const row = this.sql.exec('SELECT started, n FROM window WHERE id = 1').toArray()[0];
    if (!row || now - row.started >= WINDOW_MS) {
      this.sql.exec('INSERT OR REPLACE INTO window (id, started, n) VALUES (1, ?, 1)', now);
      this.ctx.storage.setAlarm(now + WINDOW_MS);
      return new Response(JSON.stringify({ ok: true, n: 1 }), { status: 200 });
    }
    if (row.n >= LIMITS.rate.roomsPerHourPerIp) {
      const retryAfter = Math.ceil((row.started + WINDOW_MS - now) / 1000);
      return new Response(JSON.stringify({ ok: false, retryAfter }), { status: 429 });
    }
    this.sql.exec('UPDATE window SET n = n + 1 WHERE id = 1');
    return new Response(JSON.stringify({ ok: true, n: row.n + 1 }), { status: 200 });
  }
}
