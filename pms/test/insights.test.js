// Phase 17: the assistant for every department, and buying signals in WhatsApp.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer, stopTestServer, client, ok, typeId, DAY0, ctx } from './helpers.js';
import { analyse } from '../src/services/intent.js';

process.env.WHATSAPP_APP_SECRET = 'intent-secret';
let admin, fd, hk, acc;
const sign = (b) => 'sha256=' + crypto.createHmac('sha256', 'intent-secret').update(b).digest('hex');
const inbound = async (from, text, name = 'Lead') => {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, id: 'wamid.' + crypto.randomUUID(), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  const r = await fetch(ctx.base + '/api/whatsapp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
  assert.equal(r.status, 200);
};
const m = (body) => ({ direction: 'in', body, created_at: new Date().toISOString() });

before(async () => {
  await startTestServer({ pos: true, inventory: true, operations: true });
  admin = client(); await admin.login('admin', 'admin-pass-123');
  for (const [u, role] of [['fd1', 'front_office'], ['hk1', 'housekeeping'], ['acc1', 'accountant']]) ok(await admin.post('/api/users', { username: u, full_name: u, role, password: 'password-123' }));
  fd = client(); await fd.login('fd1', 'password-123');
  hk = client(); await hk.login('hk1', 'password-123');
  acc = client(); await acc.login('acc1', 'password-123');
});
after(stopTestServer);

test('intent: explorers, interested guests, buyers and guests ready to book are told apart', () => {
  const explorer = analyse([m('Hi, just checking what you offer. Where are you located?')]);
  assert.equal(explorer.stage, 'explorer');
  assert.ok(explorer.signals.some((s) => s.key === 'vague'));
  const interested = analyse([m('Hello, how much is a room per night?')]);
  assert.equal(interested.stage, 'interested');
  const buyer = analyse([m('Do you have a deluxe room available from 12th Dec for 3 nights? We are 2 adults. How much per night?')]);
  assert.equal(buyer.stage, 'buyer');
  assert.ok(buyer.depth >= 50);
  const ready = analyse([m('Do you have a deluxe room from 12th Dec for 3 nights? 2 adults.'), m('Great, I want to book it. Can I pay the deposit by mobile money?')]);
  assert.equal(ready.stage, 'ready');
  assert.ok(ready.score > buyer.score && ready.confidence > explorer.confidence);
  assert.ok(ready.first_purchase_signal_at);
  assert.ok(ready.signals.find((s) => s.key === 'pay').quote.includes('mobile money'));
  // outgoing messages do not count
  assert.equal(analyse([{ direction: 'out', body: 'Book now and pay by mobile money!', created_at: new Date().toISOString() }]).score, 0);
});

test('intent is worked out as messages arrive and shown in the inbox; hot leads have their own filter', async () => {
  await inbound('256700111222', 'Hi, just looking. Where are you?', 'Explorer Ed');
  await inbound('256700333444', 'Hello, do you have a twin room available this weekend for 2 people? How much?', 'Buyer Bea');
  let list = ok(await fd.get('/api/messages/conversations?filter=all')).conversations;
  const ed = list.find((c) => c.wa_id === '256700111222'), bea = list.find((c) => c.wa_id === '256700333444');
  assert.equal(ed.intent_stage, 'explorer');
  assert.equal(bea.intent_stage, 'buyer');
  // Bea asks to pay: she becomes ready to book, and the moment is kept
  await inbound('256700333444', 'Perfect, please book it. Send your mobile money number for the deposit.', 'Buyer Bea');
  const conv = ok(await fd.get(`/api/messages/conversations/${bea.id}`)).conversation;
  assert.equal(conv.intent_stage, 'ready');
  assert.ok(conv.intent_score >= 45 && conv.first_purchase_signal_at);
  assert.ok(conv.intent_signals.some((s) => s.key === 'book'));
  const hot = ok(await fd.get('/api/messages/conversations?filter=hot')).conversations.map((c) => c.wa_id);
  assert.deepEqual(hot, ['256700333444']);
});

test('department insights: each person sees their departments; problems are found', async () => {
  // stock: an item below its re-order level and one below zero
  const it = (await ctx.pool.query("SELECT id FROM stock_items WHERE active ORDER BY id LIMIT 2")).rows;
  const store = (await ctx.pool.query('SELECT id FROM stores ORDER BY id LIMIT 1')).rows[0].id;
  await ctx.pool.query('UPDATE stock_items SET reorder_level=50 WHERE id=$1', [it[0].id]);
  await ctx.pool.query('INSERT INTO stock_balances (item_id, store_id, qty) VALUES ($1,$2,5) ON CONFLICT (item_id, store_id) DO UPDATE SET qty=5', [it[0].id, store]);
  await ctx.pool.query('INSERT INTO stock_balances (item_id, store_id, qty) VALUES ($1,$2,-3) ON CONFLICT (item_id, store_id) DO UPDATE SET qty=-3', [it[1].id, store]);
  // the guest ledger is pushed out of line by a journal straight to it (the app refuses this; we simulate a bad import)
  const { rows: [je] } = await ctx.pool.query("INSERT INTO journal_entries (business_date, description) VALUES ($1, 'bad import') RETURNING id", [DAY0]);
  await ctx.pool.query("INSERT INTO journal_lines (entry_id, account_code, debit, credit) VALUES ($1,'1100',10000,0), ($1,'1030',0,10000)", [je.id]);
  // a staff record with gaps
  await ctx.pool.query("INSERT INTO employees (emp_no, first_name, last_name, department, job_title, start_date, basic_salary, pay_method) VALUES ('E900','Tom','Gaps','Kitchen','Cook',$1,500000,'bank')", [DAY0]).catch(() => {});
  const all = ok(await admin.get('/api/assistant/insights'));
  const d = Object.fromEntries(all.departments.map((x) => [x.key, x]));
  assert.deepEqual(Object.keys(d).sort(), ['finance', 'fnb', 'front_office', 'housekeeping', 'hr', 'management', 'marketing', 'procurement']);
  const find = (k, re) => d[k].items.find((i) => re.test(i.title));
  assert.match(find('finance', /Guest ledger does not match/).detail, /difference UGX 10,000/);
  assert.ok(find('procurement', /running low/));
  assert.ok(find('procurement', /less than zero/));
  assert.ok(find('marketing', /ready to book/)); // Bea
  if ((await ctx.pool.query("SELECT 1 FROM employees WHERE emp_no='E900'")).rows[0]) assert.match(find('hr', /missing details/).detail, /Tom Gaps: NIN, TIN, NSSF no\./);
  // management collects the urgent ones from every department
  assert.ok(d.management.items.some((i) => /^Sales & marketing: /.test(i.title)));
  // a receptionist sees front office (and marketing through WhatsApp? no: only what their rights allow)
  const fdKeys = ok(await fd.get('/api/assistant/insights')).departments.map((x) => x.key);
  assert.ok(fdKeys.includes('front_office') && fdKeys.includes('housekeeping') && !fdKeys.includes('finance') && !fdKeys.includes('hr'));
  assert.ok(ok(await acc.get('/api/assistant/insights')).departments.some((x) => x.key === 'finance'));
  assert.equal((await hk.get('/api/assistant/insights')).status, 403); // attendants have no assistant
});
