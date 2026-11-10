import { config } from './config.js';
import { createPool, migrate } from './db.js';

const pool = createPool(config.databaseUrl);
const applied = await migrate(pool);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
await pool.end();
