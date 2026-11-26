// Hotel network only: when switched on, staff can use Azeli PMS only from the hotel's own internet connection
// (the hotel Wi-Fi and wired network all reach the internet through the same public address). The administrator,
// top management and anyone given an exemption can sign in from anywhere.
//
// "Allowed networks" are public IP addresses or ranges (CIDR), e.g. 41.210.140.17 or 41.210.140.0/28.
// The server sees the address the request came from (behind Render's proxy this needs TRUST_PROXY=1).
import { HttpError } from './auth.js';

/** An IP address as a big integer, or null. Handles IPv4, IPv6 and IPv4-mapped IPv6 (::ffff:1.2.3.4). */
function toBig(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const p = s.split('.').map(Number);
    if (p.some((n) => n > 255)) return null;
    return { v: 4, n: p.reduce((a, b) => (a << 8n) + BigInt(b), 0n) };
  }
  if (!/^[0-9a-f:]+$/.test(s) || !s.includes(':')) return null;
  const [head, tail] = s.split('::');
  if (s.split('::').length > 2) return null;
  const h = head ? head.split(':') : [], t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return { v: 6, n: groups.reduce((a, g) => (a << 16n) + BigInt(parseInt(g, 16)), 0n) };
}

/** Is this address inside one of the entries ("1.2.3.4", "1.2.3.0/24", "2001:db8::/48")? */
export function ipAllowed(ip, list) {
  const a = toBig(ip);
  if (!a) return false;
  for (const entry of list || []) {
    const [base, bits] = String(entry).trim().split('/');
    const b = toBig(base);
    if (!b || b.v !== a.v) continue;
    const size = a.v === 4 ? 32 : 128;
    const len = bits === undefined ? size : Number(bits);
    if (!Number.isInteger(len) || len < 0 || len > size) continue;
    const shift = BigInt(size - len);
    if ((a.n >> shift) === (b.n >> shift)) return true;
  }
  return false;
}

/** A tidy, valid list of network entries; throws on anything that is not an address or range. */
export function cleanNetworks(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)) {
    const e = String(raw).trim();
    if (!e) continue;
    const [base, bits] = e.split('/');
    const b = toBig(base);
    const size = b?.v === 4 ? 32 : 128;
    if (!b || (bits !== undefined && !(Number.isInteger(Number(bits)) && Number(bits) >= (b.v === 4 ? 8 : 16) && Number(bits) <= size))) {
      throw new HttpError(400, `"${e}" is not an internet address or range (e.g. 41.210.140.17 or 41.210.140.0/28).`);
    }
    if (!out.includes(e)) out.push(e);
  }
  if (out.length > 20) throw new HttpError(400, 'At most 20 networks.');
  return out;
}

const MSG = 'Azeli PMS only works on the hotel\'s Wi-Fi or network for your account. Connect to the hotel Wi-Fi and try again, or ask the general manager.';

/** Refuse a person who must be on the hotel network and is not. */
export function checkNetwork({ lock, allowed, exempt }, ip) {
  if (!lock || !allowed?.length || exempt) return;
  if (!ipAllowed(ip, allowed)) throw new HttpError(403, MSG, { code: 'network', ip: String(ip || '').replace(/^::ffff:/, '') });
}

/** Every signed-in request (except signing out): the same rule as at sign-in. */
export const networkGuard = (req, _res, next) => {
  const u = req.user;
  if (u && req.path !== '/auth/logout') checkNetwork({ lock: u.network_lock, allowed: u.allowed_networks, exempt: u.network_exempt || u.perms?.includes('*') }, req.ip);
  next();
};
