// A QR code as SVG path data, so the projector can show it at any size and the
// page loads no image and no script from anywhere else.
//
// The encoder is vendored (MIT, see vendor/qrcode-generator.js). This file is
// only the part worth testing: the size chosen, the quiet zone, and the path.

import qrcode from './vendor/qrcode-generator.js?v=1';

/**
 * @param {string} text
 * @param {'L'|'M'|'Q'|'H'} ecc  M is the default: a projected code is read in
 *   good light from a fixed distance, so the extra redundancy of Q or H would
 *   only buy density nobody needs.
 * @returns {{size: number, modules: boolean[][]}} size excludes the quiet zone.
 */
export function qrMatrix(text, ecc = 'M') {
  const q = qrcode(0, ecc); // 0: pick the smallest version that fits
  q.addData(text);
  q.make();
  const size = q.getModuleCount();
  const modules = [];
  for (let r = 0; r < size; r += 1) {
    const row = [];
    for (let c = 0; c < size; c += 1) row.push(q.isDark(r, c));
    modules.push(row);
  }
  return { size, modules };
}

/**
 * SVG path data for the dark modules, one subpath per module, in a viewBox of
 * (size + 2 * quiet) units.
 *
 * The quiet zone is four modules because that is what the specification
 * requires; scanners are forgiving about it right up until the moment someone
 * prints the code on a busy slide and it stops working.
 */
export function qrPath(text, { ecc = 'M', quiet = 4 } = {}) {
  const { size, modules } = qrMatrix(text, ecc);
  const parts = [];
  for (let r = 0; r < size; r += 1) {
    let c = 0;
    while (c < size) {
      if (!modules[r][c]) { c += 1; continue; }
      // Merge horizontal runs: a 29x29 code drops from ~400 subpaths to ~150,
      // which matters only because the presenter view redraws on every vote.
      let run = 1;
      while (c + run < size && modules[r][c + run]) run += 1;
      parts.push(`M${c + quiet} ${r + quiet}h${run}v1h-${run}z`);
      c += run;
    }
  }
  return { d: parts.join(''), extent: size + quiet * 2, size };
}

/** An <svg> element, built node by node so no markup is ever parsed. */
export function qrSvg(document, text, options = {}) {
  const { d, extent } = qrPath(text, options);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${extent} ${extent}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(extent));
  bg.setAttribute('height', String(extent));
  bg.setAttribute('fill', '#ffffff');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  return svg;
}
