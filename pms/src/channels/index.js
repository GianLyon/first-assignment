// Channel connectors. Each connector sends an availability/rate message to a channel.
//
//  simulator  Built-in test channel: accepts every message and keeps it in the channel log.
//             Use it to try the channel manager before connecting a real provider.
//  webhook    Sends the message as signed JSON to the channel's endpoint URL. This is how the PMS
//             connects to a certified channel-manager provider (or a small bridge service), which
//             then talks to Booking.com, Expedia, Airbnb and others.
//
// Signature: header X-HK-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the channel secret>.
// The same scheme is used for bookings the channel sends back to /api/channels/<code>/inbound.
import crypto from 'node:crypto';
import { config } from '../config.js';

const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

export function validateEndpoint(url) {
  let u;
  try { u = new URL(url); } catch { throw Object.assign(new Error('Endpoint URL is not valid.'), { status: 400 }); }
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && !config.production)) throw Object.assign(new Error('Endpoint URL must use https.'), { status: 400 });
  return u.toString();
}

export const adapters = {
  simulator: {
    label: 'Simulator (testing)',
    async push(_channel, message) { return { note: `simulator accepted ${message.items.length} updates` }; },
  },
  webhook: {
    label: 'Webhook (certified provider)',
    async push(channel, message) {
      if (!channel.endpoint_url) throw new Error('No endpoint URL set for this channel.');
      const body = JSON.stringify(message);
      const res = await fetch(validateEndpoint(channel.endpoint_url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hk-event': message.event, 'x-hk-signature': sign(channel.secret, body) },
        body, signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Channel responded ${res.status} ${res.statusText}`.trim());
      return { note: `HTTP ${res.status}` };
    },
  },
};
