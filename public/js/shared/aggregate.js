// Turning raw votes into what the projector shows. Pure functions with no
// storage and no DOM, so the Worker, the browser and the tests all run the
// same code and the numbers on screen are the numbers under test.

import { cloudKey } from './sanitize.js?v=1';

/**
 * Whole percentages that sum to exactly 100, by largest remainder.
 *
 * Rounding each share independently is the obvious approach and it is wrong:
 * three equal shares round to 33/33/33 and the projected total reads 99, which
 * someone in the room always notices. Largest remainder hands the leftover
 * points to the shares that lost the most in rounding.
 *
 * Ties go to the lower index, so the order of the options decides and the
 * result is stable between renders. With no votes every share is 0.
 */
export function percentages(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 0);
  const exact = counts.map((c) => (c * 100) / total);
  const floors = exact.map(Math.floor);
  let remaining = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, i) => ({ i, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  const out = floors.slice();
  for (let k = 0; k < order.length && remaining > 0; k += 1) {
    out[order[k].i] += 1;
    remaining -= 1;
  }
  return out;
}

/**
 * Multiple choice. `votes` are arrays of option indices, so the same shape
 * carries single and multiple selection.
 *
 * `voters` counts people and `responses` counts selections; with multiple
 * selection allowed the two differ, and percentages are of responses, which is
 * the only reading under which the bars add up.
 */
export function tallyChoice(votes, optionCount) {
  const counts = new Array(optionCount).fill(0);
  let responses = 0;
  for (const picks of votes) {
    for (const idx of picks) {
      if (Number.isInteger(idx) && idx >= 0 && idx < optionCount) {
        counts[idx] += 1;
        responses += 1;
      }
    }
  }
  return { counts, percentages: percentages(counts), voters: votes.length, responses };
}

/**
 * Rating scale over steps 1..steps.
 *
 * Mean is rounded to two decimals for display; median is the lower of the two
 * middle values on an even count, rather than their average, because a scale
 * is ordinal and 3.5 is not one of the answers anyone could give.
 */
export function tallyScale(votes, steps) {
  const valid = votes.filter((v) => Number.isInteger(v) && v >= 1 && v <= steps);
  const histogram = new Array(steps).fill(0);
  for (const v of valid) histogram[v - 1] += 1;
  if (valid.length === 0) {
    return { histogram, n: 0, mean: null, median: null };
  }
  const sum = valid.reduce((a, b) => a + b, 0);
  const sorted = valid.slice().sort((a, b) => a - b);
  return {
    histogram,
    n: valid.length,
    mean: Math.round((sum / valid.length) * 100) / 100,
    median: sorted[Math.floor((sorted.length - 1) / 2)],
  };
}

/**
 * Word cloud. Entries merge on their folded key; the label shown is the
 * spelling the most people actually typed, with ties broken by first arrival,
 * so a room that writes "FAIR" eleven times and "fair" once sees "FAIR".
 *
 * Sorted by count then by key, never by insertion, so two clients rendering
 * the same data draw the same cloud.
 */
export function tallyCloud(entries) {
  const groups = new Map();
  for (const raw of entries) {
    const key = cloudKey(raw);
    if (key === '') continue;
    let g = groups.get(key);
    if (!g) {
      g = { key, count: 0, spellings: new Map() };
      groups.set(key, g);
    }
    g.count += 1;
    g.spellings.set(raw, (g.spellings.get(raw) || 0) + 1);
  }
  const items = [];
  for (const g of groups.values()) {
    let label = null;
    let best = -1;
    for (const [spelling, n] of g.spellings) {
      if (n > best) {
        best = n;
        label = spelling;
      }
    }
    items.push({ key: g.key, label, count: g.count });
  }
  items.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { items, total: items.reduce((a, b) => a + b.count, 0) };
}

/**
 * Ranking. Each vote is a full ordering of the options, so the result is the
 * average position each one was put in: lower is better, and 1.0 would mean
 * every single person put it first.
 *
 * Ties break on the number of first places and then on the option's own order,
 * so the board is stable between renders rather than swapping two equal rows
 * every time a vote lands.
 *
 * Incomplete or malformed orderings are discarded whole rather than partially
 * counted: half an ordering is not a weaker opinion, it is a different one.
 */
export function tallyRank(votes, optionCount) {
  const sums = new Array(optionCount).fill(0);
  const firsts = new Array(optionCount).fill(0);
  let n = 0;

  for (const order of votes) {
    if (!Array.isArray(order) || order.length !== optionCount) continue;
    const seen = new Set(order.filter((i) => Number.isInteger(i) && i >= 0 && i < optionCount));
    if (seen.size !== optionCount) continue;
    order.forEach((option, position) => {
      sums[option] += position + 1;
      if (position === 0) firsts[option] += 1;
    });
    n += 1;
  }

  const rows = sums.map((sum, index) => ({
    index,
    firsts: firsts[index],
    average: n === 0 ? null : Math.round((sum / n) * 100) / 100,
  }));
  rows.sort((a, b) => {
    if (a.average === null || b.average === null) return a.index - b.index;
    return a.average - b.average || b.firsts - a.firsts || a.index - b.index;
  });
  return { rows, n };
}

/**
 * Font weight for a cloud entry, as a 0..1 position between the rarest and the
 * commonest word. Square root, not linear: one word said twenty times in a
 * room of twenty otherwise renders every other word as unreadable dust.
 */
export function cloudWeight(count, maxCount) {
  if (maxCount <= 1) return 1;
  return Math.sqrt(count / maxCount);
}
