// pollen, on any machine that runs Node.
//
//   npm install
//   node server/index.mjs            # http://localhost:8788
//
// The request handling, the room logic and the SQL are imported from
// `worker/src/`, unchanged: this file and `durable.mjs` are the platform, not a
// second copy of the application. That is what lets the same test suites run
// against either one.
//
// What is different from the Cloudflare deployment, and said here rather than
// discovered later: rooms live in this process's memory, so restarting it ends
// every room, and a room's twelve-hour alarm is a timer rather than something
// the platform remembers. For a laptop, a workshop machine or a small VPS that
// is usually what you want; for a service that must survive a restart, point
// DatabaseSync at a file instead of ':memory:'.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { WebSocketServer } from 'ws';

import { Namespace } from './durable.mjs';
import worker, { Room, Throttle } from '../worker/src/index.js?v=1';

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = new URL('../public/', import.meta.url).pathname;

const env = {};
env.ROOM = new Namespace(Room, env);
env.THROTTLE = new Namespace(Throttle, env);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The response headers come from public/_headers, parsed rather than repeated,
 * so the policy this serves is the policy the Cloudflare deployment serves.
 * Two copies of a Content-Security-Policy is exactly how one of them ends up
 * weaker than the other.
 */
async function loadHeaderRules() {
  const text = await readFile(join(PUBLIC, '_headers'), 'utf8');
  const rules = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      current = { pattern: line.trim(), headers: [] };
      rules.push(current);
    } else if (current) {
      const at = line.indexOf(':');
      if (at > 0) current.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    }
  }
  return rules;
}

const HEADER_RULES = await loadHeaderRules();

function headersFor(pathname) {
  const out = new Headers();
  for (const rule of HEADER_RULES) {
    const prefix = rule.pattern.replace(/\*$/, '');
    if (rule.pattern.endsWith('*') ? pathname.startsWith(prefix) : pathname === rule.pattern) {
      for (const [name, value] of rule.headers) out.set(name, value);
    }
  }
  return out;
}

async function readAsset(pathname) {
  // No traversal: the path is normalised and then required to stay inside.
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, clean);
  if (!file.startsWith(PUBLIC)) return null;
  try {
    if ((await stat(file)).isDirectory()) return null;
    return { body: await readFile(file), type: TYPES[extname(file)] || 'application/octet-stream' };
  } catch {
    return null;
  }
}

function toRequest(req, extraHeaders = {}) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? req : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const response = await worker.fetch(toRequest(req), env, {});
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }

    const asset = await readAsset(url.pathname);
    if (asset) {
      const headers = headersFor(url.pathname);
      headers.set('content-type', asset.type);
      res.writeHead(200, Object.fromEntries(headers));
      res.end(asset.body);
      return;
    }

    // Single-page fallback, matching not_found_handling in the Wrangler config.
    const shell = await readAsset('/index.html');
    const headers = headersFor('/index.html');
    headers.set('content-type', TYPES['.html']);
    res.writeHead(200, Object.fromEntries(headers));
    res.end(shell.body);
  } catch (error) {
    // Never echo the error: a stack trace from a storage layer is exactly the
    // kind of text that carries internals into a response.
    console.error('unhandled', error && error.message);
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'internal' }));
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  try {
    const response = await worker.fetch(
      toRequest(req, { upgrade: 'websocket' }), env, {},
    );
    if (!response.isUpgrade) {
      socket.write('HTTP/1.1 ' + response.status + ' \r\n\r\n');
      socket.destroy();
      return;
    }
    const serverEnd = response.webSocket.server;
    wss.handleUpgrade(req, socket, head, (wire) => {
      serverEnd.attach(wire);
      const owner = serverEnd.owner;
      wire.on('message', (data) => {
        owner?.instance.object.webSocketMessage?.(serverEnd, data.toString());
      });
      wire.on('close', (code, reason) => {
        owner?.sockets.delete(serverEnd);
        owner?.instance.object.webSocketClose?.(serverEnd, code, reason.toString(), true);
      });
    });
  } catch (error) {
    console.error('upgrade failed', error && error.message);
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`pollen on http://${HOST}:${PORT}`);
});
