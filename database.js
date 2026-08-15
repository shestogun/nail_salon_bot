const { sql } = require('@vercel/postgres');

// Vercel Postgres auto-connects via env vars
// VERCEL_POSTGRES_URL, VERCEL_POSTGRES_PRISMA_URL, etc.

async function initTables() {
  try {
    await sql`
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
    `;
    
    await sql`
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
    `;
    
    await sql`
      CREATE TABLE IF NOT EXISTS manual_slots (
        id SERIAL PRIMARY KEY,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        type TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(date, time, type)
      );
    `;
    
    await sql`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        chat_id INTEGER UNIQUE NOT NULL
      );
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS user_states (
        chat_id INTEGER PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `;

    console.log('✅ DB tables initialized');
  } catch (e) {
    console.error('❌ DB init error:', e.message);
  }
}

async function getClientByChatId(chatId) {
  const res = await sql`SELECT * FROM clients WHERE chat_id = ${chatId}`;
  return res.rows[0] || null;
}

async function upsertClient(chatId, message) {
  const { first_name, last_name, username } = message.from || {};
  
  const existing = await getClientByChatId(chatId);
  
  if (existing) {
    await sql`
      UPDATE clients SET 
        first_name = ${first_name || ''}, 
        last_name = ${last_name || ''}, 
        username = ${username || ''}, 
        updated_at = NOW() 
      WHERE chat_id = ${chatId}
    `;
  } else {
    await sql`
      INSERT INTO clients (chat_id, first_name, last_name, username) 
      VALUES (${chatId}, ${first_name || ''}, ${last_name || ''}, ${username || ''})
    `;
  }
  return await getClientByChatId(chatId);
}

async function getBookingsByClientId(clientId) {
  const res = await sql`
    SELECT * FROM bookings 
    WHERE client_id = ${clientId} AND status = 'confirmed'
    ORDER BY date ASC, time ASC
  `;
  return res.rows;
}

async function getBookingById(id) {
  const res = await sql`SELECT * FROM bookings WHERE id = ${id}`;
  return res.rows[0] || null;
}

async function getBookingsByDate(date) {
  const res = await sql`
    SELECT b.*, c.first_name, c.last_name, c.phone, c.chat_id
    FROM bookings b 
    JOIN clients c ON b.client_id = c.id 
    WHERE b.date = ${date} AND b.status = 'confirmed'
    ORDER BY b.time ASC
  `;
  return res.rows;
}

async function addBooking(clientId, service, duration, breakAfter, date, time) {
  const res = await sql`
    INSERT INTO bookings (client_id, service, service_duration, break, date, time) 
    VALUES (${clientId}, ${service}, ${duration}, ${breakAfter}, ${date}, ${time})
    RETURNING id
  `;
  return res.rows[0].id;
}

async function updateBookingStatus(id, status) {
  await sql`
    UPDATE bookings SET status = ${status}, updated_at = NOW() WHERE id = ${id}
  `;
}

async function getBlockedSlotsForDate(date) {
  const res = await sql`SELECT time FROM manual_slots WHERE date = ${date} AND type = 'blocked' AND active = 1`;
  return res.rows.map(r => r.time);
}

async function getFreeSlotsForDate(date) {
  const res = await sql`SELECT time FROM manual_slots WHERE date = ${date} AND type = 'free' AND active = 1`;
  return res.rows.map(r => r.time);
}

async function addManualSlot(date, time, type) {
  await sql`
    INSERT INTO manual_slots (date, time, type) 
    VALUES (${date}, ${time}, ${type})
    ON CONFLICT (date, time, type) DO UPDATE SET active = 1
  `;
}

async function removeManualSlot(date, time) {
  await sql`DELETE FROM manual_slots WHERE date = ${date} AND time = ${time}`;
}

async function addAdminUser(chatId) {
  await sql`INSERT INTO admin_users (chat_id) VALUES (${chatId}) ON CONFLICT (chat_id) DO NOTHING`;
}

async function isAdmin(chatId) {
  const res = await sql`SELECT * FROM admin_users WHERE chat_id = ${chatId}`;
  return res.rows.length > 0;
}

async function getAllAdminChatIds() {
  const res = await sql`SELECT chat_id FROM admin_users`;
  return res.rows.map(r => r.chat_id);
}

async function setUserState(chatId, state) {
  const data = JSON.stringify(state);
  await sql`
    INSERT INTO user_states (chat_id, data)
    VALUES (${chatId}, ${data})
    ON CONFLICT (chat_id) DO UPDATE SET data = ${data}, updated_at = NOW()
  `;
}

async function getUserState(chatId) {
  const res = await sql`SELECT * FROM user_states WHERE chat_id = ${chatId}`;
  return res.rows[0] || null;
}

async function deleteUserState(chatId) {
  await sql`DELETE FROM user_states WHERE chat_id = ${chatId}`;
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
