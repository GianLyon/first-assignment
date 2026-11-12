// Set a new password for a Console user from the server's shell (Render → azeli-console → Shell):
//   node src/reset-password.js you@example.com
import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { config } from './config.js';
import { createPool } from './db.js';
import { hashPassword } from './auth.js';

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email) { console.error('Usage: node src/reset-password.js you@example.com'); process.exit(1); }
const rl = readline.createInterface({ input: stdin, terminal: false });
const lines = rl[Symbol.asyncIterator]();
const ask = async (q) => { stdout.write(q); const { value } = await lines.next(); return value ?? ''; };
const pw = await ask(`New password for ${email} (at least 10 characters): `);
const again = await ask('Type it again: ');
rl.close();
if (pw !== again) { console.error('The two passwords are different. Nothing was changed.'); process.exit(1); }
const pool = createPool(config.databaseUrl);
try {
  const { rows: [u] } = await pool.query('UPDATE users SET password_hash=$2, active=TRUE WHERE email=$1 RETURNING id', [email, await hashPassword(pw)]);
  if (!u) { console.error(`No user with the email ${email}.`); process.exit(1); }
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
  await pool.query("INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES (NULL, 'auth.password_reset_shell', 'user', $1)", [String(u.id)]);
  console.log(`Password changed for ${email}. Sign in with the new password.`);
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { await pool.end(); }
