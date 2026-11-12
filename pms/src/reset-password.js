// Set a new password for a PMS user from the server's shell (e.g. Render → azeli-pms → Shell):
//   node src/reset-password.js admin
// It asks for the new password (twice), reactivates the account and signs that user out everywhere.
import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { config } from './config.js';
import { createPool } from './db.js';
import { hashPassword } from './auth.js';

const username = (process.argv[2] || 'admin').toLowerCase();
const rl = readline.createInterface({ input: stdin, terminal: false });
const lines = rl[Symbol.asyncIterator]();
const ask = async (q) => { stdout.write(q); const { value } = await lines.next(); return value ?? ''; };
const pw = await ask(`New password for "${username}" (at least 8 characters): `);
const again = await ask('Type it again: ');
rl.close();
if (pw !== again) { console.error('The two passwords are different. Nothing was changed.'); process.exit(1); }
const pool = createPool(config.databaseUrl);
try {
  const hash = await hashPassword(pw);
  const { rows: [u] } = await pool.query('UPDATE users SET password_hash=$2, active=TRUE WHERE username=$1 RETURNING id', [username, hash]);
  if (!u) { console.error(`No user called "${username}".`); process.exit(1); }
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
  await pool.query("INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (NULL, 'auth.password_reset_shell', 'user', $1, '{}')", [String(u.id)]);
  console.log(`Password changed for "${username}". Sign in with the new password.`);
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { await pool.end(); }
