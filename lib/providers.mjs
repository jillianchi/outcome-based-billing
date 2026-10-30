export class ProviderError extends Error {
  constructor(status) { super(`Metronome request failed (${status}). Check the server-side sandbox configuration.`); }
}

export function requireMetronome(env = process.env) {
  if (!env.METRONOME_API_KEY || env.METRONOME_SANDBOX_CONFIRMED !== 'true') throw new Error('Metronome sandbox access has not been configured and confirmed.');
  if (!env.METRONOME_CUSTOMER_ID) throw new Error('Configure the fictional Metronome customer first.');
}

export async function metronome(endpoint, body, env = process.env) {
  requireMetronome(env);
  const response = await fetch(`https://api.metronome.com${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${env.METRONOME_API_KEY}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new ProviderError(response.status);
  if (response.status === 204) return null;
  const content = await response.text();
  return content ? JSON.parse(content) : null;
}

export async function usageCount(month, env = process.env) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Month must have YYYY-MM format.');
  if (!env.METRONOME_BILLABLE_METRIC_ID) throw new Error('Configure the COUNT billable metric ID to verify remote usage.');
  const start = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  const result = await metronome('/v1/usage', {
    starting_on: start.toISOString(), ending_before: end.toISOString(), window_size: 'NONE',
    customer_ids: [env.METRONOME_CUSTOMER_ID], billable_metrics: [{ id: env.METRONOME_BILLABLE_METRIC_ID }],
  }, env);
  if (result.next_page) throw new Error('Unexpected usage pagination for the single-customer demo.');
  const rows = result.data.filter(row => row.customer_id === env.METRONOME_CUSTOMER_ID && row.billable_metric_id === env.METRONOME_BILLABLE_METRIC_ID);
  const value = rows.reduce((n, row) => n + (row.value ?? 0), 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('The outcome metric is not an integer count.');
  return value;
}
