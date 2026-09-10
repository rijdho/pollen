// Turning a file the presenter picked into an image small enough to carry.
// Browser only: it needs a canvas, which is why it is not in shared/.
//
// The cap in LIMITS.image is a promise about what leaves this machine, not a
// hurdle put in front of the person using it. A photo off a phone is four
// megabytes and there is nothing wrong with it; the work of getting it under a
// hundred kilobytes belongs here, not in a message telling someone to go and
// find an image editor.
//
// So the file is rescaled once and then re-encoded at falling quality until it
// fits. Only when the lowest quality still will not fit does this give up, and
// it says why: that case is a slide full of small text, where going lower
// would hand back something illegible rather than something large.

import { LIMITS } from './shared/limits.js?v=2';
import { readImage } from './shared/image.js?v=2';

// Tried in order. The first is where an ordinary photograph lands; the last is
// the floor, below which text stops being readable at the back of a room.
const QUALITIES = [0.82, 0.72, 0.62, 0.5];

/**
 * @returns {Promise<{ok: true, src: string, bytes: number}
 *                 | {ok: false, reason: 'type'|'broken'|'detail'}>}
 */
export async function imageFromFile(file) {
  if (!file || !String(file.type || '').startsWith('image/')) return { ok: false, reason: 'type' };

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // A file that claims to be an image and does not decode. Nothing to do
    // with it, and nothing to gain from guessing what it was meant to be.
    return { ok: false, reason: 'broken' };
  }

  try {
    // One rescale, then quality does the rest. Rescaling repeatedly to reach
    // the cap would trade away the resolution the projector actually uses,
    // where quality trades away detail nobody is reading at fifteen metres.
    const canvas = fit(bitmap, LIMITS.image.maxSide);
    for (const quality of QUALITIES) {
      const src = await encode(canvas, quality);
      const image = src && readImage(src);
      if (image) return { ok: true, src: image.src, bytes: image.bytes };
    }
    return { ok: false, reason: 'detail' };
  } finally {
    bitmap.close?.();
  }
}

/** Draw the bitmap onto a canvas no larger than `side` on its longest edge. */
function fit(bitmap, side) {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  // White underneath, because a PNG with transparency encoded as JPEG turns
  // its transparent parts black, and a diagram exported with no background is
  // exactly the kind of file that gets attached to a question.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Encode at one quality, preferring WebP. It is smaller than JPEG at the same
 * quality, so the same cap buys a better picture. A browser that cannot write
 * it hands back a PNG instead of refusing, which is why the type is checked
 * rather than the call: an unnoticed PNG would blow the cap at every quality
 * and read as "too detailed" when nothing was wrong with the image.
 */
async function encode(canvas, quality) {
  for (const mime of ['image/webp', 'image/jpeg']) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
    if (blob && blob.type === mime) return await toDataUrl(blob);
  }
  return null;
}

function toDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}
