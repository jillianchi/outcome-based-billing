const $ = selector => document.querySelector(selector);
let state, busy = false, active = -1, stage = '';
let mode = 'fixture';
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(action, extra = {}) {
  const response = await fetch('/api/demo/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, action, ...extra }) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  state = result;
}
function followLatestEvents() {
  document.querySelectorAll('.event-list').forEach(list => { list.scrollTop = list.scrollHeight; });
}
window.addEventListener('resize', followLatestEvents);
const labels = { success: 'ERP accepted', human: 'Needs a person', failure: 'ERP rejected' };
function render() {
  $('#mode').value = mode;
  $('#mode').disabled = busy;
  $('#mode option[value="live"]').disabled = !state.sandboxAvailable;
  $('#mode-note').textContent = mode === 'fixture' ? 'OFFLINE REHEARSAL · Events stay on this computer. Nothing is sent to Metronome.' : `SANDBOX · Successful orders send real test events to Metronome. ${state.orders.filter(o => o.result === 'success').length} outcomes per customer. Existing monthly usage and prepaid consumption are retained.`;
  $('#run').disabled = busy || state.completed === state.orders.length;
  $('#run').innerHTML = busy ? 'Processing orders…' : state.completed === state.orders.length ? 'Batch complete ✓' : state.completed ? 'Continue batch →' : 'Run order batch →';
  $('#replay').disabled = busy;
  $('#verify').disabled = busy || mode !== 'live';
  const openEvents = new Set([...document.querySelectorAll('details.event[open]')].map(row => row.dataset.eventId));
  const flow = c => `<section class="panel flow" aria-label="${esc(c.name)} orders"><div class="panel-head"><h2>${esc(c.name)}</h2><span class="contract-label">${esc(c.terms)}</span></div><div class="terms"><strong>${esc(c.rate)}</strong><span>${esc(c.detail)}</span></div>${state.completed || active >= 0 ? '<div class="order-heading"><span>Order processing</span><span>Autonomous agent</span></div>' : ''}<ol class="orders">${c.orders.slice(0, Math.max(state.completed, active + 1)).map((o,i) => {
    const done = i < state.completed;
    return `<li class="order ${done ? o.result : 'processing'}"><div><strong>${esc(o.displayId)}</strong><span>${esc(o.item)}</span></div><span class="status ${done ? o.result : ''}">${done ? `${o.result === 'success' ? '✓ ' : o.result === 'failure' ? '× ' : '↗ '}${esc(o.reason || labels[o.result])}` : esc(stage)}</span></li>`;
  }).join('')}</ol>${state.completed ? `<div class="flow-summary"><strong>${c.events.length} outcomes</strong><span>${state.completed - c.events.length} excluded</span></div>` : ''}</section>`;
  const events = c => {
    const checked = mode === 'live' ? state.check?.rows.find(row => row.key === c.key) : null;
    return `<section class="panel events" aria-label="${esc(c.name)} events"><div class="panel-head"><h2><span class="terminal-prompt" aria-hidden="true">›_</span> metronome / events</h2><span class="count" ${checked ? `title="Monthly count checked ${esc(state.check.at)}"` : ''}>${c.events.length} events${checked ? ` · month ${checked.outcomes}` : ''}</span></div><div class="event-list">${c.events.length ? c.events.map(r => `<details class="event" data-event-id="${esc(r.event.transaction_id)}" ${openEvents.has(r.event.transaction_id) ? 'open' : ''}><summary><strong>${esc(r.event.properties.order_id)}</strong><span class="event-type">${esc(r.event.event_type)}</span>${r.delivery === 'pending' ? '<span class="event-error" title="Delivery unconfirmed" aria-label="Delivery unconfirmed">!</span>' : ''}</summary><pre>${esc(JSON.stringify(r.event, null, 2))}</pre></details>`).join('') : '<p class="empty"><span aria-hidden="true">$</span> Waiting for qualifying outcomes<span class="cursor" aria-hidden="true">_</span></p>'}</div></section>`;
  };
  const orderScroll = [...document.querySelectorAll('.orders')].map(list => list.scrollTop);
  $('#panels').innerHTML = state.customers.map(flow).join('') + state.customers.map(events).join('');
  document.querySelectorAll('.orders').forEach((list, i) => { list.scrollTop = state.completed || active >= 0 ? orderScroll[i] || 0 : 0; });
  if (busy && (active >= 0 || state.completed)) {
    const index = active >= 0 ? active : state.completed - 1;
    document.querySelectorAll('.orders').forEach(list => {
      const row = list.children[index];
      if (row) list.scrollTop = Math.max(0, row.offsetTop + row.offsetHeight - list.clientHeight);
    });
  }
  // Keep new rows visible after replacing the log nodes and settling layout.
  followLatestEvents();
  requestAnimationFrame(followLatestEvents);
}
async function perform(fn) {
  busy = true; $('#notice').textContent = ''; render();
  try { await fn(); } catch (error) { $('#notice').textContent = error.message; }
  finally { active = -1; busy = false; render(); }
}
$('#run').addEventListener('click', () => perform(async () => {
  while (state.completed < state.orders.length) {
    active = state.completed;
    for (const text of (state.orders[active].result === 'human' ? ['Interpreting…', 'Matching catalog…'] : ['Interpreting…', 'Matching catalog…', 'Submitting to ERP…'])) { stage = text; render(); await sleep(600); }
    await request('next'); active = -1; render(); await sleep(250);
  }
}));
$('#replay').addEventListener('click', () => perform(async () => {
  await request('replay');
}));
$('#verify').addEventListener('click', () => perform(async () => { await request('verify'); }));
$('#mode').addEventListener('change', async event => {
  const previous = mode; mode = event.target.value;
  try { const res = await fetch(`/api/demo/state?mode=${mode}`); const data = await res.json(); if (!res.ok) throw Error(data.error); state = data; $('#notice').textContent = ''; }
  catch (error) { mode = previous; $('#notice').textContent = error.message; }
  render();
});
fetch('/api/demo/state').then(async res => { const data = await res.json(); if (!res.ok) throw Error(data.error); state = data; render(); }).catch(error => { $('#notice').textContent = error.message; $('#run').disabled = true; });
