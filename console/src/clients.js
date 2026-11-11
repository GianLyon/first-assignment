// Client hotels: is each one's Azeli PMS online, and how is it doing this month.
import { config } from './config.js';
import { HttpError } from './auth.js';

export function validUrl(v) {
  let u;
  try { u = new URL(String(v || '').trim()); } catch { throw new HttpError(400, 'Enter the hotel system\'s address, e.g. https://amaya.azelitech.com'); }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && !config.production)) throw new HttpError(400, 'The address must start with https://');
  if (u.username || u.password) throw new HttpError(400, 'The address cannot contain a user name or password.');
  return u.origin;
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Kampala' });
/** Check one client: health, then month-to-date totals with its group access key (when given). */
export async function checkClient(pool, id) {
  const { rows: [c] } = await pool.query('SELECT * FROM clients WHERE id=$1', [id]);
  if (!c) throw new HttpError(404, 'Client not found.');
  let status = 'online', summary = c.last_summary;
  try {
    const h = await fetch(new URL('/healthz', c.pms_url), { signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!h.ok) throw new Error(h.status === 503 ? 'The system is up but its database is not answering.' : `The system answered ${h.status}.`);
    if (c.group_token) {
      const to = today(), from = to.slice(0, 8) + '01';
      const r = await fetch(new URL(`/api/group/summary?from=${from}&to=${to}`, c.pms_url), { headers: { authorization: `Bearer ${c.group_token}` }, signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (r.status === 401) status = 'online, but the group access key was refused';
      else if (r.ok) summary = await r.json();
    }
  } catch (e) {
    status = e.name === 'TimeoutError' ? 'Not reachable (no answer within 8 seconds).' : e.message === 'fetch failed' || e.cause ? 'Not reachable. Check the address and that the system is running.' : String(e.message).slice(0, 200);
  }
  await pool.query('UPDATE clients SET last_check_at=now(), last_status=$2, last_summary=$3 WHERE id=$1', [id, status, summary]);
  return { status, summary };
}
