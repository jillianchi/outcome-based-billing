import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createBatchDemo, CUSTOMERS, ORDERS } from '../lib/batch-demo.mjs';

async function temporary(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'orderai-batch-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('immediate outcomes exclude human intervention and ERP failure; replay retains identities', () => temporary(async dir => {
  const demo = createBatchDemo({ dir });
  for (let i = 0; i < ORDERS.length; i++) await demo.action({ action: 'next' });
  const result = await demo.view();
  assert.equal(result.completed, 10);
  for (const c of result.customers) {
    assert.equal(c.events.length, 6);
    assert.deepEqual(c.events.map(r => r.orderId), ['1041', '1043', '1045', '1046', '1048', '1050']);
    for (const r of c.events) {
      assert.equal(r.event.timestamp, r.event.properties.accepted_at);
      assert.equal(r.event.properties.human_intervention, false);
      assert.equal(r.delivery, 'fixture');
    }
  }
  assert.equal(result.customers[0].orders[0].displayId, 'NS-1041');
  assert.equal(result.customers[1].orders[0].displayId, 'CB-1041');
  assert.equal(result.customers[0].events[0].event.properties.order_id, 'NS-1041');
  assert.equal(result.customers[1].events[0].event.properties.order_id, 'CB-1041');
  result.customers[0].orders.forEach((harvest, i) => {
    const coastal = result.customers[1].orders[i];
    assert.notEqual(harvest.item, coastal.item);
    assert.equal(harvest.result, coastal.result);
    if (harvest.result !== 'success') assert.notEqual(harvest.reason, coastal.reason);
  });
  const restarted = createBatchDemo({ dir });
  await restarted.action({ action: 'replay' });
  for (let i = 0; i < ORDERS.length; i++) await restarted.action({ action: 'next' });
  assert.deepEqual((await restarted.view()).customers, result.customers);
}));

for (const names of ['renamed', 'legacy', 'sandbox']) test(`sandbox verifies ${names} customers, durable identical retries, and readonly counts`, () => temporary(async dir => {
  for (const c of CUSTOMERS) await writeFile(path.join(dir, `${c.key}-target.json`), JSON.stringify({ customerId: c.key, contractId: `${c.key}-contract`, metricId: 'outcomes' }));
  const env = { METRONOME_API_KEY: 'hidden-key', METRONOME_SANDBOX_CONFIRMED: 'true' };
  const calls = [];
  const api = async (endpoint, body, e) => {
    const key = e.METRONOME_CUSTOMER_ID;
    if (endpoint.startsWith('/v1/customers/')) return { data: { name: names === 'renamed' ? CUSTOMERS.find(c => c.key === key).name : { harvest: names === 'sandbox' ? 'Northstar Distributors' : 'Harvest Distributors', coastal: 'Coastal Wholesale' }[key] } };
    if (endpoint === '/v2/contracts/get') return { data: { id: `${key}-contract`, customer_id: key, rate_card_id: 'shared-card' } };
    assert.equal(endpoint, '/v1/ingest');
    calls.push(structuredClone(body));
    if (calls.length === 1) throw Error('private provider response');
  };
  const options = { dir, env, api, count: async () => 11 };
  let demo = createBatchDemo(options);
  await demo.action({ mode: 'live', action: 'next' });
  let state = await demo.view('live');
  assert.equal(state.customers[0].events[0].delivery, 'pending');
  assert.equal(state.customers[1].events[0].delivery, 'accepted');
  demo = createBatchDemo(options);
  await demo.action({ mode: 'live', action: 'retry', customer: 'harvest', orderId: '1041' });
  assert.deepEqual(calls[0], calls[2]);
  assert.equal(calls[0][0].customer_id, 'harvest');
  assert.equal(calls[1][0].customer_id, 'coastal');
  assert.notEqual(calls[0][0].properties.order_id, calls[1][0].properties.order_id);
  await demo.action({ mode: 'live', action: 'replay' });
  await demo.action({ mode: 'live', action: 'next' });
  assert.equal(calls.length, 3, 'visual replay does not send accepted events again');
  await demo.action({ mode: 'live', action: 'verify' });
  state = await demo.view('live');
  assert.deepEqual(state.check.rows.map(r => r.outcomes), [11, 11]);
  assert.ok(!JSON.stringify(state).includes('hidden-key'));
  assert.ok(!JSON.stringify(state).includes('customer_id'));
  const older = createBatchDemo({ ...options, now: () => new Date('2027-01-01T00:00:00Z') });
  await assert.rejects(older.action({ mode: 'live', action: 'retry', customer: 'harvest', orderId: '1041' }), /earlier billing month/);
}));


