import { config } from './config.js';
import { createPool, migrate } from './db.js';
import { createApp } from './app.js';
import { hashPassword } from './auth.js';
import { checkClient } from './clients.js';

const pool = createPool(config.databaseUrl);
const applied = await migrate(pool);
if (applied.length) console.log(`Migrations applied: ${applied.join(', ')}`);

// first start: create the owner account from OWNER_EMAIL / OWNER_PASSWORD
const { rows: [n] } = await pool.query('SELECT count(*)::int AS n FROM users');
if (!n.n) {
  if (!config.ownerEmail || !config.ownerPassword) { console.error('Set OWNER_EMAIL and OWNER_PASSWORD to create the first owner account.'); process.exit(1); }
  await pool.query("INSERT INTO users (email, full_name, password_hash, role) VALUES ($1,$2,$3,'owner')", [config.ownerEmail, config.ownerName, await hashPassword(config.ownerPassword)]);
  console.log(`Owner account created for ${config.ownerEmail}.`);
}

const server = createApp(pool).listen(config.port, () => console.log(`Azeli Console running on http://localhost:${config.port}`));

// check every client hotel's system every 10 minutes
const timer = setInterval(async () => {
  try {
    const { rows } = await pool.query("SELECT id FROM clients WHERE status IN ('active','setup')");
    for (const r of rows) await checkClient(pool, r.id).catch(() => {});
  } catch (e) { console.error('Client checks failed:', e.message); }
}, 10 * 60e3);
const shutdown = () => { clearInterval(timer); server.close(() => pool.end().then(() => process.exit(0))); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
