// The one place that decides whether a string is an image this tool will
// carry. Imported by the Worker, by the browser and by the tests, so the rule
// the presenter's browser applies and the rule the boundary enforces cannot
// drift apart.
//
// An image on a question is authored by the presenter, not by the room, so the
// threat here is narrower than the one sanitize.js answers: whoever holds the
// admin key already controls what the room reads. What this file stops is a
// question that turns the projected page into something other than a page with
// a picture on it.
//
// Three things are refused and each is refused for its own reason:
//
//   - Anything that is not a data: URI. An https: source would be a request to
//     somebody else's server made by every phone in the room, which is the one
//     promise this tool makes on its front page. connect-src and img-src in
//     public/_headers already stop it in a browser; refusing it here means the
//     promise is kept at the point the question is written, not only at the
//     point it is displayed.
//   - Anything that is not JPEG, PNG or WebP. See LIMITS.image.types.
//   - Anything over the size cap, measured before it is decoded.

import { LIMITS } from './limits.js?v=2';

const PREFIX = /^data:([a-z]+\/[a-z0-9+.-]+);base64,/;

// Standard base64 only: no URL-safe alphabet, no whitespace, no line breaks.
// A permissive reading here would mean the string the Worker stored is not the
// string the checker measured.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Bytes a base64 payload decodes to, computed rather than decoded. Measuring
 * by decoding would mean allocating whatever was sent in order to find out it
 * was too big, which is the wrong order for a boundary.
 */
export function base64Bytes(payload) {
  if (payload.length % 4 !== 0) return -1;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return (payload.length / 4) * 3 - padding;
}

/**
 * A question's image, or null if the value is not one this tool will carry.
 * Returns the normalised data URI rather than a boolean, so the caller stores
 * exactly what was checked.
 */
export function readImage(value) {
  if (typeof value !== 'string') return null;
  const head = PREFIX.exec(value);
  if (!head) return null;
  const mime = head[1];
  if (!LIMITS.image.types.includes(mime)) return null;

  const payload = value.slice(head[0].length);
  if (payload === '' || !BASE64.test(payload)) return null;

  const bytes = base64Bytes(payload);
  if (bytes <= 0 || bytes > LIMITS.image.maxBytes) return null;

  return { mime, bytes, src: 'data:' + mime + ';base64,' + payload };
}
