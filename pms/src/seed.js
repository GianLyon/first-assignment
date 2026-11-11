// First-time setup for a new property:  npm run seed
// Environment options: PROPERTY_NAME, ADMIN_USERNAME, ADMIN_PASSWORD, BUSINESS_DATE (YYYY-MM-DD).
// Creates the property settings, an admin account, a starter set of room types and rooms,
// a starter restaurant/bar setup (outlets, menu, tables) and starter stores, stock items, suppliers and
// recipes. Parts that already exist are left alone, so it is safe to run again after an upgrade.
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

/** Starter stores, stock items, suppliers and recipes. Only runs when no stores exist yet. */
export async function seedInventory(pool) {
  return tx(pool, async (db) => {
    const { rows } = await db.query('SELECT 1 FROM stores LIMIT 1');
    if (rows[0]) return { skipped: true };
    const st = {};
    for (const [name, kind] of [['Main store', 'main'], ['Kitchen', 'kitchen'], ['Bar', 'bar'], ['Housekeeping', 'housekeeping'], ['Maintenance', 'maintenance']]) {
      st[kind] = (await db.query('INSERT INTO stores (name, kind) VALUES ($1,$2) RETURNING id', [name, kind])).rows[0].id;
    }
    await db.query("UPDATE outlets SET stock_store_id=$1 WHERE kind IN ('restaurant','room_service') AND stock_store_id IS NULL", [st.kitchen]);
    await db.query("UPDATE outlets SET stock_store_id=$1 WHERE kind='bar' AND stock_store_id IS NULL", [st.bar]);
    const items = [
      ['CHK', 'Chicken', 'kg', 'Meat & fish', 10], ['BEEF', 'Beef fillet', 'kg', 'Meat & fish', 5], ['GOAT', 'Goat meat', 'kg', 'Meat & fish', 5], ['TIL', 'Tilapia (whole)', 'piece', 'Meat & fish', 15],
      ['RICE', 'Rice', 'kg', 'Dry goods', 20], ['FLOUR', 'Wheat flour', 'kg', 'Dry goods', 10], ['EGG', 'Eggs', 'piece', 'Dairy & eggs', 60], ['MATOKE', 'Matoke', 'bunch', 'Fruit & veg', 3],
      ['VEG', 'Fresh vegetables', 'kg', 'Fruit & veg', 15], ['POT', 'Potatoes', 'kg', 'Fruit & veg', 20], ['FRUIT', 'Fresh fruit', 'kg', 'Fruit & veg', 10], ['OIL', 'Cooking oil', 'litre', 'Dry goods', 10],
      ['COFFEE', 'Coffee beans', 'kg', 'Beverages', 2], ['LAGER', 'Local lager (500ml)', 'bottle', 'Beverages', 48], ['SODA', 'Soda (300ml)', 'bottle', 'Beverages', 48], ['WATER', 'Bottled water (500ml)', 'bottle', 'Beverages', 48],
      ['WINE', 'House wine', 'bottle', 'Beverages', 12], ['WARAGI', 'Waragi', 'litre', 'Beverages', 3], ['TONIC', 'Tonic water', 'bottle', 'Beverages', 24],
      ['SOAP', 'Guest soap', 'piece', 'Guest supplies', 100], ['TISSUE', 'Toilet rolls', 'piece', 'Guest supplies', 100], ['DETERG', 'Laundry detergent', 'kg', 'Cleaning', 10], ['BULB', 'LED bulbs', 'piece', 'Maintenance', 10],
    ];
    const id = {};
    for (const [code, name, unit, category, reorder] of items) id[code] = (await db.query('INSERT INTO stock_items (code, name, unit, category, reorder_level) VALUES ($1,$2,$3,$4,$5) RETURNING id', [code, name, unit, category, reorder])).rows[0].id;
    for (const [name, phone] of [['Kampala Fresh Produce Ltd', '+256 700 000 101'], ['Lake Victoria Fish Suppliers', '+256 700 000 102'], ['Nile Beverages Distributors', '+256 700 000 103'], ['City Hotel Supplies', '+256 700 000 104']]) {
      await db.query('INSERT INTO suppliers (name, phone) VALUES ($1,$2)', [name, phone]);
    }
    const recipes = {
      'Chicken luwombo': [['CHK', 0.4], ['VEG', 0.15], ['MATOKE', 0.1]], 'Whole grilled tilapia & chips': [['TIL', 1], ['POT', 0.3], ['OIL', 0.05]],
      'Beef fillet steak': [['BEEF', 0.3], ['POT', 0.2], ['VEG', 0.1]], 'Vegetable curry & rice': [['VEG', 0.35], ['RICE', 0.2]], 'Goat stew with matoke': [['GOAT', 0.35], ['MATOKE', 0.15]],
      'Rolex (chapati & egg roll)': [['FLOUR', 0.15], ['EGG', 2], ['OIL', 0.02]], 'Full breakfast': [['EGG', 2], ['POT', 0.15], ['FRUIT', 0.1], ['COFFEE', 0.02]], 'Tropical fruit platter': [['FRUIT', 0.4]],
      'Local lager (500ml)': [['LAGER', 1]], 'Soda': [['SODA', 1]], 'Bottled water': [['WATER', 1]], 'Glass of house wine': [['WINE', 0.2]], 'Bottle of house wine': [['WINE', 1]],
      'Waragi & tonic': [['WARAGI', 0.05], ['TONIC', 1]], 'Ugandan coffee': [['COFFEE', 0.02]], 'Fresh passion juice': [['FRUIT', 0.25]],
    };
    for (const [dish, lines] of Object.entries(recipes)) {
      const { rows: [m] } = await db.query('SELECT id FROM menu_items WHERE name=$1', [dish]);
      if (!m) continue;
      for (const [code, qty] of lines) await db.query('INSERT INTO recipe_lines (menu_item_id, item_id, qty) VALUES ($1,$2,$3)', [m.id, id[code], qty]);
    }
    return { skipped: false };
  });
}

