// A Durable Object runtime, in Node.
//
// The point of this file is that `worker/src/` is reused BYTE FOR BYTE. The
// room logic, the routing, the SQL, the rate limits and the socket handling are
// the code that runs on Cloudflare, not a second implementation of it, so the
// two cannot drift apart and the same test suites exercise both.
//
// What Cloudflare's Durable Objects give you is a single place per room where
// state lives and requests serialise. A Node process has that for free, which
// is why this adapter is small: most of it is translating one API's spelling
// into another's.

import { DatabaseSync } from 'node:sqlite';

/**
 * `ctx.storage.sql`, on top of node:sqlite.
 *
 * Cloudflare returns a cursor with .toArray(); node:sqlite returns rows from
 * .all(). The placeholders are the same, which is the part that matters: every
 * statement in the Worker is parameterised and stays that way here.
 */
class Sql {
  constructor(db) {
    this.db = db;
  }

  exec(query, ...params) {
    // The schema arrives as several statements in one string, which prepare()
    // will not take.
    if (params.length === 0 && query.includes(';') && /create table/i.test(query)) {
      this.db.exec(query);
      return { toArray: () => [] };
    }
    const statement = this.db.prepare(query);
    if (/^\s*select/i.test(query)) {
      const rows = statement.all(...params);
      return { toArray: () => rows };
    }
    statement.run(...params);
    return { toArray: () => [] };
  }
}

/** `ctx.storage`: the SQL handle, the alarm, and wiping the object. */
class Storage {
  constructor(instance, db) {
    this.sql = new Sql(db);
    this.instance = instance;
    this.db = db;
    this.timer = null;
  }

  setAlarm(at) {
    clearTimeout(this.timer);
    const wait = Math.max(0, at - Date.now());
    this.timer = setTimeout(() => {
      Promise.resolve(this.instance.object.alarm?.()).catch(() => {});
    }, wait);
    // A room can outlive the process it was created in only if the process
    // stays up; an alarm is not persisted here, which the README says.
    this.timer.unref?.();
  }

  async deleteAll() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const { name } of this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
      this.db.exec(`DROP TABLE IF EXISTS "${name}"`);
    }
  }
}

/**
 * The server end of a socket, with the methods the Worker code calls on it.
 * The real connection is attached later by the HTTP layer.
 */
class ServerSocket {
  constructor() {
    this.wire = null;
    this.attachment = null;
    this.queue = [];
  }

  attach(wire) {
    this.wire = wire;
    for (const message of this.queue) wire.send(message);
    this.queue = [];
  }

  send(message) {
    if (this.wire && this.wire.readyState === 1) this.wire.send(message);
    else if (!this.wire) this.queue.push(message);
  }

  close(code, reason) {
    try { this.wire?.close(code, reason); } catch { /* already gone */ }
  }

  serializeAttachment(value) {
    this.attachment = value;
  }

  deserializeAttachment() {
    return this.attachment;
  }
}

/** `ctx`: storage, the socket set, and the concurrency helper. */
class Ctx {
  constructor(instance, db) {
    this.storage = new Storage(instance, db);
    this.sockets = new Set();
    this.instance = instance;
  }

  // A Node process is already the single point Cloudflare's version exists to
  // provide, so there is nothing to block on.
  blockConcurrencyWhile(fn) {
    return Promise.resolve(fn());
  }

  acceptWebSocket(socket) {
    // The socket carries a way back to its object, so the HTTP layer can hand
    // incoming messages to webSocketMessage without searching for the owner.
    socket.owner = this;
    this.sockets.add(socket);
  }

  getWebSockets() {
    return [...this.sockets];
  }
}

/**
 * Status 101 with a socket attached is not something Node's Response accepts,
 * so the Worker's upgrade response is recognised and carried across. This is
 * the only global the adapter replaces, and it is replaced for the whole
 * process rather than per request, which is what a polyfill is.
 */
const NativeResponse = globalThis.Response;
class WorkerResponse extends NativeResponse {
  constructor(body, init = {}) {
    if (init && init.status === 101) {
      super(null, { status: 200 });
      this.isUpgrade = true;
      // Named webSocket, because that is what the Worker's router checks to
      // decide a response is a connection rather than a payload. Calling it
      // anything else made the router wrap it in a fresh Response and drop the
      // socket on the floor.
      this.webSocket = init.webSocket;
    } else {
      super(body, init);
    }
  }
}
globalThis.Response = WorkerResponse;

globalThis.WebSocketPair = function WebSocketPair() {
  const server = new ServerSocket();
  // The Worker hands index 0 back to the client and keeps index 1. Index 0 is
  // only ever a token here; the HTTP layer reads the server end off it.
  return [{ server }, server];
};

/**
 * One Durable Object namespace, backed by a Map. `idFromName` is the whole of
 * Cloudflare's global addressing; in one process it is a key.
 */
export class Namespace {
  constructor(ObjectClass, env) {
    this.ObjectClass = ObjectClass;
    this.env = env;
    this.instances = new Map();
  }

  idFromName(name) {
    return name;
  }

  get(id) {
    let instance = this.instances.get(id);
    if (!instance) {
      instance = {};
      const db = new DatabaseSync(':memory:');
      instance.ctx = new Ctx(instance, db);
      instance.object = new this.ObjectClass(instance.ctx, this.env);
      // Cloudflare accepts a URL string here and wraps it; the Worker's router
      // uses that form for the throttle object, so this has to as well.
      instance.fetch = (input, init) => instance.object.fetch(
        input instanceof Request ? input : new Request(input, init),
      );
      this.instances.set(id, instance);
    }
    return instance;
  }

  /** Every live instance, so the HTTP layer can route socket events. */
  all() {
    return [...this.instances.values()];
  }
}

export { ServerSocket };
