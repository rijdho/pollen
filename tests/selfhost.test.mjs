import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Two Wrangler configs is the shape this repository's own conventions warn
// about: a thing with two homes drifts. These checks are the price of having
// both, and they are cheaper than a clone that will not deploy.

const strip = (text) => text
  .split('\n')
  .filter((line) => !line.trim().startsWith('#') && line.trim() !== '')
  .join('\n');

const MINE = strip(readFileSync('wrangler.toml', 'utf8'));
const OURS = strip(readFileSync('wrangler.self-host.toml', 'utf8'));

test('the self-host config carries nothing belonging to one account', () => {
  assert.doesNotMatch(OURS, /routes\s*=/, 'a route points at a domain the cloner does not own');
  assert.doesNotMatch(OURS, /rijdho/, 'it names an account');
  assert.doesNotMatch(OURS, /workers_dev\s*=\s*false/,
    'with no route and no workers.dev, a deploy would land nowhere reachable');
});

test('and is otherwise identical to the one this repository deploys', () => {
  // Every line of the real config except the two that are personal must appear
  // in the self-host one. A binding, a migration or a compatibility date that
  // drifts would mean the version a stranger runs is not the version tested.
  const personal = /^(workers_dev|routes|\s*\{ pattern|\])/;
  const missing = MINE.split('\n')
    .filter((line) => !personal.test(line))
    .filter((line) => !OURS.includes(line));
  assert.deepEqual(missing, [], 'these lines are in wrangler.toml and not in the self-host config');
});

test('the self-host config adds nothing of its own', () => {
  const extra = OURS.split('\n').filter((line) => !MINE.includes(line));
  assert.deepEqual(extra, [], 'these lines exist only in the self-host config');
});

test('the Worker asks for nothing a cloner would have to obtain', () => {
  // No API key, no external service, no environment variable: the whole reason
  // "connect it to your own database" has no steps is that the database is the
  // Durable Objects, created inside whoever deploys it.
  const worker = ['worker/src/index.js', 'worker/src/room.js', 'worker/src/throttle.js']
    .map((f) => readFileSync(f, 'utf8')).join('\n');
  const bindings = [...worker.matchAll(/\benv\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(bindings)].sort(), ['ROOM', 'THROTTLE'],
    'a new binding means a new setup step for anyone self-hosting');
  assert.doesNotMatch(worker, /process\.env/);
});

test('nothing in the application points at one deployment', () => {
  const app = ['public/js/app.js', 'public/js/api.js', 'public/js/views/present.js']
    .map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.doesNotMatch(app, /rijdho\.org/,
    'a hardcoded host would send a self-hosted copy back to the original');
  assert.match(app, /location\.origin/, 'join and recovery URLs come from wherever it is running');
});
