import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metronome, requireMetronome, usageCount } from '../lib/providers.mjs';

const env = { METRONOME_API_KEY: 'dummy-private-key', METRONOME_SANDBOX_CONFIRMED: 'true', METRONOME_CUSTOMER_ID: 'demo-harvest', METRONOME_BILLABLE_METRIC_ID: 'outcomes' };

test('sandbox credentials must be explicitly confirmed and customer-scoped', () => {
  requireMetronome(env);
  for (const override of [{ METRONOME_API_KEY: '' }, { METRONOME_SANDBOX_CONFIRMED: 'false' }, { METRONOME_CUSTOMER_ID: '' }]) {
    assert.throws(() => requireMetronome({ ...env, ...override }));
  }
});

test('provider failures do not expose upstream bodies or keys', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('upstream-private-key-and-url', { status: 401 });
  try {
    await assert.rejects(metronome('/v1/ingest', [], env), error => !error.message.includes('private-key') && error.message.includes('401'));
  } finally { globalThis.fetch = original; }
});

test('usage checks use UTC month boundaries and isolate the requested customer and metric', async () => {
  const original = globalThis.fetch;
  const rows = [
    { customer_id: 'demo-harvest', billable_metric_id: 'outcomes', value: 6 },
    { customer_id: 'demo-coastal', billable_metric_id: 'outcomes', value: 200 },
    { customer_id: 'demo-harvest', billable_metric_id: 'other', value: 100 },
  ];
  let payload;
  let result = { data: rows };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.metronome.com/v1/usage');
    payload = JSON.parse(options.body);
    return Response.json(result);
  };
  try {
    assert.equal(await usageCount('2026-12', env), 6);
    assert.equal(payload.starting_on, '2026-12-01T00:00:00.000Z');
    assert.equal(payload.ending_before, '2027-01-01T00:00:00.000Z');
    assert.deepEqual(payload.customer_ids, ['demo-harvest']);
    assert.deepEqual(payload.billable_metrics, [{ id: 'outcomes' }]);
    result = { data: rows, next_page: 'more' };
    await assert.rejects(usageCount('2026-12', env), /pagination/);
    result = { data: [{ ...rows[0], value: 0.5 }] };
    await assert.rejects(usageCount('2026-12', env), /integer count/);
    await assert.rejects(usageCount('2026-13', env), /YYYY-MM/);
  } finally { globalThis.fetch = original; }
});
