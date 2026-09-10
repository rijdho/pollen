import test from 'node:test';
import assert from 'node:assert/strict';

import { readImage, base64Bytes } from '../public/js/shared/image.js?v=2';
import { LIMITS } from '../public/js/shared/limits.js?v=2';

/** A data URI whose payload decodes to exactly `bytes` bytes. */
function payload(bytes, mime = 'image/webp') {
  return 'data:' + mime + ';base64,' + Buffer.alloc(bytes, 7).toString('base64');
}

test('the cap is a hundred kilobytes, and it is the decoded size', () => {
  // Pinned because it is a promise made in the interface and in the README,
  // and because "100 KB" has to mean the image rather than the base64 around
  // it, which is a third larger.
  assert.equal(LIMITS.image.maxBytes, 100 * 1024);
  assert.equal(base64Bytes(Buffer.alloc(100 * 1024).toString('base64')), 100 * 1024);
});

test('base64Bytes counts padding rather than guessing', () => {
  assert.equal(base64Bytes(Buffer.from('a').toString('base64')), 1);       // 'YQ=='
  assert.equal(base64Bytes(Buffer.from('ab').toString('base64')), 2);      // 'YWI='
  assert.equal(base64Bytes(Buffer.from('abc').toString('base64')), 3);     // 'YWJj'
  assert.equal(base64Bytes('YWJ'), -1, 'a length that is not a multiple of four is not base64');
});

test('the three raster types are accepted and nothing else is', () => {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
    const image = readImage(payload(64, mime));
    assert.ok(image, mime + ' should be carried');
    assert.equal(image.mime, mime);
    assert.equal(image.bytes, 64);
  }
  for (const mime of ['image/svg+xml', 'image/gif', 'text/html', 'application/json', 'image/avif']) {
    assert.equal(readImage(payload(64, mime)), null, mime + ' should be refused');
  }
});

test('an SVG is refused even when it is a real one', () => {
  // Not because a browser runs script inside an <img>, which it does not, but
  // because that is the browser's guarantee to withdraw and this tool needs no
  // vector. The refusal is the type, so the contents never matter.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>';
  const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  assert.equal(readImage(uri), null);
  assert.equal(readImage('data:image/svg+xml,' + encodeURIComponent(svg)), null);
});

test('nothing that would make a request to another host is carried', () => {
  // The front page promises no third-party request of any kind. img-src in
  // public/_headers stops these in a browser; this stops them at the point the
  // question is written, which is where the promise is actually made.
  for (const value of [
    'https://example.org/cat.png',
    'http://example.org/cat.png',
    '//example.org/cat.png',
    '/api/rooms/ABCDEF/image?idx=0',
    'blob:https://pollen.rijdho.org/9f2c',
    'file:///etc/passwd',
  ]) {
    assert.equal(readImage(value), null, value + ' should be refused');
  }
});

test('a payload one byte over the cap is refused, and one byte under is not', () => {
  assert.ok(readImage(payload(LIMITS.image.maxBytes)), 'exactly at the cap is allowed');
  assert.equal(readImage(payload(LIMITS.image.maxBytes + 1)), null);
  assert.ok(readImage(payload(LIMITS.image.maxBytes - 1)));
});

test('only the standard base64 alphabet, with no whitespace anywhere', () => {
  // A permissive reading here would mean the string that was measured is not
  // the string that gets stored.
  const good = Buffer.alloc(96, 251).toString('base64');
  assert.ok(readImage('data:image/png;base64,' + good));
  assert.ok(good.includes('+') || good.includes('/'), 'the fixture exercises both non-alphanumerics');

  assert.equal(readImage('data:image/png;base64,' + good.replace(/\+/g, '-').replace(/\//g, '_')), null,
    'the URL-safe alphabet is a different encoding, not a variant of this one');
  assert.equal(readImage('data:image/png;base64,' + good.slice(0, 8) + '\n' + good.slice(8)), null);
  assert.equal(readImage('data:image/png;base64,' + good.slice(0, 8) + ' ' + good.slice(8)), null);
  assert.equal(readImage('data:image/png;base64,'), null, 'an empty payload is not an image');
});

test('what comes back is exactly what was checked', () => {
  // The Worker stores the returned src, not the string it was handed, so a
  // prefix that survived the check but differed from what was measured would
  // be a way to store something nobody validated.
  const bytes = Buffer.alloc(48, 3).toString('base64');
  const image = readImage('data:image/jpeg;base64,' + bytes);
  assert.equal(image.src, 'data:image/jpeg;base64,' + bytes);
});

test('a second data URI cannot ride inside the first', () => {
  const inner = 'data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
  assert.equal(readImage('data:image/png;base64,' + inner), null,
    'the inner prefix is not base64, so the whole thing is refused');
});

test('anything that is not a string is not an image', () => {
  for (const value of [null, undefined, 0, 1, {}, [], true, { src: payload(32) }, Buffer.alloc(32)]) {
    assert.equal(readImage(value), null, String(value));
  }
});
