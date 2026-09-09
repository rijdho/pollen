// The presenter's rooms live on the presenter's device and nowhere else.
// The admin key is what proves you opened a room; the server keeps only its
// own copy to compare against, and there is no account to recover it from.
// Clear this browser's storage and the room is unreachable, which is the
// honest cost of having no accounts.

const KEY = 'pollen.rooms';

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(rooms) {
  try { localStorage.setItem(KEY, JSON.stringify(rooms.slice(0, 10))); } catch { /* nothing to do */ }
}

export function remember(code, adminKey, expiresAt) {
  const rooms = read().filter((r) => r.code !== code);
  rooms.unshift({ code, adminKey, expiresAt });
  write(rooms);
}

export function forget(code) {
  write(read().filter((r) => r.code !== code));
}

/** Rooms this device opened that have not expired yet. */
export function myRooms(now = Date.now()) {
  const live = read().filter((r) => !r.expiresAt || r.expiresAt > now);
  if (live.length !== read().length) write(live);
  return live;
}

export function keyFor(code) {
  return myRooms().find((r) => r.code === code)?.adminKey || null;
}
