import test from 'node:test';
import assert from 'node:assert/strict';

// decks.js talks to localStorage, which Node does not have. The stub is not a
// convenience: it is the only way to reach the two failures this file exists
// for, because a real browser reaches them only when its quota is genuinely
// full, which is exactly why they went unnoticed for so long.
function useStorage(behaviour = {}) {
  let store = '';
  globalThis.localStorage = {
    getItem: () => (behaviour.readThrows ? (() => { throw new Error('blocked'); })() : store),
    setItem: (_k, value) => {
      if (behaviour.throwOnSet) throw behaviour.throwOnSet;
      store = value;
    },
    removeItem: () => { store = ''; },
  };
  return () => store;
}

const { saveDeck, allDecks } = await import('../public/js/decks.js?v=2');

function question(imageBytes = 0) {
  return {
    type: 'choice', prompt: 'Which one?', options: ['a', 'b'], correct: [], seconds: 0,
    image: imageBytes ? { src: 'data:image/webp;base64,' + 'A'.repeat(imageBytes), alt: '' } : undefined,
  };
}

function quotaError() {
  const err = new Error('exceeded the quota');
  err.name = 'QuotaExceededError';
  return err;
}

test('an ordinary set is saved and says so', () => {
  const read = useStorage();
  const result = saveDeck('Week one', [question()]);
  assert.equal(result.status, 'saved');
  assert.equal(result.name, 'Week one');
  assert.ok(read().includes('Which one?'), 'it actually reached the store');
  assert.equal(allDecks().length, 1);
});

test('a set too large for the store is refused, and never reported as saved', () => {
  // This is the whole point of the file. Before question images existed, a set
  // was a few kilobytes and this branch was unreachable; a hundred-kilobyte
  // picture on each of twenty questions is nearly three megabytes, and two
  // such sets do not fit in a browser's five-megabyte origin quota.
  useStorage();
  const huge = Array.from({ length: 4 }, () => question(1_200_000));
  const result = saveDeck('Everything', huge);
  assert.equal(result.status, 'full');
  assert.notEqual(result.status, 'saved', 'the presenter must not be told it was kept');
});

test('the browser refusing the write is reported, not swallowed', () => {
  useStorage({ throwOnSet: quotaError() });
  assert.equal(saveDeck('Week two', [question()]).status, 'full');
});

test('storage switched off is a different answer from storage full', () => {
  // The remedies differ: one is "export a set to a file and delete it here",
  // the other is "this browser will keep nothing at all". A single message for
  // both sends half the people who see it to do the wrong thing.
  useStorage({ throwOnSet: new Error('SecurityError: access denied') });
  assert.equal(saveDeck('Week three', [question()]).status, 'off');
});

test('a store that cannot even be read does not throw on the way past', () => {
  useStorage({ readThrows: true });
  assert.equal(allDecks().length, 0);
  assert.ok(['saved', 'full', 'off'].includes(saveDeck('x', [question()]).status));
});

test('every status the editor branches on is one saveDeck can return', () => {
  // The editor builds its message key as 'editor.setFailed_' + status. A
  // status this test does not know about would render as a missing key on a
  // projector, so the set is pinned here rather than left implicit.
  const statuses = new Set();
  useStorage();
  statuses.add(saveDeck('a', [question()]).status);
  useStorage({ throwOnSet: quotaError() });
  statuses.add(saveDeck('b', [question()]).status);
  useStorage({ throwOnSet: new Error('nope') });
  statuses.add(saveDeck('c', [question()]).status);
  assert.deepEqual([...statuses].sort(), ['full', 'off', 'saved']);
});
