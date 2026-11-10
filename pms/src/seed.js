// First-time setup for a new property:  npm run seed
// Environment options: PROPERTY_NAME, ADMIN_USERNAME, ADMIN_PASSWORD, BUSINESS_DATE (YYYY-MM-DD).
// Creates the property settings, an admin account and a starter set of room types and rooms.
import crypto from 'node:crypto';
import { config } from './config.js';
import { createPool, migrate, tx } from './db.js';
import { hashPassword } from './auth.js';

export async function seedProperty(pool, opts = {}) {
  return tx(pool, async (db) => {
    const { rows } = await db.query('SELECT 1 FROM settings');
    if (rows[0]) return { skipped: true };
    const today = opts.businessDate || new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Kampala' });
    await db.query('INSERT INTO settings (property_name, business_date) VALUES ($1, $2)', [opts.propertyName || 'My Hotel', today]);
    const password = opts.adminPassword || crypto.randomBytes(9).toString('base64url');
    const username = (opts.adminUsername || 'admin').toLowerCase();
    await db.query("INSERT INTO users (username, full_name, password_hash, role) VALUES ($1, 'Administrator', $2, 'admin')", [username, await hashPassword(password)]);
    const types = opts.roomTypes || [
      { code: 'STD', name: 'Standard Room', rate: 250000, rooms: ['101', '102', '103', '104', '105', '106', '107', '108', '109', '110'], floor: '1' },
      { code: 'DLX', name: 'Deluxe Room', rate: 350000, rooms: ['201', '202', '203', '204', '205', '206', '207', '208', '209', '210'], floor: '2' },
      { code: 'STE', name: 'Executive Suite', rate: 550000, rooms: ['301', '302', '303', '304'], floor: '3' },
    ];
    for (const t of types) {
      const { rows: [rt] } = await db.query('INSERT INTO room_types (code, name, base_rate) VALUES ($1,$2,$3) RETURNING id', [t.code, t.name, t.rate]);
      for (const n of t.rooms) await db.query('INSERT INTO rooms (number, room_type_id, floor) VALUES ($1,$2,$3)', [n, rt.id, t.floor]);
    }
    return { skipped: false, username, password, generated: !opts.adminPassword, businessDate: today };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool(config.databaseUrl);
  await migrate(pool);
  const r = await seedProperty(pool, {
    propertyName: process.env.PROPERTY_NAME, adminUsername: process.env.ADMIN_USERNAME,
    adminPassword: process.env.ADMIN_PASSWORD, businessDate: process.env.BUSINESS_DATE,
  });
  if (r.skipped) console.log('Property already set up. Nothing changed.');
  else console.log(`Property created. Business date ${r.businessDate}.\nSign in as "${r.username}"${r.generated ? ` with password: ${r.password}\n(Change it after your first sign-in.)` : ' with the password you provided.'}`);
  await pool.end();
}
