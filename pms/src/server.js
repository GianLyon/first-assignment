import { config } from './config.js';
import { createPool, migrate } from './db.js';
import { createApp } from './app.js';
import { seedAll } from './seed.js';
import { processOutbox } from './services/distribution.js';
import { generateDue, processOutbox as sendEmails } from './services/reports.js';
import { queueGuestEmails } from './services/crm.js';
import { backupIfDue } from './backup.js';
import { tx } from './db.js';

const pool = createPool(config.databaseUrl);
const applied = await migrate(pool);
if (applied.length) console.log(`Migrations applied: ${applied.join(', ')}`);
if (config.autoSeed) {
  if (config.production && !process.env.ADMIN_PASSWORD) { console.error('AUTO_SEED needs ADMIN_PASSWORD in production.'); process.exit(1); }
  await seedAll(pool);
}
const server = createApp(pool).listen(config.port, () => console.log(`Azeli PMS running on http://localhost:${config.port}`));

// Push queued availability/rate changes to channels every ARI_PUSH_SECONDS (default 20; 0 = off)
const every = Number(process.env.ARI_PUSH_SECONDS ?? 20);
let pushing = false;
const timer = every > 0 ? setInterval(async () => {
  if (pushing) return; pushing = true;
  try { await processOutbox(pool); } catch (e) { console.error('Channel push failed:', e.message); } finally { pushing = false; }
}, every * 1000) : null;

// Scheduled reports: produce any that are due (after each night audit) and send queued emails, every minute
let mailing = false;
const mailTimer = setInterval(async () => {
  if (mailing) return; mailing = true;
  try { await tx(pool, (db) => generateDue(db)); await tx(pool, (db) => queueGuestEmails(db)); await backupIfDue(pool); await sendEmails(pool); } catch (e) { console.error('Report emails failed:', e.message); } finally { mailing = false; }
}, Number(process.env.REPORT_CHECK_SECONDS || 60) * 1000);

const shutdown = () => { if (timer) clearInterval(timer); clearInterval(mailTimer); server.close(() => pool.end().then(() => process.exit(0))); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
