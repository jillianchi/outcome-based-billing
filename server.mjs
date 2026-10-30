import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBatchDemo, DemoError } from './lib/batch-demo.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(root, process.env.DEMO_DATA_DIR || '.data');
await mkdir(dir, { recursive: true });
const demo = createBatchDemo({ dir });
let mutationQueue = Promise.resolve();
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

export const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host;
    if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: 'Local demo only.' });
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'GET' && url.pathname === '/api/demo/state') return send(res, 200, await demo.view(url.searchParams.get('mode') || 'fixture'));
    if (req.method === 'POST' && url.pathname === '/api/demo/action') {
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return send(res, 403, { error: 'Local origin required.' });
      if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, { error: 'JSON required.' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 2048) return send(res, 413, { error: 'Request too large.' });
      }
      let payload;
      try { payload = JSON.parse(body); } catch { return send(res, 400, { error: 'Invalid JSON.' }); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return send(res, 400, { error: 'An action object is required.' });
      const task = mutationQueue.then(() => demo.action(payload));
      mutationQueue = task.catch(() => {});
      return send(res, 200, await task);
    }
    if (req.method === 'GET' && files[url.pathname]) {
      const [file, type] = files[url.pathname];
      return send(res, 200, await readFile(path.join(root, 'public', file)), type);
    }
    send(res, 404, { error: 'Not found.' });
  } catch (error) {
    // Never return provider responses, credentials or stack traces to the screen.
    send(res, 400, { error: error instanceof DemoError ? error.message : 'Unable to complete this action. Check the local demo configuration.' });
  }
});
server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log(`OrderAI fictional demo · http://localhost:${server.address().port}`));
