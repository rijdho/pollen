// Placing words so they read as a cloud rather than a list.
//
// Two properties matter more than prettiness here. The layout must be
// DETERMINISTIC, because the projected screen redraws on every single vote and
// a cloud that reshuffles itself each time is unreadable and faintly seasick.
// And it must never overlap, because two words on top of each other are not a
// design flourish, they are a word nobody in the room can read.
//
// Measurement is injected so this file has no DOM and can be tested: the
// browser passes a canvas measurer, the tests pass a predictable one.

/** A small deterministic hash, so a word always lands the same way. */
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

function overlaps(a, b, pad) {
  return !(a.x + a.w / 2 + pad < b.x - b.w / 2
    || a.x - a.w / 2 - pad > b.x + b.w / 2
    || a.y + a.h / 2 + pad < b.y - b.h / 2
    || a.y - a.h / 2 - pad > b.y + b.h / 2);
}

/**
 * @param {{key: string, label: string, count: number}[]} words  commonest first
 * @param {object} opts
 * @param {number} opts.width      box to fill, in the same units as the result
 * @param {number} opts.height
 * @param {(text: string, size: number) => {w: number, h: number}} opts.measure
 * @param {number} [opts.minSize]  font size of the rarest word
 * @param {number} [opts.maxSize]  font size of the commonest
 * @param {number} [opts.rotateEvery] one word in this many is set vertically;
 *   0 keeps everything horizontal, which is easier to read from the back of a
 *   room and is what a projector usually wants.
 * @returns {{placed: object[], dropped: string[]}}
 */
export function layoutCloud(words, {
  width, height, measure, minSize = 16, maxSize = 96, rotateEvery = 4, pad = 3,
}) {
  const placed = [];
  const dropped = [];
  if (words.length === 0) return { placed, dropped };

  const max = words[0].count;
  const min = words[words.length - 1].count;
  const span = Math.max(1, max - min);

  for (const word of words) {
    // Square root, not linear: one word said twenty times in a room of twenty
    // otherwise renders every other word as unreadable dust.
    const weight = Math.sqrt((word.count - min) / span);
    const size = Math.round(minSize + weight * (maxSize - minSize));
    const rotate = rotateEvery > 0 && hash(word.key) % rotateEvery === 0 ? -90 : 0;
    const box = measure(word.label, size);
    const w = rotate ? box.h : box.w;
    const h = rotate ? box.w : box.h;

    if (w > width || h > height) {
      dropped.push(word.key);
      continue;
    }

    // An Archimedean spiral out from the centre, stretched to the box so a wide
    // screen fills sideways rather than leaving two empty columns.
    const aspect = width / height;
    const start = (hash(word.key + ':t') % 628) / 100; // a stable starting angle
    let found = null;
    for (let step = 0; step < 4000; step += 1) {
      const t = start + step * 0.18;
      const radius = 0.9 * step * 0.18;
      const x = width / 2 + radius * Math.cos(t) * aspect;
      const y = height / 2 + radius * Math.sin(t);
      if (x - w / 2 < 0 || x + w / 2 > width || y - h / 2 < 0 || y + h / 2 > height) continue;
      const candidate = { x, y, w, h };
      if (placed.every((other) => !overlaps(candidate, other, pad))) {
        found = candidate;
        break;
      }
    }

    if (!found) {
      // Better a word missing than a word illegible under another one. The
      // caller is told, so it can say so rather than silently losing answers.
      dropped.push(word.key);
      continue;
    }
    placed.push({ ...found, key: word.key, label: word.label, count: word.count, size, rotate });
  }

  return { placed, dropped };
}
