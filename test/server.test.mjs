import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('HTTP demo preserves replay identities across restarts and isolates local credentials', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orderai-http-'));
  let child;
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DEMO_DATA_DIR: dir, PORT: '0', METRONOME_API_KEY: 'hidden-api-key', METRONOME_SANDBOX_CONFIRMED: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', data => stderr += String(data));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server start timeout')), 8000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}. ${stderr}`)); });
      child.stdout.on('data', data => {
        const match = String(data).match(/http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      });
    });
  }
  async function stop() { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; }
  try {
    let base = await start();
    const state = async () => (await fetch(`${base}/api/demo/state`)).json();
    const post = (body, headers = {}) => fetch(`${base}/api/demo/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    const action = async name => {
      const response = await post(JSON.stringify({ action: name }));
      assert.equal(response.status, 200);
      return response.json();
    };
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.ok(page.headers.get('content-security-policy').includes("connect-src 'self'"));
    assert.equal((await state()).mode, 'fixture');
    assert.equal((await state()).sandboxAvailable, false);
    assert.deepEqual(await readdir(dir), [], 'Startup does not create old seed data or journals');
    for (let i = 0; i < 10; i++) await action('next');
    const completed = await state();
    assert.equal(completed.completed, 10);
    assert.deepEqual(completed.customers.map(c => c.events.length), [6, 6]);
    assert.ok(!JSON.stringify(completed).includes('hidden-api-key'));
    assert.ok(!JSON.stringify(completed).includes('customer_id'));
    assert.equal((await post('{"action":"replay"}', { Origin: 'https://external.invalid' })).status, 403);
    assert.equal((await post('not-json')).status, 400);
    assert.equal((await post('null')).status, 400);
    assert.equal((await post('{}', { 'Content-Type': 'text/plain' })).status, 415);
    for (const privatePath of ['/.env', '/.data/batch-fixture.json', '/server.mjs', '/api/state', '/scripts/sandbox.mjs']) {
      assert.equal((await fetch(`${base}${privatePath}`)).status, 404);
    }
    assert.equal((await post('{"action":"next","mode":"live"}')).status, 400);
    await stop(); base = await start();
    assert.equal((await state()).completed, 10);
    const replay = await action('replay');
    assert.equal(replay.completed, 0);
    assert.deepEqual(replay.customers.map(c => c.events.length), [0, 0]);
    for (let i = 0; i < 10; i++) await action('next');
    assert.deepEqual((await state()).customers, completed.customers);
  } finally {
    if (child && child.exitCode === null) await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