test('fresh runs send new current-month events; interrupted runs keep IDs and previous batches are archived', () => temporary(async dir => {
  for (const c of CUSTOMERS) await writeFile(path.join(dir, `${c.key}-target.json`), JSON.stringify({ customerId: c.key, contractId: `${c.key}-contract`, metricId: 'outcomes' }));
  let clock = new Date('2026-10-30T06:00:00Z');
  const calls = [];
  const options = {
    dir, env: { METRONOME_API_KEY: 'hidden-key', METRONOME_SANDBOX_CONFIRMED: 'true' }, now: () => clock,
    api: async (endpoint, body, env) => {
      const key = env.METRONOME_CUSTOMER_ID;
      if (endpoint.startsWith('/v1/customers/')) return { data: { name: CUSTOMERS.find(c => c.key === key).name } };
      if (endpoint === '/v2/contracts/get') return { data: { id: `${key}-contract`, customer_id: key, rate_card_id: 'card' } };
      assert.equal(endpoint, '/v1/ingest'); calls.push(structuredClone(body[0]));
    },
  };
  let demo = createBatchDemo(options);
  for (let i = 0; i < 10; i++) await demo.action({ mode: 'live', action: 'next' });
  const original = await readFile(path.join(dir, 'batch-live.json'), 'utf8');
  await demo.action({ mode: 'live', action: 'replay' });
  clock = new Date('2026-11-11T06:00:00Z');
  demo = createBatchDemo(options);
  const fresh = await demo.action({ mode: 'live', action: 'start' });
  assert.deepEqual(fresh.customers.map(c => c.events.length), [0, 0]);
  assert.equal(calls.length, 12, 'preparing a new batch sends nothing');
  const archives = await readdir(path.join(dir, 'batch-history'));
  assert.equal(archives.length, 1);
  const archived = JSON.parse(await readFile(path.join(dir, 'batch-history', archives[0]), 'utf8'));
  assert.deepEqual(archived.outbox, JSON.parse(original).outbox);
  await demo.action({ mode: 'live', action: 'next' });
  const partial = await demo.view('live');
  demo = createBatchDemo(options);
  assert.deepEqual(await demo.action({ mode: 'live', action: 'start' }), partial, 'continuation preserves events across restart');
  const interrupted = JSON.parse(await readFile(path.join(dir, 'batch-live.json'), 'utf8'));
  interrupted.completed = 0; // Crash after saving the first payloads, before recording progress.
  await writeFile(path.join(dir, 'batch-live.json'), JSON.stringify(interrupted));
  demo = createBatchDemo(options);
  await demo.action({ mode: 'live', action: 'start' });
  await demo.action({ mode: 'live', action: 'next' });
  assert.equal(calls.length, 14, 'starting after a crash does not resend accepted first-order events');
  for (let i = 1; i < 10; i++) await demo.action({ mode: 'live', action: 'next' });
  assert.equal(calls.length, 24);
  assert.equal(new Set(calls.map(e => e.transaction_id)).size, 24);
  assert.ok(calls.slice(12).every(e => e.timestamp === clock.toISOString()));
  const previous = calls.at(-2);
  await demo.action({ mode: 'live', action: 'retry', customer: 'harvest', orderId: '1050' });
  assert.deepEqual(calls.at(-1), previous, 'retry preserves the exact event');
  const reset = await demo.action({ mode: 'live', action: 'new-batch' });
  assert.equal(reset.completed, 0);
  assert.equal(calls.length, 25, 'clearing the screen sends nothing');
  await demo.action({ mode: 'live', action: 'next' });
  assert.equal(new Set(calls.map(e => e.transaction_id)).size, 26);
}));
