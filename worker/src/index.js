// Router. Static assets are served by the platform without waking this script
// (navigation requests skip the Worker entirely from compatibility date
// 2025-04-01), so everything below is an API call and every one of them is
// billed. Keep it that way.

import { Room } from './room.js?v=1';
import { Throttle } from './throttle.js?v=1';
import { generateCode, normaliseCode } from '../../public/js/shared/codes.js?v=1';

export { Room, Throttle };

const API_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      // Only reachable when a non-navigation request misses every asset.
      return json({ error: 'not_found' }, 404);
    }
    try {
      return await route(request, env, url);
    } catch (err) {
      // Never echo the error: a stack trace from a storage layer is exactly
      // the kind of text that carries internals into a public response.
      console.error('unhandled', err && err.message);
      return json({ error: 'internal' }, 500);
    }
  },
};

async function route(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', ...]

  if (parts[1] !== 'rooms') return json({ error: 'not_found' }, 404);

  // POST /api/rooms  -> create
  if (parts.length === 2) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    return createRoom(request, env);
  }

  const code = normaliseCode(parts[2]);
  if (!code) return json({ error: 'bad_code' }, 400);
  const room = env.ROOM.get(env.ROOM.idFromName(code));
  const action = parts[3] || 'view';

  if (action === 'view' && request.method === 'GET') {
    return forward(room, 'view', { voter: voterOf(request) }, request);
  }
  if (action === 'vote' && request.method === 'POST') {
    const voter = voterOf(request);
    if (!voter) return json({ error: 'no_voter' }, 400);
    return forward(room, 'vote', { voter }, request);
  }
  if (action === 'upvote' && request.method === 'POST') {
    const voter = voterOf(request);
    if (!voter) return json({ error: 'no_voter' }, 400);
    return forward(room, 'upvote', { voter }, request);
  }
  if (action === 'nick' && request.method === 'POST') {
    const voter = voterOf(request);
    if (!voter) return json({ error: 'no_voter' }, 400);
    return forward(room, 'nick', { voter }, request);
  }
  if (action === 'results' && request.method === 'GET') {
    return forward(room, 'results', { idx: url.searchParams.get('idx') || '0' }, request);
  }
  if (action === 'qa' && request.method === 'GET') {
    return forward(room, 'qa', { voter: voterOf(request), idx: url.searchParams.get('idx') || '0' }, request);
  }
  if (action === 'follow') {
    // No key: a follower socket carries only the current question, which is
    // exactly what anyone holding the code is entitled to see.
    return forward(room, 'follow', {}, request);
  }
  if (action === 'live') {
    return forward(room, 'live', { key: keyOf(request, url) }, request);
  }
  if (action === 'state' && request.method === 'GET') {
    return forward(room, 'state', { key: keyOf(request, url) }, request);
  }
  if (action === 'export' && request.method === 'GET') {
    return forward(room, 'export', { key: keyOf(request, url) }, request);
  }
  if (action === 'admin' && request.method === 'POST') {
    return forward(room, 'admin', { key: keyOf(request, url) }, request);
  }
  return json({ error: 'not_found' }, 404);
}

async function createRoom(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_body' }, 400);
  }
  if (!Array.isArray(body.questions) || body.questions.length === 0) {
    return json({ error: 'no_questions' }, 400);
  }

  const allowed = await throttle(request, env, 'check');
  if (!allowed.ok) {
    return json({ error: 'too_many_rooms', retryAfter: allowed.retryAfter }, 429);
  }

  // Collisions are resolved by the object store, not by a lookup table: the
  // room object refuses a second claim on the same name, so two simultaneous
  // creations can never share a code.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateCode();
    const room = env.ROOM.get(env.ROOM.idFromName(code));
    const res = await room.fetch(new Request('https://room/?op=create', {
      method: 'POST',
      body: JSON.stringify({ code, questions: body.questions, locale: body.locale }),
    }));
    // Only a taken code is worth another try. Anything else is the caller's
    // answer, including 422 for questions that cannot be used.
    if (res.status === 409) continue;
    // Charged only now, for a room that exists. A collision or a rejected set
    // of questions costs the caller nothing.
    if (res.ok) await throttle(request, env, 'spend');
    return withHeaders(res);
  }
  return json({ error: 'no_code' }, 503);
}

async function throttle(request, env, op) {
  const address = request.headers.get('cf-connecting-ip') || '';
  if (address === '') return { ok: true };
  // The address is never stored: the object's name is a truncated hash of it,
  // and the object holds a count and a timestamp.
  const name = 'ip:' + (await sha256Hex(address)).slice(0, 32);
  const stub = env.THROTTLE.get(env.THROTTLE.idFromName(name));
  const res = await stub.fetch(`https://throttle/?op=${op}`);
  return res.json();
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The participant's opaque, client-generated token. Not an identity. */
function voterOf(request) {
  const raw = request.headers.get('x-pollen-voter') || '';
  return /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : '';
}

function keyOf(request, url) {
  // Header for fetches, query string for the WebSocket, which cannot carry
  // custom headers from a browser.
  return request.headers.get('x-pollen-key') || url.searchParams.get('k') || '';
}

async function forward(room, op, params, request) {
  const target = new URL('https://room/');
  target.searchParams.set('op', op);
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  // The original request is the init on purpose: rebuilding one by hand drops
  // the Upgrade header and the WebSocket handshake silently becomes a 426.
  const res = await room.fetch(new Request(target.toString(), request));
  return res.webSocket ? res : withHeaders(res);
}

function withHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(API_HEADERS)) out.headers.set(k, v);
  return out;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: API_HEADERS });
}
