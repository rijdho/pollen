// PNG fixtures written by hand, so neither the browser suite nor the screenshot
// script gains a dependency for the sake of two files.
//
// Both shapes are needed and the difference between them is the point.
// `photo` is smooth gradients with structure and a little grain: it behaves
// like a photograph, so the rescale-and-re-encode loop in
// public/js/imagefile.js gets it comfortably under the 100 KB cap. `noise` is
// pure random RGB, which no lossy codec can compress at any quality, so it
// exercises the branch that gives up and says why. A first version of the
// browser suite used noise for both and read the refusal as a bug in the
// field; it was not, and the two cases are separate on purpose.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function writePng(path, width, height, pixel) {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    raw[at] = 0; at += 1;                          // filter type 0 for the row
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; at += 3;
    }
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])), body.length + 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;                        // 8-bit RGB
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

let seed = 7;
const random = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed >> 16) & 0xff;
};

/** Photograph-like: gradients, one round shape, a little grain. */
export function makePhotoPng(path, width, height) {
  writePng(path, width, height, (x, y) => {
    const wave = Math.sin(x / 160) * Math.cos(y / 130);
    const blob = ((x - width * 0.34) ** 2 + (y - height * 0.4) ** 2) < (width * 0.11) ** 2 ? 70 : 0;
    const band = (y / height) * 120;
    const grain = (random() % 13) - 6;
    const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
    return [c(120 + wave * 55 + blob + grain), c(90 + band + wave * 30 + grain), c(170 - band * 0.6 + grain)];
  });
}

/** Incompressible: what the size cap cannot accommodate at any quality. */
export function makeNoisePng(path, width, height) {
  writePng(path, width, height, () => [random(), random(), random()]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
