// Browser only: it draws on a canvas, which is why it is not in shared/.
//
// The picture is the cloud that is on the wall, not a second rendering of the
// same answers. It is handed the words the projected screen has already laid
// out, with the position, size, weight and opacity each one is drawn at, so
// the file somebody puts in a slide cannot disagree with what the room read.
// Laying it out again here would be a second home for the same decision, and
// the copy nobody looks at is the one that drifts.

/**
 * @param {object} opts
 * @param {{label: string, x: number, y: number, size: number, rotate: number,
 *          fontWeight: number, alpha: number}[]} opts.words
 * @param {{x: number, y: number, w: number, h: number}} opts.view
 *   the cropped box the screen draws, in the same units as the words
 * @param {string} opts.font        the family stack, as the page resolves it
 * @param {string} opts.color       the colour the words are drawn in
 * @param {string} opts.background  filled first, so the file is not transparent
 * @param {string} [opts.footer]    the line about words that did not fit
 * @param {string} [opts.footerColor]
 * @param {number} [opts.scale]     2 by default: a wall's cloud lands in a slide
 * @returns {Promise<Blob|null>}    null only if the browser refuses to encode
 */
export function cloudPng({
  words, view, font, color, background,
  footer = '', footerColor = color, scale = 2,
}) {
  // Room for the line under the cloud, in layout units. The projected screen
  // says how many answers did not fit; a picture that dropped the sentence
  // would be a picture that quietly claims to be the whole room.
  const strip = footer ? 40 : 0;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(view.w * scale));
  canvas.height = Math.max(1, Math.round((view.h + strip) * scale));

  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, view.w, view.h + strip);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  for (const word of words) {
    ctx.save();
    ctx.translate(word.x - view.x, word.y - view.y);
    if (word.rotate) ctx.rotate((word.rotate * Math.PI) / 180);
    ctx.font = `${word.fontWeight} ${word.size}px ${font}`;
    ctx.globalAlpha = word.alpha;
    ctx.fillText(word.label, 0, 0);
    ctx.restore();
  }

  if (footer) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = footerColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // The box is only as wide as the words happened to need, and the sentence
    // is in whichever language the room is in. Shrink it to fit rather than
    // let it run past the edge: a line cut in half says less than a small one.
    const room = Math.max(1, view.w - 8);
    let size = 22;
    ctx.font = `400 ${size}px ${font}`;
    const wanted = ctx.measureText(footer).width;
    if (wanted > room) {
      size = Math.max(9, Math.floor((size * room) / wanted));
      ctx.font = `400 ${size}px ${font}`;
    }
    ctx.fillText(footer, 4, view.h + strip / 2);
  }

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
