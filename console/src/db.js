import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// BIGINT (money) and COUNT come back as strings by default; values stay well below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// Keep DATE columns as 'YYYY-MM-DD' strings so business dates never shift with time zones.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => Number(v)); // NUMERIC

export function createPool(connectionString) {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Run fn inside a transaction; rolls back on any error. */
export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Apply any .sql migrations that have not run yet, in file-name order. */
export async function migrate(pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await tx(pool, async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}
