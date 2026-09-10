import test from 'node:test';
import assert from 'node:assert/strict';

import { layoutCloud } from '../public/js/shared/cloudlayout.js?v=2';

// A predictable measurer, so these tests are about the placement and not about
// how one font happens to render.
const measure = (text, size) => ({ w: text.length * size * 0.55, h: size * 0.78 });

const WORDS = [
  { key: 'access', label: 'Access', count: 9 },
  { key: 'reuse', label: 'Reuse', count: 7 },
  { key: 'transparency', label: 'Transparency', count: 5 },
  { key: 'rigour', label: 'Rigour', count: 3 },
  { key: 'funding', label: 'Funding', count: 2 },
  { key: 'trust', label: 'Trust', count: 1 },
];

const BOX = { width: 1000, height: 420, measure };

function boxesOverlap(a, b) {
  return Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;
}

test('no two words are ever drawn on top of each other', () => {
  const { placed } = layoutCloud(WORDS, BOX);
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      assert.ok(!boxesOverlap(placed[i], placed[j]),
        `${placed[i].label} overlaps ${placed[j].label}`);
    }
  }
});

test('the same words always land in the same places', () => {
  // The projected screen redraws on every vote. A layout that moved each time
  // would make the cloud unreadable however pretty each frame was.
  const a = layoutCloud(WORDS, BOX);
  const b = layoutCloud(WORDS, BOX);
  assert.deepEqual(a, b);
});

test('one more vote for one word does not rearrange the rest', () => {
  const before = layoutCloud(WORDS, BOX).placed;
  const after = layoutCloud(
    WORDS.map((w) => (w.key === 'rigour' ? { ...w, count: 4 } : w)), BOX).placed;
  const moved = before.filter((w) => {
    const now = after.find((x) => x.key === w.key);
    return !now || Math.abs(now.x - w.x) > 1 || Math.abs(now.y - w.y) > 1;
  });
  // The word that changed may move, and so may whatever it now sits next to,
  // but the cloud must not reshuffle wholesale.
  assert.ok(moved.length <= 2, `${moved.length} words moved: ${moved.map((w) => w.label)}`);
});

test('everything stays inside the box it was given', () => {
  const { placed } = layoutCloud(WORDS, BOX);
  for (const word of placed) {
    assert.ok(word.x - word.w / 2 >= 0, `${word.label} runs off the left`);
    assert.ok(word.x + word.w / 2 <= BOX.width, `${word.label} runs off the right`);
    assert.ok(word.y - word.h / 2 >= 0, `${word.label} runs off the top`);
    assert.ok(word.y + word.h / 2 <= BOX.height, `${word.label} runs off the bottom`);
  }
});

test('the commonest word is the largest', () => {
  const { placed } = layoutCloud(WORDS, BOX);
  const sizes = placed.map((w) => w.size);
  assert.equal(sizes[0], Math.max(...sizes));
  assert.ok(sizes[0] > sizes[sizes.length - 1]);
});

test('a word too big for the box is reported, not drawn off screen', () => {
  const { placed, dropped } = layoutCloud(
    [{ key: 'x', label: 'antidisestablishmentarianism', count: 5 }],
    { width: 80, height: 40, measure },
  );
  assert.equal(placed.length, 0);
  assert.deepEqual(dropped, ['x']);
});

test('a full box drops the words that will not fit rather than piling them up', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    key: 'word' + i, label: 'wordwordword' + i, count: 60 - i,
  }));
  const { placed, dropped } = layoutCloud(many, { width: 300, height: 160, measure });
  assert.ok(dropped.length > 0, 'this box cannot hold sixty words');
  assert.ok(placed.length > 0, 'but it holds some');
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      assert.ok(!boxesOverlap(placed[i], placed[j]), 'and never by overlapping them');
    }
  }
});

test('rotation is deterministic and proportionate', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ key: 'k' + i, label: 'w' + i, count: 40 - i }));
  const first = layoutCloud(many, { width: 1200, height: 600, measure });
  const second = layoutCloud(many, { width: 1200, height: 600, measure });
  assert.deepEqual(first.placed.map((w) => w.rotate), second.placed.map((w) => w.rotate));
  const turned = first.placed.filter((w) => w.rotate !== 0).length;
  assert.ok(turned > 0, 'some words are set vertically');
  assert.ok(turned < first.placed.length / 2, 'but a cloud read sideways is not a cloud');
});

test('rotation can be switched off entirely', () => {
  const { placed } = layoutCloud(WORDS, { ...BOX, rotateEvery: 0 });
  assert.ok(placed.every((w) => w.rotate === 0));
});

test('an empty question lays out nothing rather than failing', () => {
  assert.deepEqual(layoutCloud([], BOX), { placed: [], dropped: [] });
});
