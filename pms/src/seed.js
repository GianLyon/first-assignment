// First-time setup for a new property:  npm run seed
// Environment options: PROPERTY_NAME, ADMIN_USERNAME, ADMIN_PASSWORD, BUSINESS_DATE (YYYY-MM-DD).
// Creates the property settings, an admin account, a starter set of room types and rooms,
// and a starter restaurant/bar setup (outlets, menu, tables). Parts that already exist are left alone.
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

/** Starter restaurant & bar setup. Only runs when no outlets exist yet. */
export async function seedPos(pool) {
  return tx(pool, async (db) => {
    const { rows } = await db.query('SELECT 1 FROM outlets LIMIT 1');
    if (rows[0]) return { skipped: true };
    const outlets = {};
    for (const [name, kind] of [['Restaurant', 'restaurant'], ['Bar', 'bar'], ['Room Service', 'room_service']]) {
      outlets[name] = (await db.query('INSERT INTO outlets (name, kind) VALUES ($1,$2) RETURNING id', [name, kind])).rows[0].id;
    }
    const menu = [
      ['Breakfast', 'kitchen', [['Full breakfast', 35000], ['Rolex (chapati & egg roll)', 15000], ['Katogo (matoke & offals)', 25000]]],
      ['Mains', 'kitchen', [['Chicken luwombo', 45000], ['Whole grilled tilapia & chips', 55000], ['Beef fillet steak', 75000], ['Vegetable curry & rice', 35000], ['Goat stew with matoke', 40000]]],
      ['Desserts', 'kitchen', [['Tropical fruit platter', 15000], ['Chocolate cake', 18000]]],
      ['Soft drinks', 'bar', [['Soda', 4000], ['Bottled water', 3000], ['Fresh passion juice', 10000], ['Ugandan coffee', 8000]]],
      ['Beer & wine', 'bar', [['Local lager (500ml)', 8000], ['Glass of house wine', 25000], ['Bottle of house wine', 110000]]],
      ['Spirits & cocktails', 'bar', [['Cocktail of the day', 30000], ['Waragi & tonic', 15000]]],
    ];
    let sort = 0;
    for (const [cat, station, items] of menu) {
      const { rows: [c] } = await db.query('INSERT INTO menu_categories (name, station, sort) VALUES ($1,$2,$3) RETURNING id', [cat, station, sort += 10]);
      for (const [name, price] of items) await db.query('INSERT INTO menu_items (category_id, name, price) VALUES ($1,$2,$3)', [c.id, name, price]);
    }
    for (let i = 1; i <= 10; i++) await db.query('INSERT INTO dining_tables (outlet_id, name, seats) VALUES ($1,$2,$3)', [outlets.Restaurant, `T${i}`, i <= 6 ? 4 : 2]);
    for (let i = 1; i <= 6; i++) await db.query('INSERT INTO dining_tables (outlet_id, name, seats) VALUES ($1,$2,2)', [outlets.Bar, `B${i}`]);
    return { skipped: false };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool(config.databaseUrl);
  await migrate(pool);
  const r = await seedProperty(pool, {
    propertyName: process.env.PROPERTY_NAME, adminUsername: process.env.ADMIN_USERNAME,
    adminPassword: process.env.ADMIN_PASSWORD, businessDate: process.env.BUSINESS_DATE,
  });
  const p = await seedPos(pool);
  if (!p.skipped) console.log('Restaurant, bar and room service set up with a starter menu and tables.');
  if (r.skipped) console.log('Property settings already exist and were left unchanged.');
  else console.log(`Property created. Business date ${r.businessDate}.\nSign in as "${r.username}"${r.generated ? ` with password: ${r.password}\n(Change it after your first sign-in.)` : ' with the password you provided.'}`);
  await pool.end();
}
