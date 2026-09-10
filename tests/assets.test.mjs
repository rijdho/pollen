import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, ext, out);
    else if (name.endsWith(ext)) out.push(path);
  }
  return out;
}

const JS = [...walk('public/js', '.js'), ...walk('worker/src', '.js')];
const HTML = readFileSync('public/index.html', 'utf8');
const CSS = readFileSync('public/style.css', 'utf8');

test('every relative import carries a version, and every version is the same', () => {
  // With no bundler in the browser, a module graph is cached per resolved URL.
  // Versioning only the entry point lets a browser serve a stale module against
  // a fresh one that imports a symbol the cached copy does not export; the
  // graph then aborts with no visible error and the tool comes up blank while
  // looking deployed.
  const seen = new Map();
  for (const file of JS) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const specifier = match[1];
      const version = specifier.match(/\?v=(\d+)$/);
      assert.ok(version, `${file} imports ${specifier} without a version`);
      seen.set(specifier.replace(/\?v=\d+$/, '') + ' <- ' + file, version[1]);
    }
  }
  assert.ok(seen.size >= 10, `only ${seen.size} relative imports found; the scan is broken`);
  const versions = new Set(seen.values());
  assert.equal(versions.size, 1, `mixed versions in flight: ${[...versions].join(', ')}`);
});

test('the page loads its assets at the same version as the modules', () => {
  const fromModules = readFileSync('public/js/app.js', 'utf8').match(/\?v=(\d+)/)[1];
  const inPage = [...HTML.matchAll(/(?:href|src)="\/[^"]*\?v=(\d+)"/g)].map((m) => m[1]);
  assert.ok(inPage.length >= 3, 'the stylesheet, the theme script and the entry module are all versioned');
  for (const version of inPage) {
    assert.equal(version, fromModules, 'the page and the module graph must move together');
  }
});

test('every import resolves to a file that exists', () => {
  for (const file of JS) {
    for (const match of readFileSync(file, 'utf8').matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = resolve(dirname(file), match[1].replace(/\?v=\d+$/, ''));
      assert.ok(existsSync(target), `${file} imports ${match[1]}, which is not there`);
    }
  }
});

test('nothing is loaded from another origin', () => {
  // The Content-Security-Policy in public/_headers starts at default-src
  // 'none', so an external subresource does not degrade, it silently
  // disappears: the page still looks right in development and ships with the
  // fallback font. This check is what catches it before a room does.
  //
  // Only things the page *loads* count. A link in the footer to the licence
  // text or to the source repository is a navigation, which no fetch directive
  // governs, and removing those would be a worse page for no security gain.
  const problems = [];

  for (const file of [...walk('public', '.css')]) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/url\(\s*["']?(https?:)?\/\/[^"')\s]+/g)) {
      problems.push(`${file}: ${match[0]}`);
    }
    if (/@import\s+(url\()?["']https?:/.test(source)) problems.push(`${file}: external @import`);
  }

  for (const file of walk('public', '.js')) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](https?:)?\/\/[^'"]+/g)) {
      problems.push(`${file}: ${match[0]}`);
    }
    for (const match of source.matchAll(/(?:fetch|new WebSocket|new EventSource)\s*\(\s*['"`](https?:)?\/\//g)) {
      problems.push(`${file}: ${match[0]}`);
    }
  }

  const html = readFileSync('public/index.html', 'utf8');
  for (const match of html.matchAll(/<(?:script|img|iframe|audio|video|source|embed|object)\b[^>]*\bsrc="(https?:)?\/\/[^"]+/gi)) {
    problems.push(`index.html: ${match[0]}`);
  }
  for (const match of html.matchAll(/<link\b[^>]*\bhref="(https?:)?\/\/[^"]+/gi)) {
    problems.push(`index.html: ${match[0]}`);
  }

  assert.deepEqual(problems, [], 'these would be blocked by the policy, silently');
});

test('the footer links out, which is a navigation and not a load', () => {
  // Pinned so the check above cannot be weakened into ignoring subresources by
  // someone who reads its exemption as "external URLs are fine here".
  const html = readFileSync('public/index.html', 'utf8');
  const anchors = [...html.matchAll(/<a\b[^>]*\bhref="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(anchors.some((href) => href.includes('gnu.org')), 'the licence is linked');
  assert.ok(anchors.some((href) => href.includes('github.com/rijdho/pollen')), 'the source is linked');
  // Every tool in this family signs itself the same way and points at the same
  // hub. life.rijdho.io has no DNS record; rijdho.github.io is the one that
  // serves, and it is what the sibling repositories link to.
  assert.ok(anchors.some((href) => href === 'https://rijdho.github.io'),
    'the footer points at the author hub the rest of the family points at');
});

test('the policy names only what the application uses', () => {
  const headers = readFileSync('public/_headers', 'utf8');
  const policy = headers.match(/Content-Security-Policy: ([^\n]+)/)[1];
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/, 'only a real header can carry this');
  assert.doesNotMatch(policy, /unsafe-inline/, 'sizing goes through element.style, which CSP does not govern');
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.ok(!/\*/.test(policy), 'no wildcard sources');
  // This is what actually stops a self-hosted copy talking to anybody else's
  // deployment, including through a hardcoded URL somebody adds by mistake: the
  // browser refuses the connection before the code gets a say.
  assert.match(policy, /connect-src 'self';/,
    "connect-src must be exactly 'self': anything wider lets a page reach another origin");
});

test('the fonts the stylesheet asks for are in the repository', () => {
  const referenced = [...CSS.matchAll(/url\("(\/fonts\/[^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(referenced.length >= 2, 'latin and latin-ext are both declared');
  for (const path of referenced) {
    assert.ok(existsSync(join('public', path)), `${path} is declared but not committed`);
  }
});
