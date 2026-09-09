import test from 'node:test';
import assert from 'node:assert/strict';

import { percentages, tallyChoice, tallyScale, tallyCloud, tallyRank, cloudWeight } from '../public/js/shared/aggregate.js?v=1';

test('percentages always sum to exactly 100', () => {
  // The case that makes naive rounding visible on a projector: three equal
  // shares round to 33 each and the total reads 99.
  assert.deepEqual(percentages([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(percentages([1, 1, 1, 1, 1, 1]), [17, 17, 17, 17, 16, 16]);
  assert.deepEqual(percentages([2, 1]), [67, 33]);
  assert.deepEqual(percentages([1, 1, 1, 1, 1, 1, 1]), [15, 15, 14, 14, 14, 14, 14]);
  assert.deepEqual(percentages([5]), [100]);
  assert.deepEqual(percentages([0, 0, 0]), [0, 0, 0]);
  for (const counts of [[1, 1, 1], [3, 3, 3, 1], [7, 11, 13], [1, 2, 3, 4, 5, 6, 7]]) {
    assert.equal(percentages(counts).reduce((a, b) => a + b, 0), 100);
  }
});

test('ties in the remainder go to the earlier option, so renders are stable', () => {
  assert.deepEqual(percentages([1, 1, 1]), percentages([1, 1, 1]));
  assert.deepEqual(percentages([1, 1, 1]), [34, 33, 33]);
});

test('multiple choice counts people and selections separately', () => {
  const t = tallyChoice([[0], [1], [0, 2]], 3);
  assert.deepEqual(t.counts, [2, 1, 1]);
  assert.deepEqual(t.percentages, [50, 25, 25]);
  assert.equal(t.voters, 3, 'three people answered');
  assert.equal(t.responses, 4, 'they made four selections between them');
});

test('multiple choice ignores indices that are not options', () => {
  const t = tallyChoice([[0], [9], [-1], [1.5], ['1']], 2);
  assert.deepEqual(t.counts, [1, 0]);
  assert.equal(t.responses, 1);
  assert.equal(t.voters, 5, 'a discarded selection is still a person in the room');
});

test('a rating scale reports an answer someone could have given', () => {
  const t = tallyScale([1, 2, 4, 5], 5);
  assert.deepEqual(t.histogram, [1, 1, 0, 1, 1]);
  assert.equal(t.n, 4);
  assert.equal(t.mean, 3);
  // The average of the two middle values would be 3, which nobody chose and
  // which is not a point on an ordinal scale.
  assert.equal(t.median, 2);
});

test('the scale mean is rounded to two decimals', () => {
  assert.equal(tallyScale([1, 2, 2], 5).mean, 1.67);
  assert.equal(tallyScale([1, 1, 1, 2], 5).mean, 1.25);
});

test('an empty scale reports nothing rather than zero', () => {
  const t = tallyScale([], 5);
  assert.equal(t.n, 0);
  assert.equal(t.mean, null, 'a mean of 0 would be a value outside the scale');
  assert.equal(t.median, null);
});

test('a scale discards answers outside its range', () => {
  const t = tallyScale([0, 1, 5, 6, 3.5, null], 5);
  assert.deepEqual(t.histogram, [1, 0, 0, 0, 1]);
  assert.equal(t.n, 2);
});

test('the cloud merges spellings and shows the commonest one', () => {
  const t = tallyCloud(['FAIR', 'fair', 'FAIR', 'Reuse', 'reuse,']);
  assert.deepEqual(t.items, [
    { key: 'fair', label: 'FAIR', count: 3 },
    { key: 'reuse', label: 'Reuse', count: 2 },
  ]);
  assert.equal(t.total, 5);
});

test('the cloud order does not depend on arrival order', () => {
  const a = tallyCloud(['one', 'two', 'two', 'three', 'three']);
  const b = tallyCloud(['three', 'two', 'three', 'two', 'one']);
  assert.deepEqual(a.items.map((i) => i.key), b.items.map((i) => i.key));
  assert.deepEqual(a.items.map((i) => i.key), ['three', 'two', 'one']);
});

test('the cloud drops entries that fold to nothing', () => {
  assert.deepEqual(tallyCloud(['...', '!!', '']).items, []);
});

test('cloud weights keep rare words readable', () => {
  // A linear weight would render a word said once out of twenty at 5 per cent
  // of the size of the commonest one, which is dust on a projector.
  assert.equal(cloudWeight(20, 20), 1);
  assert.ok(cloudWeight(1, 20) > 0.2, 'the rarest word stays legible');
  assert.equal(cloudWeight(1, 1), 1, 'a single word is not shrunk');
});

test('a ranking reports the average position each option was put in', () => {
  // Three people, three options. A is first twice and second once, so 1.33.
  const t = tallyRank([[0, 1, 2], [0, 2, 1], [1, 0, 2]], 3);
  assert.equal(t.n, 3);
  assert.deepEqual(t.rows, [
    { index: 0, firsts: 2, average: 1.33 },
    { index: 1, firsts: 1, average: 2 },
    { index: 2, firsts: 0, average: 2.67 },
  ]);
});

test('a ranking discards an incomplete ordering whole', () => {
  // Half an ordering is not a weaker opinion, it is a different one, and
  // counting it would silently weight the options someone did not reach.
  const t = tallyRank([[0, 1, 2], [0, 1], [0, 1, 1], [0, 1, 9]], 3);
  assert.equal(t.n, 1, 'only the complete ordering counts');
  assert.equal(t.rows[0].average, 1);
});

test('an empty ranking reports nothing rather than a position of zero', () => {
  const t = tallyRank([], 3);
  assert.equal(t.n, 0);
  assert.ok(t.rows.every((r) => r.average === null));
  assert.deepEqual(t.rows.map((r) => r.index), [0, 1, 2]);
});

test('two equally ranked options are ordered by first places, then stably', () => {
  // Both average 1.5; the one put first more often leads.
  const t = tallyRank([[0, 1], [1, 0]], 2);
  assert.equal(t.rows[0].average, 1.5);
  assert.equal(t.rows[1].average, 1.5);
  assert.deepEqual(tallyRank([[0, 1], [1, 0]], 2), tallyRank([[0, 1], [1, 0]], 2));
});
