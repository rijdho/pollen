import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Node server exists so this tool is not tied to one vendor. It is only
// worth having if it runs the SAME code: two implementations of the room logic
// would drift, and the second one would be the one nobody tests before a
// workshop. These checks are what keep `server/` a platform and not a copy.

const SERVER = ['server/index.mjs', 'server/durable.mjs']
  .map((f) => ({ file: f, src: readFileSync(f, 'utf8') }));
const ALL = SERVER.map((s) => s.src).join('\n');

test('the Node server runs the Worker code rather than its own', () => {
  const index = SERVER.find((s) => s.file === 'server/index.mjs').src;
  assert.match(index, /from '\.\.\/worker\/src\/index\.js/,
    'it must import the Worker router, not reimplement routing');
  assert.match(index, /\{\s*Room,\s*Throttle\s*\}|Room,\s*Throttle/,
    'and the Durable Object classes themselves');
});

test('it holds no copy of the room logic', () => {
  // Any statement naming an application table would mean the storage rules
  // were rewritten here, which is the drift this file exists to prevent.
  for (const table of ['votes', 'questions', 'voters', 'upvotes', 'meta', 'window']) {
    assert.doesNotMatch(ALL, new RegExp(`(FROM|INTO|UPDATE|TABLE)\\s+${table}\\b`, 'i'),
      `server/ names the ${table} table, so it is doing the object's job`);
  }
});

test('it holds no copy of the arithmetic or the input rules', () => {
  for (const name of [
    'tallyChoice', 'tallyScale', 'tallyCloud', 'tallyRank', 'percentages',
    'sanitiseText', 'cloudKey', 'normaliseCode', 'generateCode', 'LIMITS',
  ]) {
    assert.doesNotMatch(ALL, new RegExp(`\\b${name}\\b`),
      `server/ mentions ${name}; that logic has one home and this is not it`);
  }
});

test('it serves the policy from the same file the Worker does', () => {
  const index = SERVER.find((s) => s.file === 'server/index.mjs').src;
  assert.match(index, /_headers/,
    'the Content-Security-Policy must be parsed from public/_headers, not repeated');
  assert.doesNotMatch(index, /default-src|script-src|connect-src/,
    'a second copy of the policy is how one of them ends up weaker');
});

test('the adapter only translates, and says which APIs it stands in for', () => {
  const durable = SERVER.find((s) => s.file === 'server/durable.mjs').src;
  for (const api of [
    'acceptWebSocket', 'getWebSockets', 'idFromName', 'setAlarm', 'deleteAll',
    'blockConcurrencyWhile', 'serializeAttachment', 'WebSocketPair',
  ]) {
    assert.ok(durable.includes(api), `the adapter does not provide ${api}`);
  }
});
