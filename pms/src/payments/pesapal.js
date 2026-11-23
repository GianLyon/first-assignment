// Pesapal (pesapal.com), API 3.0: cards (Visa, Mastercard) and mobile money (MTN, Airtel) for East Africa.
//
//   1. RequestToken         consumer key + secret → a short-lived bearer token (cached until it expires)
//   2. RegisterIPN          our notification address (once; the id is kept in settings)
//   3. SubmitOrderRequest   amount, currency, our reference (the payment's token) → Pesapal's payment page
//   4. the guest pays on Pesapal's page; Pesapal calls our IPN address (GET, with OrderTrackingId) and sends the
//      guest back to our return page
//   5. GetTransactionStatus we never trust the call itself: we ask Pesapal for the status and amount and only then
//      record the payment
//
// Keys (hosting settings): PESAPAL_CONSUMER_KEY, PESAPAL_CONSUMER_SECRET, PESAPAL_ENV = sandbox | live (default
// sandbox). PESAPAL_BASE overrides the address (used by the tests). PUBLIC_URL must be the hotel's public address.
const env = process.env;
const BASES = { live: 'https://pay.pesapal.com/v3', sandbox: 'https://cybqa.pesapal.com/pesapalv3' };
export const pesapalEnv = () => (env.PESAPAL_ENV === 'live' ? 'live' : 'sandbox');
export const pesapalBase = () => (env.PESAPAL_BASE || BASES[pesapalEnv()]).replace(/\/+$/, '');
export const pesapalConfigured = () => !!(env.PESAPAL_CONSUMER_KEY && env.PESAPAL_CONSUMER_SECRET);
const publicUrl = () => (env.PUBLIC_URL || '').replace(/\/+$/, '');

let cached = null; // { token, until, key }

async function request(method, path, body, auth = true) {
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${await token()}`;
  const res = await fetch(pesapalBase() + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  const err = data?.error && (data.error.message || data.error.code || (typeof data.error === 'string' ? data.error : null));
  if (!res.ok || err) throw new Error(`Pesapal: ${String(err || data?.message || res.statusText || res.status).slice(0, 200)}`);
  return data;
}

async function token() {
  const key = env.PESAPAL_CONSUMER_KEY;
  if (cached && cached.key === key && cached.until > Date.now()) return cached.token;
  if (!pesapalConfigured()) throw new Error('Pesapal keys are not set in the hosting settings.');
  const d = await request('POST', '/api/Auth/RequestToken', { consumer_key: key, consumer_secret: env.PESAPAL_CONSUMER_SECRET }, false);
  if (!d.token) throw new Error('Pesapal did not return a token. Check the consumer key and secret.');
  const exp = Date.parse(d.expiryDate || '');
  cached = { token: d.token, key, until: Math.min(Number.isFinite(exp) ? exp : Infinity, Date.now() + 4 * 60e3) - 30e3 };
  return d.token;
}

export const ipnUrl = () => `${publicUrl()}/api/payments/pesapal/ipn`;

/** The id of our notification address at Pesapal: reused while the address is unchanged, else looked up or registered. */
async function ipnId(db) {
  const url = ipnUrl();
  const { rows: [s] } = await db.query('SELECT pesapal_ipn_id, pesapal_ipn_url FROM settings WHERE id=1');
  if (s.pesapal_ipn_id && s.pesapal_ipn_url === url) return s.pesapal_ipn_id;
  let id = null;
  try {
    const list = await request('GET', '/api/URLSetup/GetIpnList');
    id = (Array.isArray(list) ? list : []).find((x) => x.url === url && (x.ipn_status === undefined || x.ipn_status === 1 || /active/i.test(x.ipn_status_description || 'active')))?.ipn_id || null;
  } catch { /* fall through to registering */ }
  if (!id) id = (await request('POST', '/api/URLSetup/RegisterIPN', { url, ipn_notification_type: 'GET' })).ipn_id;
  if (!id) throw new Error('Pesapal did not return a notification id.');
  await db.query('UPDATE settings SET pesapal_ipn_id=$1, pesapal_ipn_url=$2 WHERE id=1', [id, url]);
  return id;
}

const country = (phone) => (/^\+?254/.test(phone || '') ? 'KE' : /^\+?255/.test(phone || '') ? 'TZ' : /^\+?250/.test(phone || '') ? 'RW' : 'UG');

export const pesapal = {
  label: 'Pesapal (Visa, Mastercard, MTN and Airtel mobile money)',
  configured: pesapalConfigured,
  mode: () => pesapalEnv(),
  /** Start a payment: returns Pesapal's page for the guest and Pesapal's tracking id. */
  async createCheckout(intent, ctx) {
    if (!publicUrl().startsWith('https://') && !env.PESAPAL_BASE) throw new Error('PUBLIC_URL must be the hotel\'s https address for Pesapal.');
    const g = ctx.guest || {};
    const order = await request('POST', '/api/Transactions/SubmitOrderRequest', {
      id: intent.token,
      currency: ctx.currency || 'UGX',
      amount: Number(intent.amount),
      description: `${ctx.property || 'Hotel'} booking ${ctx.code}`.slice(0, 100),
      callback_url: `${publicUrl()}/pay/return.html?t=${encodeURIComponent(intent.token)}`,
      cancellation_url: `${publicUrl()}/book/?cancelled=${encodeURIComponent(ctx.code)}`,
      notification_id: await ipnId(ctx.db),
      billing_address: {
        email_address: g.email || '', phone_number: String(g.phone || '').replace(/[^\d+]/g, ''), country_code: country(g.phone),
        first_name: String(g.first_name || '').slice(0, 50), last_name: String(g.last_name || '').slice(0, 50),
      },
    });
    if (!order.redirect_url || !order.order_tracking_id) throw new Error('Pesapal did not return a payment page.');
    return { checkout_url: order.redirect_url, provider_ref: order.order_tracking_id };
  },
  /** Ask Pesapal what happened to a payment. */
  async checkStatus(intent) {
    if (!intent.provider_ref) return { status: 'pending' };
    const d = await request('GET', `/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(intent.provider_ref)}`);
    const code = Number(d.status_code), desc = String(d.payment_status_description || '').toLowerCase();
    const status = code === 1 || desc === 'completed' ? 'paid' : code === 2 || desc === 'failed' ? 'failed' : code === 3 || desc === 'reversed' ? 'reversed' : 'pending';
    const pm = String(d.payment_method || '');
    return {
      status, amount: Number(d.amount), currency: String(d.currency || '').toUpperCase(), reference: d.merchant_reference,
      provider_ref: intent.provider_ref, confirmation: d.confirmation_code || null, payment_method: pm,
      method: /mpesa|mtn|airtel|mobile|momo|tigo|vodacom|mpamba/i.test(pm) ? 'mobile_money' : 'card',
    };
  },
};
