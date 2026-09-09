// Saved question sets. This is what stands in for an account: the presenter's
// work lives on their device and in a file they own, so preparing a session
// once does not mean retyping it the next time.
//
// Nothing here ever reaches the server. A set is only sent when a room is
// opened from it, and then only as the questions themselves.

import { LIMITS } from './shared/limits.js?v=1';

const KEY = 'pollen.decks';
const FORMAT = 'pollen.deck/1';

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(decks) {
  try { localStorage.setItem(KEY, JSON.stringify(decks.slice(0, 30))); } catch { /* storage off */ }
}

export function allDecks() {
  return read();
}

export function saveDeck(name, questions) {
  const clean = String(name || '').trim().slice(0, 60) || new Date().toISOString().slice(0, 10);
  const decks = read().filter((d) => d.name !== clean);
  decks.unshift({ name: clean, savedAt: Date.now(), questions });
  write(decks);
  return clean;
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
