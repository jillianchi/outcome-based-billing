import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { metronome, usageCount } from './providers.mjs';

export const CUSTOMERS = [
  { key: 'harvest', name: 'Northstar Office Supplies', terms: 'Standard contract', rate: '$0.15 / outcome', detail: 'First 2 / month included · $50 / month platform' },
  { key: 'coastal', name: 'Coastal Business Supplies', terms: 'Negotiated contract', rate: '$0.12 / outcome', detail: '20% discount · First 2 / month included · $1 prepaid purchased · $50 / month platform' },
];
export const ORDERS = [
  { id: '1041', item: '12 cartons of A4 copy paper', result: 'success' },
  { id: '1042', item: '8 packs of printer paper', result: 'human' },
  { id: '1043', item: '20 boxes of window envelopes', result: 'success' },
  { id: '1044', item: '6 packs of discontinued label sheets', result: 'failure' },
  { id: '1045', item: '10 boxes of black ballpoint pens', result: 'success' },
  { id: '1046', item: '15 packs of manila folders', result: 'success' },
  { id: '1047', item: '4 replacement toner cartridges', result: 'human' },
  { id: '1048', item: '18 packs of sticky notes', result: 'success' },
  { id: '1049', item: '7 cartons of archive boxes', result: 'failure' },
  { id: '1050', item: '9 boxes of whiteboard markers', result: 'success' },
];
// Different customer work, with the same success/exclusion pattern for comparison.
const CUSTOMER_SCENARIOS = {
  harvest: [
    {}, { reason: 'Human review · paper size unspecified' }, {},
    { reason: 'ERP rejected · inactive SKU' }, {}, {},
    { reason: 'Human review · printer model missing' }, {},
    { reason: 'ERP rejected · delivery date unavailable' }, {},
  ],
  coastal: [
    { item: '24 reams of A3 copy paper' },
    { item: '16 packs of presentation covers', reason: 'Human review · multiple catalog matches' },
    { item: '30 boxes of paper clips' },
    { item: '11 cartons of padded mailers', reason: 'ERP rejected · account on credit hold' },
    { item: '14 packs of lever arch files' },
    { item: '8 boxes of desktop staplers' },
    { item: '3 boxes of binder dividers', reason: 'Human review · pack size unspecified' },
    { item: '22 packs of ruled notebooks' },
    { item: '5 cartons of thermal receipt rolls', reason: 'ERP rejected · warehouse code invalid' },
    { item: '17 packs of highlighters' },
  ],
};
export const customerOrders = key => ORDERS.map((order, i) => ({ ...order, ...CUSTOMER_SCENARIOS[key][i] }));
export const orderReference = (customer, id) => `${customer === 'harvest' ? 'NS' : 'CB'}-${id}`;
// Keep existing sandbox mappings and saved event identities valid after the story rename.
const CUSTOMER_NAME_ALIASES = { harvest: ['Harvest Distributors', 'Northstar Distributors'], coastal: ['Coastal Wholesale'] };
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
    if (![expected, ...CUSTOMER_NAME_ALIASES[key]].includes(customer.data?.name) || contract.data?.id !== t.contractId || contract.data?.customer_id !== t.customerId || !contract.data?.rate_card_id) throw new DemoError('Sandbox customer or contract verification failed. No events sent.');
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
    const saved = Object.values(j.outbox);
    const replayed = j.completed === 0 && saved.length === CUSTOMERS.length * ORDERS.filter(o => o.result === 'success').length
      && saved.every(r => ['accepted', 'fixture'].includes(r.delivery));
    if (action === 'new-batch' || (action === 'start' && (replayed || j.completed === ORDERS.length))) {
      if (Object.keys(j.outbox).length) {
        const archive = path.join(dir, 'batch-history');
        await mkdir(archive, { recursive: true });
        await writeFile(path.join(archive, `${mode}-${j.run}.json`), JSON.stringify(j), { mode: 0o600 });
      }
      Object.assign(j, { run: randomUUID(), completed: 0, outbox: {} });
      await save(mode, j);
      return view(mode);
    }
    if (action === 'start') return view(mode); // Continue a partially processed batch with its original event IDs.
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
              transaction_id: `dunder-mifflin-batch-${j.run}-${id}`, timestamp,
              properties: { order_id: orderReference(c.key, order.id), accepted_at: timestamp, human_intervention: false, erp_status: 'accepted', source: 'fictional_dunder_mifflin_demo' },
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
