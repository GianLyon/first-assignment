import { config } from './config.js';
import { createPool, migrate } from './db.js';
import { createApp } from './app.js';

const pool = createPool(config.databaseUrl);
const applied = await migrate(pool);
if (applied.length) console.log(`Migrations applied: ${applied.join(', ')}`);
const server = createApp(pool).listen(config.port, () => console.log(`Hearth & Key PMS running on http://localhost:${config.port}`));

const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
