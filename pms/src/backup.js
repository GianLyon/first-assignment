// Backups: the whole database as one encrypted file, stored off-site in S3-compatible storage (Cloudflare R2),
// and restored from such a file into an empty database (see src/restore-backup.js).
//
// File format: "AZBK1" | 12-byte IV | 16-byte GCM tag | AES-256-GCM( gzip( JSON ) )
// The key comes from BACKUP_KEY (any long passphrase; it is stretched with scrypt). Without the key a backup is unreadable,
// so keep the key somewhere safe outside Render as well (e.g. a password manager).
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { tx } from './db.js';

const gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);
const MAGIC = Buffer.from('AZBK1');
// never copied: sign-in sessions and half-finished sign-ins (they must not survive a restore)
const SKIP = new Set(['sessions', 'mfa_challenges']);

const keyFrom = (passphrase) => {
  if (!passphrase || String(passphrase).length < 16) throw new Error('BACKUP_KEY must be at least 16 characters.');
  return crypto.scryptSync(String(passphrase), 'azeli-backup-v1', 32);
};
export function encrypt(buf, passphrase) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keyFrom(passphrase), iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}
export function decrypt(file, passphrase) {
  if (!file.subarray(0, 5).equals(MAGIC)) throw new Error('This is not an Azeli backup file.');
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(passphrase), file.subarray(5, 17));
  d.setAuthTag(file.subarray(17, 33));
  try { return Buffer.concat([d.update(file.subarray(33)), d.final()]); } catch { throw new Error('Wrong backup key, or the file is damaged.'); }
}

async function tableList(db) {
  const { rows } = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  return rows.map((r) => r.tablename).filter((t) => !SKIP.has(t));
}

/** Everything in the database, as an encrypted file (Buffer). */
export async function createBackup(pool, passphrase) {
  return tx(pool, async (db) => {
    // one consistent snapshot of every table
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const tables = {};
    let rows = 0;
    for (const t of await tableList(db)) {
      const { rows: data, fields } = await db.query(`SELECT * FROM "${t}"`);
      tables[t] = { columns: fields.map((f) => f.name), rows: data.map((r) => fields.map((f) => r[f.name])) };
      rows += data.length;
    }
    const { rows: seqs } = await db.query("SELECT sequencename AS name, last_value FROM pg_sequences WHERE schemaname='public'");
    const { rows: [st] } = await db.query('SELECT property_name FROM settings WHERE id=1').catch(() => ({ rows: [{}] }));
    const doc = { format: 'azeli-pms-backup', version: 1, created_at: new Date().toISOString(), property: st?.property_name || null,
      migrations: (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name), sequences: seqs, tables };
    const file = encrypt(await gzip(Buffer.from(JSON.stringify(doc))), passphrase);
    return { file, tables: Object.keys(tables).length, rows };
  });
}

/**
 * Restore a backup into this database. The database must have been migrated to the same version.
 * Everything currently in it is replaced, in one transaction: if anything fails, nothing changes.
 */
