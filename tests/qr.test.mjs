import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { qrMatrix, qrPath } from '../public/js/qr.js?v=2';

const JOIN_URL = 'https://pollen.rijdho.org/K7RM2Q';

// tests/fixtures/qr-join-url.txt is this encoder's output for JOIN_URL, and it
// was verified once by decoding it with an independent implementation
// (zxing-cpp), which read back exactly JOIN_URL. Freezing the matrix turns that
// one-off proof into a standing check: any change to the encoder, the error
// correction level or the version selection shows up here.
//
// Regenerating the fixture without decoding it again would make this test
// vacuous. If it ever needs regenerating, decode the new matrix first.
const FIXTURE = readFileSync('tests/fixtures/qr-join-url.txt', 'utf8').trim().split('\n');

test('the encoder still produces the matrix that was decoded', () => {
  const { size, modules } = qrMatrix(JOIN_URL);
  assert.equal(size, FIXTURE.length);
  const rows = modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''));
  assert.deepEqual(rows, FIXTURE);
});

test('a join URL fits in a small version', () => {
  // Version 3 at error correction M. A larger version means finer modules and
  // a code that a phone at the back of a lecture hall cannot resolve.
  const { size } = qrMatrix(JOIN_URL);
  assert.equal(size, 29, 'version 3');
  assert.equal((size - 17) % 4, 0, 'a QR side is always 17 + 4 times the version');
});

test('the three finder patterns are where a scanner looks for them', () => {
  const { size, modules } = qrMatrix(JOIN_URL);
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(modules[top][left], true, 'finder corner is dark');
    assert.equal(modules[top + 1][left + 1], false, 'finder ring is light');
    assert.equal(modules[top + 3][left + 3], true, 'finder centre is dark');
  }
});

test('the quiet zone is four modules on every side', () => {
  const { extent, size } = qrPath(JOIN_URL);
  assert.equal(extent, size + 8);
  // Nothing may be drawn inside the margin: every subpath starts at 4 or more
  // and ends before extent - 4.
  for (const [, x, y, run] of qrPath(JOIN_URL).d.matchAll(/M(\d+) (\d+)h(\d+)/g)
    .map((m) => [m[0], Number(m[1]), Number(m[2]), Number(m[3])])) {
    assert.ok(x >= 4 && y >= 4, `subpath starts inside the quiet zone at ${x},${y}`);
    assert.ok(x + run <= extent - 4, 'a run crosses into the quiet zone');
  }
});

test('horizontal runs are merged rather than drawn module by module', () => {
  const { d } = qrPath(JOIN_URL);
  const { modules } = qrMatrix(JOIN_URL);
  const dark = modules.flat().filter(Boolean).length;
  const subpaths = (d.match(/M/g) || []).length;
  assert.ok(subpaths < dark, `${subpaths} subpaths for ${dark} dark modules is no merging at all`);
  // Every dark module is still covered: the widths must add up.
  const covered = [...d.matchAll(/h(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  assert.equal(covered, dark);
});

test('a longer payload grows the code rather than failing', () => {
  const long = qrMatrix('https://pollen.rijdho.org/K7RM2Q?lang=de&something=' + 'x'.repeat(60));
  assert.ok(long.size > 29, 'a bigger payload needs a bigger version');
});
