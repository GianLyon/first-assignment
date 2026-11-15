// Authenticator-app codes (TOTP, RFC 6238: 6 digits, 30 seconds, SHA-1, as Google/Microsoft Authenticator use)
// and one-time recovery codes. No outside dependencies except the QR picture.
import crypto from 'node:crypto';
import QRCode from 'qrcode';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const c of clean) {
    const i = B32.indexOf(c); if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newSecret = () => base32Encode(crypto.randomBytes(20));

/** The code for one 30-second step. */
export function codeAt(secret, step, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}
export const stepNow = (ms = Date.now()) => Math.floor(ms / 30000);

/**
 * Check a code against the current step and one step either side (phone clocks drift).
 * Returns the matching step, or null. Steps at or before `lastStep` are refused, so a code works once.
 */
export function verifyCode(secret, code, lastStep = null, ms = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return null;
  const now = stepNow(ms);
  for (const s of [now, now - 1, now + 1]) {
    if (lastStep != null && s <= Number(lastStep)) continue;
    const exp = codeAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(c))) return s;
  }
  return null;
}

export function otpauthUrl(secret, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
export const qrSvg = (url) => QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0f2a2e', light: '#ffffff' } });

/* recovery codes: 10 one-time codes like 7KQ2-MX9D, only their hashes are stored */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normRecovery = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export function newRecoveryCodes(n = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes = Array.from({ length: n }, () => { const b = crypto.randomBytes(8); const s = [...b].map((x) => alphabet[x % alphabet.length]).join(''); return `${s.slice(0, 4)}-${s.slice(4)}`; });
  return { codes, hashes: codes.map((c) => sha(normRecovery(c))) };
}
/** Returns the remaining hashes if the code is one of them, otherwise null. */
export function useRecoveryCode(hashes, code) {
  const h = sha(normRecovery(code));
  if (normRecovery(code).length !== 8 || !hashes.includes(h)) return null;
  return hashes.filter((x) => x !== h);
}
export const hashToken = sha;