export async function restoreBackup(pool, file, passphrase) {
  const doc = JSON.parse((await gunzip(decrypt(file, passphrase))).toString('utf8'));
  if (doc.format !== 'azeli-pms-backup') throw new Error('This is not an Azeli PMS backup.');
  return tx(pool, async (db) => {
    const have = (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
    if (JSON.stringify(have) !== JSON.stringify(doc.migrations)) {
      throw new Error(`The database version (${have.at(-1) || 'empty'}) differs from the backup's (${doc.migrations.at(-1)}). Use the same Azeli PMS version to restore.`);
    }
    const tables = (await tableList(db)).filter((t) => t !== 'schema_migrations');
    // the order to insert in: a table after the tables it points to
    const { rows: fks } = await db.query(`SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent, a.attname AS col
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum = ANY(c.conkey) WHERE c.contype='f' AND c.connamespace='public'::regnamespace`);
    const strip = (n) => n.replace(/^public\./, '').replace(/"/g, '');
    const deps = Object.fromEntries(tables.map((t) => [t, new Set()]));
    const selfRef = {};
    for (const f of fks) {
      const c = strip(f.child), p = strip(f.parent);
      if (!deps[c]) continue;
      if (c === p) (selfRef[c] ||= []).push(f.col); else deps[c].add(p);
    }
    const order = [], seen = new Set();
    const visit = (t) => { if (seen.has(t)) return; seen.add(t); for (const p of deps[t] || []) if (deps[p]) visit(p); order.push(t); };
    tables.forEach(visit);

    await db.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
    let rows = 0;
    for (const t of order) {
      const data = doc.tables[t];
      if (!data || !data.rows.length) continue;
      const later = selfRef[t] || [];
      const cols = data.columns;
      // jsonb and array columns come back as JS values; pg sends them correctly when given as JSON / arrays
      const { rows: types } = await db.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [t]);
      const jsonCols = new Set(types.filter((x) => x.data_type === 'jsonb' || x.data_type === 'json').map((x) => x.column_name));
      const batch = 200;
      for (let i = 0; i < data.rows.length; i += batch) {
        const chunk = data.rows.slice(i, i + batch), params = [];
        const values = chunk.map((r) => `(${cols.map((c, j) => {
          let v = r[j];
          if (later.includes(c)) v = null; // filled in below, once every row of the table exists
          else if (jsonCols.has(c) && v !== null) v = JSON.stringify(v);
          params.push(v); return `$${params.length}`;
        }).join(',')})`);
        await db.query(`INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES ${values.join(',')}`, params);
      }
      for (const c of later) {
        const ci = cols.indexOf(c), idi = cols.indexOf('id');
        for (const r of data.rows) if (r[ci] != null) await db.query(`UPDATE "${t}" SET "${c}"=$2 WHERE id=$1`, [r[idi], r[ci]]);
      }
      rows += data.rows.length;
    }
    for (const sq of doc.sequences || []) {
      if (sq.last_value != null) await db.query('SELECT setval($1, $2, true)', [`public."${sq.name}"`, sq.last_value]).catch(() => {});
    }
    return { property: doc.property, created_at: doc.created_at, tables: order.length, rows };
  });
}

/* ---------------- S3-compatible storage (Cloudflare R2, AWS S3, Backblaze B2…) ---------------- */
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** Upload with an AWS Signature Version 4 PUT. */
export async function putObject({ endpoint, bucket, accessKey, secretKey, region = 'auto' }, key, body, contentType = 'application/octet-stream') {
  const url = new URL(`${endpoint.replace(/\/+$/, '')}/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`);
  const now = new Date(), amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, ''), day = amzDate.slice(0, 8);
  const payloadHash = hex(body);
  const headers = { host: url.host, 'content-type': contentType, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const signed = Object.keys(headers).sort();
  const canonical = ['PUT', url.pathname, '', ...signed.map((h) => `${h}:${headers[h]}`), '', signed.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n');
  const kSig = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), 's3'), 'aws4_request');
  const signature = hmac(kSig, toSign).toString('hex');
  const res = await fetch(url, { method: 'PUT', body, signal: AbortSignal.timeout(120000),
    headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}` } });
  if (!res.ok) throw new Error(`Storage answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export const backupConfig = (env = process.env) => ({
  endpoint: env.BACKUP_S3_ENDPOINT || '', bucket: env.BACKUP_S3_BUCKET || '', accessKey: env.BACKUP_S3_ACCESS_KEY || '', secretKey: env.BACKUP_S3_SECRET_KEY || '',
  region: env.BACKUP_S3_REGION || 'auto', passphrase: env.BACKUP_KEY || '', hour: Number(env.BACKUP_HOUR ?? 3), alertEmail: env.BACKUP_ALERT_EMAIL || '',
});
export const storageReady = (c) => !!(c.endpoint && c.bucket && c.accessKey && c.secretKey);
const slug = (s) => String(s || 'property').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'property';

/**
 * Make a backup and store it: daily/<day of month> (a rolling month) and, on the 1st, monthly/<year-month> kept for good.
 * Records every attempt in backup_runs.
 */
export async function runBackup(pool, { trigger = 'manual', user = null, config = backupConfig() } = {}) {
  if (!config.passphrase) throw Object.assign(new Error('Backups are not set up: BACKUP_KEY is missing.'), { status: 409 });
  if (!storageReady(config)) throw Object.assign(new Error('Backups are not set up: the storage settings (BACKUP_S3_…) are missing.'), { status: 409 });
  const { rows: [run] } = await pool.query('INSERT INTO backup_runs (trigger, started_by) VALUES ($1,$2) RETURNING id', [trigger, user?.id ?? null]);
  try {
    const { file, tables, rows } = await createBackup(pool, config.passphrase);
    const { rows: [s] } = await pool.query("SELECT property_name, to_char(now() AT TIME ZONE 'Africa/Kampala','YYYY-MM-DD') AS today FROM settings WHERE id=1");
    const base = slug(s.property_name);
    const key = `${base}/daily/${s.today.slice(8)}.azbk`;
    await putObject(config, key, file);
    if (s.today.slice(8) === '01') await putObject(config, `${base}/monthly/${s.today.slice(0, 7)}.azbk`, file);
    await pool.query("UPDATE backup_runs SET status='ok', object_key=$2, size_bytes=$3, tables=$4, rows=$5, finished_at=now() WHERE id=$1", [run.id, key, file.length, tables, rows]);
    return { id: run.id, key, size: file.length, tables, rows };
  } catch (e) {
    await pool.query("UPDATE backup_runs SET status='failed', error=$2, finished_at=now() WHERE id=$1", [run.id, String(e.message).slice(0, 500)]);
    if (config.alertEmail) {
      await pool.query("INSERT INTO email_outbox (to_address, subject, html, text_body) VALUES ($1,$2,$3,$4)",
        [config.alertEmail, 'Azeli PMS: backup failed', `<p>Tonight's backup failed: ${String(e.message).replace(/[<>&]/g, '')}</p><p>Open Settings → Backups to try again.</p>`, `Tonight's backup failed: ${e.message}\nOpen Settings → Backups to try again.`]).catch(() => {});
    }
    throw e;
  }
}

/** Called every minute by the server: one scheduled backup a day, at BACKUP_HOUR Kampala time. */
export async function backupIfDue(pool, config = backupConfig()) {
  if (!config.passphrase || !storageReady(config)) return null;
  const { rows: [t] } = await pool.query("SELECT extract(hour FROM now() AT TIME ZONE 'Africa/Kampala')::int AS h, (now() AT TIME ZONE 'Africa/Kampala')::date AS d");
  if (t.h < config.hour) return null;
  const { rows: [done] } = await pool.query(`SELECT 1 FROM backup_runs WHERE trigger='scheduled' AND (started_at AT TIME ZONE 'Africa/Kampala')::date = $1
    AND (status='ok' OR status='running' OR (status='failed' AND started_at > now() - interval '1 hour')) LIMIT 1`, [t.d]);
  if (done) return null; // done today, running, or failed less than an hour ago (it retries hourly)
  return runBackup(pool, { trigger: 'scheduled', config }).catch((e) => { console.error('Backup failed:', e.message); return null; });
}