/** Starter rate plans and a simulator channel. Only runs when no rate plans exist yet. */
export async function seedDistribution(pool) {
  return tx(pool, async (db) => {
    const { rows } = await db.query('SELECT 1 FROM rate_plans LIMIT 1');
    if (rows[0]) return { skipped: true };
    const plans = {};
    for (const [code, name, desc, disc, breakfast, refundable, minStay, sort] of [
      ['BAR', 'Best available rate', 'Flexible: free cancellation until the day before arrival. Breakfast included.', 0, true, true, 1, 10],
      ['NRF', 'Non-refundable saver', 'Save 10%. Pay in full; cannot be cancelled or changed. Breakfast included.', 10, true, false, 1, 20],
      ['LONG', 'Stay 3+ nights', 'Save 15% on stays of three nights or more. Breakfast included.', 15, true, true, 3, 30],
    ]) plans[code] = (await db.query('INSERT INTO rate_plans (code, name, description, discount_pct, breakfast, refundable, min_stay, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [code, name, desc, disc, breakfast, refundable, minStay, sort])).rows[0].id;
    const { rows: [c] } = await db.query("INSERT INTO channels (code, name, adapter, commission_pct, secret) VALUES ('simulator', 'OTA simulator', 'simulator', 15, $1) RETURNING id", [crypto.randomBytes(24).toString('base64url')]);
    const { rows: types } = await db.query('SELECT id, code FROM room_types');
    for (const t of types) for (const p of ['BAR', 'NRF']) await db.query('INSERT INTO channel_mappings (channel_id, room_type_id, rate_plan_id, external_room_code, external_rate_code) VALUES ($1,$2,$3,$4,$5)', [c.id, t.id, plans[p], t.code, p]);
    return { skipped: false };
  });
}

/** Standard shifts. Only runs when no shift templates exist yet. */
export async function seedHr(pool) {
  return tx(pool, async (db) => {
    const { rows } = await db.query('SELECT 1 FROM shift_templates LIMIT 1');
    if (rows[0]) return { skipped: true };
    for (const [code, name, st, en] of [['M', 'Morning', '07:00', '15:00'], ['E', 'Evening', '15:00', '23:00'], ['N', 'Night', '23:00', '07:00'], ['D', 'Day (office)', '08:00', '17:00']]) {
      await db.query('INSERT INTO shift_templates (code, name, start_time, end_time) VALUES ($1,$2,$3,$4)', [code, name, st, en]);
    }
    return { skipped: false };
  });
}

export async function seedOperations(pool) {
  return tx(pool, async (db) => {
    const { rows } = await db.query('SELECT 1 FROM function_rooms LIMIT 1');
    if (rows[0]) return { skipped: true };
    for (const [n, cap, full, half] of [['Nile Hall', 200, 2500000, 1500000], ['Boardroom', 16, 600000, 350000], ['Garden Terrace', 120, 1800000, 1000000]]) {
      await db.query('INSERT INTO function_rooms (name, capacity, hire_full_day, hire_half_day) VALUES ($1,$2,$3,$4)', [n, cap, full, half]);
    }
    for (const [n, pp, inc] of [['Half-day conference', 65000, 'Morning tea, lunch buffet, mineral water, projector and flip chart'],
      ['Full-day conference', 95000, 'Morning and afternoon tea, lunch buffet, mineral water, projector, PA system'],
      ['Wedding reception', 120000, 'Three-course buffet, soft drinks, cake table, décor package'],
      ['Cocktail evening', 55000, 'Canapés (6 pieces per guest), soft drinks']]) {
      await db.query('INSERT INTO event_packages (name, per_person, includes) VALUES ($1,$2,$3)', [n, pp, inc]);
    }
    for (const [n, c, p, d, desc] of [['Full body massage (60 min)', 'spa', 150000, 60, 'Swedish or deep tissue'], ['Facial (45 min)', 'spa', 120000, 45, null],
      ['Airport transfer (Entebbe)', 'transport', 180000, 90, 'One way, up to 3 guests'], ['Jinja day tour', 'tour', 350000, 480, 'Source of the Nile, per guest'],
      ['City tour (half day)', 'tour', 150000, 240, 'Per guest'], ['Laundry: wash & fold (per kg)', 'laundry', 15000, null, null],
      ['Pool day pass (non-resident)', 'leisure', 40000, null, null], ['Gym day pass (non-resident)', 'leisure', 30000, null, null]]) {
      await db.query('INSERT INTO amenities (name, category, price, duration_min, description) VALUES ($1,$2,$3,$4,$5)', [n, c, p, d, desc]);
    }
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
  await seedHr(pool);
  const ops = await seedOperations(pool);
  if (!ops.skipped) console.log('Function rooms, event packages and an amenities price list set up.');
  const dist = await seedDistribution(pool);
  if (!dist.skipped) console.log('Rate plans and a test (simulator) channel set up.');
  const inv = await seedInventory(pool);
  if (!inv.skipped) console.log('Stores, stock items, suppliers and recipes set up. Enter your opening stock under Purchasing.');
  if (r.skipped) console.log('Property settings already exist and were left unchanged.');
  else console.log(`Property created. Business date ${r.businessDate}.\nSign in as "${r.username}"${r.generated ? ` with password: ${r.password}\n(Change it after your first sign-in.)` : ' with the password you provided.'}`);
  await pool.end();
}
