import { config } from './config.js';
import { createPool, migrate } from './db.js';
import { createApp } from './app.js';
import { processOutbox } from './services/distribution.js';

const pool = createPool(config.databaseUrl);
const applied = await migrate(pool);
if (applied.length) console.log(`Migrations applied: ${applied.join(', ')}`);
const server = createApp(pool).listen(config.port, () => console.log(`Hearth & Key PMS running on http://localhost:${config.port}`));

// Push queued availability/rate changes to channels every ARI_PUSH_SECONDS (default 20; 0 = off)
const every = Number(process.env.ARI_PUSH_SECONDS ?? 20);
let pushing = false;
const timer = every > 0 ? setInterval(async () => {
  if (pushing) return; pushing = true;
  try { await processOutbox(pool); } catch (e) { console.error('Channel push failed:', e.message); } finally { pushing = false; }
}, every * 1000) : null;

const shutdown = () => { if (timer) clearInterval(timer); server.close(() => pool.end().then(() => process.exit(0))); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
