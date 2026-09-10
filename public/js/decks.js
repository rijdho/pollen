// Saved question sets. This is what stands in for an account: the presenter's
// work lives on their device and in a file they own, so preparing a session
// once does not mean retyping it the next time.
//
// Nothing here ever reaches the server. A set is only sent when a room is
// opened from it, and then only as the questions themselves.

import { LIMITS } from './shared/limits.js?v=2';

const KEY = 'pollen.decks';
const FORMAT = 'pollen.deck/1';

// What this may occupy in the browser's store. The quota is per origin and
// browsers put it at about five megabytes, so this leaves room for the rest of
// what the tool keeps there.
//
// The number matters now in a way it never did before. A set of twenty text
// questions is a few kilobytes; the same set with a picture on every question
// is nearly three megabytes, because a hundred-kilobyte image is a third
// larger again as base64. Two sets like that do not fit, and the browser's
// answer to that is an exception thrown at the moment of writing.
//
// This used to be caught and dropped on the floor. The presenter saw "saved on
// this device", closed the tab, and found the set gone the following week.
// Nothing here is allowed to fail quietly any more: write() reports which of
// the two things went wrong, and the editor says so.
const MAX_STORED = 4 * 1024 * 1024;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** @returns {'saved'|'full'|'off'} */
function write(decks) {
  const payload = JSON.stringify(decks.slice(0, 30));
  // Checked before the write as well as after, because a browser is entitled
  // to a smaller quota than the one this assumes and because failing on our
  // own number gives a message that names a cause.
  if (payload.length > MAX_STORED) return 'full';
  try {
    localStorage.setItem(KEY, payload);
    return 'saved';
  } catch (err) {
    // Storage switched off (a private window, or blocked site data) is a
    // different problem from a store that is full, and the remedy differs:
    // one is "export the set to a file", the other is "this browser will not
    // keep anything". Conflating them was half of why the old catch was
    // useless.
    const name = err?.name || '';
    return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' ? 'full' : 'off';
  }
}

export function allDecks() {
  return read();
}

/** @returns {{status: 'saved'|'full'|'off', name: string}} */
export function saveDeck(name, questions) {
  const clean = String(name || '').trim().slice(0, 60) || new Date().toISOString().slice(0, 10);
  const decks = read().filter((d) => d.name !== clean);
  decks.unshift({ name: clean, savedAt: Date.now(), questions });
  return { status: write(decks), name: clean };
}

export function deleteDeck(name) {
  write(read().filter((d) => d.name !== name));
}

/** The file a presenter carries between machines, or keeps as a backup. */
export function deckFile(deck) {
  return JSON.stringify({
    format: FORMAT,
    name: deck.name,
    savedAt: deck.savedAt,
    questions: deck.questions,
  }, null, 2);
}

/**
 * Reads a file back. Deliberately strict about the envelope and deliberately
 * forgiving about the contents: the server re-checks every question anyway, so
 * the only job here is to refuse something that is not a set at all rather
 * than to re-implement the rules in a second place.
 */
export function parseDeckFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || data.format !== FORMAT) return null;
  if (!Array.isArray(data.questions) || data.questions.length === 0) return null;
  const questions = data.questions
    .filter((q) => q && typeof q.type === 'string' && typeof q.prompt === 'string')
    .slice(0, LIMITS.room.maxQuestions);
  if (questions.length === 0) return null;
  return {
    name: String(data.name || '').trim().slice(0, 60) || 'imported',
    savedAt: Date.now(),
    questions,
  };
}

/** Hands the browser a file to save. */
export function downloadDeck(deck) {
  const blob = new Blob([deckFile(deck)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pollen-${deck.name.replace(/[^\w-]+/g, '-').toLowerCase()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
