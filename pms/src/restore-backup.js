// Restore an Azeli PMS backup file into this system's database (DATABASE_URL), replacing everything in it.
//   BACKUP_KEY=... node src/restore-backup.js path/to/azeli-backup-2026-11-13.azbk
// The database is first brought to this version of Azeli PMS; the backup must come from the same version.
import { readFile } from 'node:fs/promises';
import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { config } from './config.js';
import { createPool, migrate } from './db.js';
import { restoreBackup } from './backup.js';

const file = process.argv[2];
if (!file) { console.error('Usage: BACKUP_KEY=… node src/restore-backup.js <backup file>'); process.exit(1); }
if (!process.env.BACKUP_KEY) { console.error('Set BACKUP_KEY to the key the backup was made with.'); process.exit(1); }
const data = await readFile(file);
if (!process.argv.includes('--yes')) {
  const rl = readline.createInterface({ input: stdin, terminal: false }), lines = rl[Symbol.asyncIterator]();
  stdout.write('This REPLACES everything in this system with the backup. Type RESTORE to continue: ');
  const { value } = await lines.next(); rl.close();
  if (String(value || '').trim() !== 'RESTORE') { console.log('Nothing was changed.'); process.exit(1); }
}
const pool = createPool(config.databaseUrl);
try {
  await migrate(pool);
  const r = await restoreBackup(pool, data, process.env.BACKUP_KEY);
  console.log(`Restored ${r.property || 'the property'} from the backup of ${r.created_at}: ${r.tables} tables, ${r.rows} rows. Everyone must sign in again.`);
} catch (e) { console.error('Restore failed, nothing was changed:', e.message); process.exitCode = 1; } finally { await pool.end(); }
