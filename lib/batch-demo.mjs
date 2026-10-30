import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { metronome, usageCount } from './providers.mjs';

export const CUSTOMERS = [
  { key: 'harvest', name: 'Harvest Distributors', terms: 'Standard contract', rate: '$0.15 / outcome', detail: 'First 2 / month included · $50 / month platform' },
  { key: 'coastal', name: 'Coastal Wholesale', terms: 'Negotiated contract', rate: '$0.12 / outcome', detail: 'First 2 / month included · $1 prepaid purchased · $50 / month platform' },
];
export const ORDERS = [
  { id: '1041', item: '12 cases of tomatoes', result: 'success' },
  { id: '1042', item: '8 cases of mixed greens', result: 'human' },
  { id: '1043', item: '20 bags of flour', result: 'success' },
  { id: '1044', item: '6 crates of apples', result: 'failure' },
  { id: '1045', item: '10 cases of oat milk', result: 'success' },
  { id: '1046', item: '15 cartons of eggs', result: 'success' },
  { id: '1047', item: '4 cases of seasonal produce', result: 'human' },
  { id: '1048', item: '18 bags of basmati rice', result: 'success' },
  { id: '1049', item: '7 cases of Greek yoghurt', result: 'failure' },
  { id: '1050', item: '9 cases of sparkling water', result: 'success' },
];
// Different customer work, with the same success/exclusion pattern for comparison.
const CUSTOMER_SCENARIOS = {
  harvest: [
    {}, { reason: 'Human review · multiple catalog matches' }, {},
    { reason: 'ERP rejected · inactive SKU' }, {}, {},
    { reason: 'Human review · seasonal item not matched' }, {},
    { reason: 'ERP rejected · delivery date unavailable' }, {},
  ],
  coastal: [
    { item: '24 packs of frozen berries' },
    { item: '16 trays of king prawns', reason: 'Human review · unit conversion unclear' },
    { item: '30 boxes of sourdough rolls' },
    { item: '11 cases of coconut cream', reason: 'ERP rejected · account on credit hold' },
    { item: '14 cartons of cheddar cheese' },
    { item: '8 drums of olive oil' },
    { item: '3 cartons of smoked salmon', reason: 'Human review · pack size unspecified' },
    { item: '22 cases of chickpeas' },
    { item: '5 boxes of fresh basil', reason: 'ERP rejected · warehouse code invalid' },
    { item: '17 cases of orange juice' },
  ],
};
export const customerOrders = key => ORDERS.map((order, i) => ({ ...order, ...CUSTOMER_SCENARIOS[key][i] }));
export const orderReference = (customer, id) => `${customer === 'harvest' ? 'HV' : 'CW'}-${id}`;
export class DemoError extends Error {}
export function createBatchDemo({ dir, env = process.env, api = metronome, count = usageCount, now = () => new Date() }) {
  const journals = new Map();
  const validated = new Set();
  async function targets() {
    const entries = await Promise.all(CUSTOMERS.map(async c => [c.key, JSON.parse(await readFile(path.join(dir, `${c.key}-target.json`), 'utf8'))]));
    const result = Object.fromEntries(entries);
    for (const t of Object.values(result)) if (!t.customerId || !t.contractId || !t.metricId) throw new DemoError('Sandbox customer targets are incomplete.');
    if (result.harvest.customerId === result.coastal.customerId) throw new DemoError('The demo requires two separate sandbox customers.');
    return result;
  }
  async function configured() {
    if (!env.METRONOME_API_KEY || env.METRONOME_SANDBOX_CONFIRMED !== 'true') return false;
    try { await targets(); return true; } catch { return false; }
  }
  function scopedEnv(t) { return { ...env, METRONOME_CUSTOMER_ID: t.customerId, METRONOME_BILLABLE_METRIC_ID: t.metricId }; }
  async function load(mode) {
    if (!['fixture', 'live'].includes(mode)) throw new DemoError('Choose offline rehearsal or sandbox.');
    let mappings = null;
    if (mode === 'live') {
      if (!await configured()) throw new DemoError('Configure the confirmed sandbox key and both customer targets first.');
      mappings = await targets();
    }
    const scope = mappings ? createHash('sha256').update(JSON.stringify(mappings)).digest('hex') : 'offline';
    if (!journals.has(mode)) {
      let journal;
      try { journal = JSON.parse(await readFile(path.join(dir, `batch-${mode}.json`), 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; journal = { scope, run: randomUUID(), completed: 0, outbox: {}, check: null }; }
      journals.set(mode, journal);
    }
    const j = journals.get(mode);
    if (mode === 'fixture') for (const r of Object.values(j.outbox)) r.event.properties.order_id = orderReference(r.key, r.orderId);
    if (j.scope !== scope) throw new DemoError('Saved events belong to different customer targets. Restore the original targets.');
    return { j, mappings };
  }
  async function save(mode, j) {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `batch-${mode}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(j), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  async function validate(key, t) {
    const cacheKey = JSON.stringify(t);
    if (validated.has(cacheKey)) return;
    const e = scopedEnv(t);
    const [customer, contract] = await Promise.all([
      api(`/v1/customers/${encodeURIComponent(t.customerId)}`, undefined, e),
      api('/v2/contracts/get', { customer_id: t.customerId, contract_id: t.contractId }, e),
    ]);
    const expected = CUSTOMERS.find(c => c.key === key).name;
    if (customer.data?.name !== expected || contract.data?.id !== t.contractId || contract.data?.customer_id !== t.customerId || !contract.data?.rate_card_id) throw new DemoError('Sandbox customer or contract verification failed. No events sent.');
    validated.add(cacheKey);
  }
  function assertFresh(record) {
    const stamp = record.event.timestamp;
    if (stamp.slice(0, 7) !== now().toISOString().slice(0, 7) || now().getTime() - Date.parse(stamp) > 34 * 86400000) throw new DemoError('This saved batch belongs to an earlier billing month. It cannot be resent.');
  }
  async function deliver(mode, record, t, force = false) {
    if (mode === 'fixture') { record.delivery = 'fixture'; return; }
    if (record.delivery === 'accepted' && !force) return;
    assertFresh(record);
    record.delivery = 'pending';
    try { await api('/v1/ingest', [record.event], scopedEnv(t)); record.delivery = 'accepted'; if (force) record.retries++; }
    catch { record.delivery = 'pending'; }
  }
  async function view(mode = 'fixture') {
    const { j } = await load(mode);
    return {
      mode, sandboxAvailable: await configured(), completed: j.completed, orders: ORDERS,
      customers: CUSTOMERS.map(customer => ({
        ...customer,
        orders: customerOrders(customer.key).map(order => ({
          ...order,
          displayId: j.outbox[`${customer.key}-${order.id}`]?.event.properties.order_id ?? orderReference(customer.key, order.id),
        })),
        events: Object.values(j.outbox)
          .filter(record => record.key === customer.key && ORDERS.findIndex(order => order.id === record.orderId) < j.completed)
          .map(({ orderId, delivery, retries, event }) => ({
            orderId, delivery, retries,
            // Keep sandbox customer IDs and credentials out of the browser.
            event: { event_type: event.event_type, transaction_id: event.transaction_id, timestamp: event.timestamp, properties: event.properties },
          })),
      })),
      check: j.check,
    };
  }
  async function action({ mode = 'fixture', action, customer, orderId }) {
    const { j, mappings } = await load(mode);
    if (action === 'replay') { j.completed = 0; await save(mode, j); return view(mode); }
    if (action === 'verify') {
      if (mode !== 'live') throw new DemoError('Open Metronome in sandbox mode to check actual usage.');
      const month = now().toISOString().slice(0, 7);
      const rows = await Promise.all(CUSTOMERS.map(async c => {
        const t = mappings[c.key]; await validate(c.key, t);
        const outcomes = await count(month, scopedEnv(t));
        return { key: c.key, outcomes };
      }));
      j.check = { month, at: now().toISOString(), rows };
    } else if (action === 'next') {
      const order = ORDERS[j.completed];
      if (!order) return view(mode);
      if (order.result === 'success') {
        // Validate both customers before sending anything; persist both exact payloads before network I/O.
        if (mode === 'live') await Promise.all(CUSTOMERS.map(c => validate(c.key, mappings[c.key])));
        for (const c of CUSTOMERS) {
          const id = `${c.key}-${order.id}`;
          if (!j.outbox[id]) {
            const timestamp = now().toISOString();
            j.outbox[id] = { key: c.key, orderId: order.id, delivery: 'pending', retries: 0, event: {
              event_type: 'order.autonomously_processed', customer_id: mappings?.[c.key].customerId ?? `fixture-${c.key}`,
              transaction_id: `orderai-batch-${j.run}-${id}`, timestamp,
              properties: { order_id: orderReference(c.key, order.id), accepted_at: timestamp, human_intervention: false, erp_status: 'accepted', source: 'fictional_orderai_demo' },
            } };
          }
        }
        await save(mode, j);
        await Promise.all(CUSTOMERS.map(c => deliver(mode, j.outbox[`${c.key}-${order.id}`], mappings?.[c.key])));
      }
      j.completed++;
    } else if (action === 'retry') {
      const r = j.outbox[`${customer}-${orderId}`];
      if (!r) throw new DemoError('Run a successful order first.');
      if (mode === 'live') await validate(customer, mappings[customer]);
      await deliver(mode, r, mappings?.[customer], true);
      if (mode === 'fixture') r.retries++;
    } else throw new DemoError('Unknown demo action.');
    await save(mode, j);
    return view(mode);
  }
  return { view, action };
}
