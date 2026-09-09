// Anything a participant types may end up two metres tall on a projector in
// front of a room full of people. That is the threat model this file answers.
//
// The character classes are built from code points rather than written as
// literals on purpose: every character removed here is invisible, so a literal
// in the source would be a line nobody could review.

/** Build a character class from [start, end] code point pairs. */
function charClass(ranges, flags = 'g') {
  const hex = (n) => '\\u' + n.toString(16).padStart(4, '0');
  const body = ranges.map(([a, b]) => (a === b ? hex(a) : hex(a) + '-' + hex(b))).join('');
  return new RegExp('[' + body + ']', flags);
}

// Bidirectional controls reorder what is *displayed* without changing the
// string, so a moderator can approve one thing and the room can read another.
// Stripped, not escaped.
const BIDI = charClass([
  [0x061c, 0x061c], // ARABIC LETTER MARK
  [0x200e, 0x200f], // LEFT-TO-RIGHT / RIGHT-TO-LEFT MARK
  [0x202a, 0x202e], // LRE, RLE, PDF, LRO, RLO
  [0x2066, 0x2069], // LRI, RLI, FSI, PDI
]);

// Zero-width characters make two entries look identical while counting as two.
const INVISIBLE = charClass([
  [0x00ad, 0x00ad], // SOFT HYPHEN
  [0x200b, 0x200d], // ZERO WIDTH SPACE / NON-JOINER / JOINER
  [0x2060, 0x2060], // WORD JOINER
  [0xfeff, 0xfeff], // ZERO WIDTH NO-BREAK SPACE
]);

// C0 and C1 controls, tab and newline included: an entry is one line.
const CONTROL = charClass([
  [0x0000, 0x001f],
  [0x007f, 0x009f],
]);

// Combining marks stacked without limit ("zalgo") overflow the row they sit in.
const COMBINING = /\p{Mn}/u;

/**
 * Fold a raw entry into something safe to store and to project.
 * Truncation counts code points, so an emoji is one character and never gets
 * cut in half into a lone surrogate.
 */
export function sanitiseText(raw, maxChars) {
  if (typeof raw !== 'string') return '';
  let s = raw.normalize('NFC')
    .replace(BIDI, '')
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = limitCombining(s, 2);
  const points = Array.from(s);
  if (points.length > maxChars) s = points.slice(0, maxChars).join('').trim();
  return s;
}

/** At most `max` combining marks in a row; the rest are dropped. */
function limitCombining(s, max) {
  let run = 0;
  let out = '';
  for (const ch of s) {
    if (COMBINING.test(ch)) {
      run += 1;
      if (run > max) continue;
    } else {
      run = 0;
    }
    out += ch;
  }
  return out;
}

/**
 * The key two word-cloud entries are merged on. Case and edge punctuation are
 * folded so that "Reuse", "reuse" and "reuse," land in one bubble; accents are
 * NOT folded, because in Spanish "año" and "ano" are different words and the
 * difference is exactly the kind that gets laughed at on a projector.
 */
export function cloudKey(text) {
  return text
    .toLocaleLowerCase('en')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
}

/** Whitespace-separated words, used to enforce the cloud entry cap. */
export function wordCount(text) {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}
