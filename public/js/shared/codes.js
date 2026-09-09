// Room codes are read off a projector at the back of a room and typed on a
// phone, so the alphabet matters more than the entropy.
//
// Excluded: 0/O, 1/I/L (shape collisions) and every vowel, so a random six
// characters cannot spell something unfortunate on a lecture-hall wall.
// 28 characters, six positions: 4.8e8 codes, and collisions are checked
// against the object store anyway.
export const CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ';

const CODE_LENGTH = 6;

/**
 * Cryptographically uniform code. Rejection sampling, because 256 % 28 != 0
 * and a modulo bias would quietly favour the first characters of the alphabet.
 */
export function generateCode(cryptoImpl = globalThis.crypto) {
  const n = CODE_ALPHABET.length;
  const limit = 256 - (256 % n); // 252
  let out = '';
  while (out.length < CODE_LENGTH) {
    const bytes = new Uint8Array(CODE_LENGTH * 2);
    cryptoImpl.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= limit) continue;
      out += CODE_ALPHABET[b % n];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

/**
 * What the participant typed, turned into a code, or null.
 *
 * Case and separators are folded because those are unambiguous. Character
 * confusions are NOT folded: O and 0 are both absent from the alphabet, so a
 * typed "O" could have been a misread D or Q, and guessing which would send
 * someone into a stranger's room. Better to reject and let them look again.
 */
export function normaliseCode(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.toUpperCase().replace(/[\s\-_.]/g, '');
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}

export function isCode(value) {
  return normaliseCode(value) === value;
}
