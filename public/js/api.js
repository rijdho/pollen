// Everything the browser sends. One origin, so there is no CORS, no preflight
// and no third-party host anywhere in the network panel.

const VOTER_KEY = 'pollen.voter';

/**
 * An opaque per-device token, generated in the browser and never sent anywhere
 * else. It exists so that a second answer replaces the first instead of
 * counting twice, and so a room can be told how many people are in it.
 *
 * It is not an identity and it is not a defence: someone determined to vote
 * twice can clear it. The README says so rather than implying otherwise.
 */
export function voterToken() {
  try {
    const found = sessionStorage.getItem(VOTER_KEY);
    if (found) return found;
  } catch { /* fall through to a per-page token */ }
  const token = crypto.randomUUID().replace(/-/g, '');
  try { sessionStorage.setItem(VOTER_KEY, token); } catch { /* nothing to do */ }
  return token;
}

async function call(path, { method = 'GET', body, key } = {}) {
  const headers = { 'x-pollen-voter': voterToken() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['x-pollen-key'] = key;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('offline', 0);
  }
  let data = {};
  try { data = await res.json(); } catch { /* an empty body is fine */ }
  if (!res.ok) throw new ApiError(data.error || 'internal', res.status, data);
  return data;
}

export class ApiError extends Error {
  constructor(code, status, data = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export const api = {
  createRoom: (questions, locale) => call('/api/rooms', { method: 'POST', body: { questions, locale } }),
  view: (code) => call(`/api/rooms/${code}`),
  vote: (code, idx, value) => call(`/api/rooms/${code}/vote`, { method: 'POST', body: { idx, value } }),
  state: (code, key) => call(`/api/rooms/${code}/state`, { key }),
  admin: (code, key, action, payload) => call(`/api/rooms/${code}/admin`, { method: 'POST', body: { action, payload }, key }),
  exportResults: (code, key) => call(`/api/rooms/${code}/export`, { key }),
  qaList: (code, idx) => call(`/api/rooms/${code}/qa?idx=${idx}`),
  results: (code, idx) => call(`/api/rooms/${code}/results?idx=${idx}`),
  upvote: (code, idx, id) => call(`/api/rooms/${code}/upvote`, { method: 'POST', body: { idx, id } }),
  setNick: (code, nick) => call(`/api/rooms/${code}/nick`, { method: 'POST', body: { nick } }),
};

/**
 * A socket that reopens itself. Venue wifi drops connections for sport, and a
 * projector that silently stops updating halfway through a session is worse
 * than one that never worked, because nobody notices.
 */
export function liveSocket(path, { onMessage, onStatus }) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let timer = null;

  function open() {
    if (closed) return;
    const url = new URL(path, location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      attempt = 0;
      onStatus?.('open');
    });
    ws.addEventListener('message', (event) => {
      try { onMessage(JSON.parse(event.data)); } catch { /* not ours */ }
    });
    ws.addEventListener('close', retry);
    ws.addEventListener('error', () => { try { ws.close(); } catch { /* already closing */ } });
  }

  function retry() {
    if (closed) return;
    onStatus?.('reconnecting');
    // Backs off to half a minute: a room of two hundred phones all retrying in
    // lockstep after an outage is its own denial of service.
    const wait = Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random());
    attempt += 1;
    timer = setTimeout(open, wait);
  }

  open();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already gone */ }
    },
  };
}
