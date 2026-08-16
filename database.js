const { Pool } = require('@neondatabase/serverless');

const pool = new Pool({ connectionString: process.env.VERCEL_POSTGRES_URL });

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// Vercel Postgres auto-connects via env vars
// VERCEL_POSTGRES_URL, VERCEL_POSTGRES_PRISMA_URL, etc.

async function initTables() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        chat_id INTEGER UNIQUE NOT NULL,
        first_name TEXT DEFAULT '',
        last_name TEXT DEFAULT '',
        username TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    await query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        service TEXT NOT NULL,
        service_duration INTEGER NOT NULL,
        break INTEGER DEFAULT 15,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        status TEXT DEFAULT 'confirmed',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    await query(`
      CREATE TABLE IF NOT EXISTS manual_slots (
        id SERIAL PRIMARY KEY,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        type TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(date, time, type)
      );
    `);
    
    await query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        chat_id INTEGER UNIQUE NOT NULL
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS user_states (
        chat_id INTEGER PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('✅ DB tables initialized');
  } catch (e) {
    console.error('❌ DB init error:', e.message);
  }
}

async function getClientByChatId(chatId) {
  const res = await query('SELECT * FROM clients WHERE chat_id = $1', [chatId]);
  return res.rows[0] || null;
}

async function upsertClient(chatId, message) {
  const { first_name, last_name, username } = message.from || {};
  
  const existing = await getClientByChatId(chatId);
  
  if (existing) {
    await query(
      'UPDATE clients SET first_name = $1, last_name = $2, username = $3, updated_at = NOW() WHERE chat_id = $4',
      [first_name || '', last_name || '', username || '', chatId]
    );
  } else {
    await query(
      'INSERT INTO clients (chat_id, first_name, last_name, username) VALUES ($1, $2, $3, $4)',
      [chatId, first_name || '', last_name || '', username || '']
    );
  }
  return await getClientByChatId(chatId);
}

async function getBookingsByClientId(clientId) {
  const res = await query(
    'SELECT * FROM bookings WHERE client_id = $1 AND status = $2 ORDER BY date ASC, time ASC',
    [clientId, 'confirmed']
  );
  return res.rows;
}

async function getBookingById(id) {
  const res = await query('SELECT * FROM bookings WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getBookingsByDate(date) {
  const res = await query(
    'SELECT b.*, c.first_name, c.last_name, c.phone, c.chat_id FROM bookings b JOIN clients c ON b.client_id = c.id WHERE b.date = $1 AND b.status = $2 ORDER BY b.time ASC',
    [date, 'confirmed']
  );
  return res.rows;
}

async function addBooking(clientId, service, duration, breakAfter, date, time) {
  const res = await query(
    'INSERT INTO bookings (client_id, service, service_duration, break, date, time) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [clientId, service, duration, breakAfter, date, time]
  );
  return res.rows[0].id;
}

async function updateBookingStatus(id, status) {
  await query('UPDATE bookings SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);
}

async function getBlockedSlotsForDate(date) {
  const res = await query('SELECT time FROM manual_slots WHERE date = $1 AND type = $2 AND active = 1', [date, 'blocked']);
  return res.rows.map(r => r.time);
}

async function getFreeSlotsForDate(date) {
  const res = await query('SELECT time FROM manual_slots WHERE date = $1 AND type = $2 AND active = 1', [date, 'free']);
  return res.rows.map(r => r.time);
}

async function addManualSlot(date, time, type) {
  await query(
    'INSERT INTO manual_slots (date, time, type) VALUES ($1, $2, $3) ON CONFLICT (date, time, type) DO UPDATE SET active = 1',
    [date, time, type]
  );
}

async function removeManualSlot(date, time) {
  await query('DELETE FROM manual_slots WHERE date = $1 AND time = $2', [date, time]);
}

async function addAdminUser(chatId) {
  await query('INSERT INTO admin_users (chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING', [chatId]);
}

async function isAdmin(chatId) {
  const res = await query('SELECT * FROM admin_users WHERE chat_id = $1', [chatId]);
  return res.rows.length > 0;
}

async function getAllAdminChatIds() {
  const res = await query('SELECT chat_id FROM admin_users');
  return res.rows.map(r => r.chat_id);
}

async function setUserState(chatId, state) {
  const data = JSON.stringify(state);
  await query(
    'INSERT INTO user_states (chat_id, data) VALUES ($1, $2) ON CONFLICT (chat_id) DO UPDATE SET data = $2, updated_at = NOW()',
    [chatId, data]
  );
}

async function getUserState(chatId) {
  const res = await query('SELECT * FROM user_states WHERE chat_id = $1', [chatId]);
  return res.rows[0] || null;
}

async function deleteUserState(chatId) {
  await query('DELETE FROM user_states WHERE chat_id = $1', [chatId]);
}

module.exports = {
  initTables,
  getClientByChatId,
  upsertClient,
  getBookingsByClientId,
  getBookingById,
  getBookingsByDate,
  addBooking,
  updateBookingStatus,
  getBlockedSlotsForDate,
  getFreeSlotsForDate,
  addManualSlot,
  removeManualSlot,
  addAdminUser,
  isAdmin,
  getAllAdminChatIds,
  setUserState,
  getUserState,
  deleteUserState
};
