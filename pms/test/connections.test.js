// Phase 21: checking the WhatsApp and AI connections from the set-up pages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { startTestServer, stopTestServer, client, ok, ctx } from './helpers.js';
import { resetClient } from '../src/services/assistant.js';

function fake(handler) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null }; calls.push(call);
      const [status, out] = handler(call);
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
  }).listen(0);
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close() };
}
const KEYS = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_API_BASE', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'];
let admin;
before(async () => { await startTestServer({}); admin = client(); await admin.login('admin', 'admin-pass-123'); });
after(async () => { for (const k of KEYS) delete process.env[k]; resetClient(); await stopTestServer(); });

test('WhatsApp: the connection check explains what is missing or wrong, and a test message goes out', async () => {
  // nothing set yet
  let r = ok(await admin.post('/api/messages/setup/check', {}));
  assert.match(r.error, /access token and phone number ID/);
  assert.equal(r.steps.find((s) => s.key === 'token').ok, false);
  const meta = fake((call) => {
    if (call.headers.authorization !== 'Bearer good-token') return [401, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } }];
    if (call.method === 'GET' && call.url.startsWith('/v25.0/11122233?')) return [400, { error: { message: "Unsupported get request. Object with ID '11122233' does not exist", code: 100, error_subcode: 33 } }];
    if (call.method === 'GET') return [200, { display_phone_number: '+256 772 000111', verified_name: 'Amaya Hotel', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', platform_type: 'CLOUD_API', name_status: 'APPROVED', id: '1098765' }];
    if (call.body?.template?.name === 'hello_world' && call.body.to === '256772555666') return [200, { messages: [{ id: 'wamid.TEST1' }] }];
    return [400, { error: { message: 'Recipient not in allowed list', code: 131030 } }];
  });
  try {
    Object.assign(process.env, { WHATSAPP_API_BASE: meta.url, WHATSAPP_TOKEN: 'bad-token', WHATSAPP_PHONE_NUMBER_ID: '1098765', WHATSAPP_APP_SECRET: 'app-secret-1', WHATSAPP_VERIFY_TOKEN: 'verify-me' });
    r = ok(await admin.post('/api/messages/setup/check', {}));
    assert.match(r.error, /access token is not valid/);
    process.env.WHATSAPP_PHONE_NUMBER_ID = '11122233'; process.env.WHATSAPP_TOKEN = 'good-token';
    r = ok(await admin.post('/api/messages/setup/check', {}));
    assert.match(r.error, /does not know that phone number ID/);
    process.env.WHATSAPP_PHONE_NUMBER_ID = '1098765';
    r = ok(await admin.post('/api/messages/setup/check', {}));
    assert.equal(r.error, null);
    assert.equal(r.number.name, 'Amaya Hotel'); assert.equal(r.number.quality, 'GREEN');
    assert.equal(r.steps.find((s) => s.key === 'webhook').ok, false); // nothing has arrived from Meta yet
    // a signed delivery from Meta is recorded
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const sig = 'sha256=' + crypto.createHmac('sha256', 'app-secret-1').update(body).digest('hex');
    const hook = await fetch(ctx.base + '/api/whatsapp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
    assert.equal(hook.status, 200);
    r = ok(await admin.post('/api/messages/setup/check', {}));
    assert.ok(r.last_webhook_at); assert.ok(r.steps.every((s) => s.ok));
    // test message: Meta's sample template to a local number written the local way
    const sent = ok(await admin.post('/api/messages/setup/test-message', { to: '0772 555 666' }));
    assert.equal(sent.to, '+256772555666'); assert.equal(sent.message_id, 'wamid.TEST1');
    const refused = await admin.post('/api/messages/setup/test-message', { to: '0772 000 999' });
    assert.equal(refused.status, 502); assert.match(refused.data.error, /test list/);
  } finally { meta.close(); for (const k of KEYS.slice(0, 5)) delete process.env[k]; }
});

test('AI: the connection test reports the model and cost, or the reason in plain words', async () => {
  let r = ok(await admin.post('/api/assistant/test', {}));
  assert.equal(r.ok, false); assert.match(r.error, /No Anthropic API key/);
  let mode = 'ok';
  const api = fake((call) => {
    if (mode === 'auth') return [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }];
    if (mode === 'credit') return [400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }];
    return [200, { id: 'msg_1', type: 'message', role: 'assistant', model: call.body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 25, output_tokens: 3 } }];
  });
  try {
    Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: api.url }); resetClient();
    r = ok(await admin.post('/api/assistant/test', {}));
    assert.equal(r.ok, true); assert.equal(r.reply, 'OK'); assert.equal(r.model, 'claude-opus-5-5'); assert.equal(r.input_tokens, 25);
    const call = api.calls.at(-1);
    assert.equal(call.body.model, 'claude-opus-5-5'); assert.equal(call.body.fallbacks, 'default'); assert.deepEqual(call.body.output_config, { effort: 'low' });
    mode = 'auth'; r = ok(await admin.post('/api/assistant/test', {}));
    assert.equal(r.ok, false); assert.match(r.error, /API key was refused/);
    mode = 'credit'; r = ok(await admin.post('/api/assistant/test', {}));
    assert.match(r.error, /no credit/);
    const { rows } = await ctx.pool.query("SELECT count(*)::int AS n FROM ai_usage WHERE kind='test'");
    assert.equal(rows[0].n, 3);
  } finally { api.close(); delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_BASE_URL; resetClient(); }
  // only administrators can run the tests
  ok(await admin.post('/api/users', { username: 'fd9', full_name: 'Front Desk', role: 'front_office', password: 'password-123' }));
  const fd = client(); await fd.login('fd9', 'password-123');
  assert.equal((await fd.post('/api/assistant/test', {})).status, 403);
  assert.equal((await fd.post('/api/messages/setup/check', {})).status, 403);
});
