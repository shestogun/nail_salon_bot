// Адаптер БД: better-sqlite3 (локально) или @vercel/postgres (Vercel)
const USE_POSTGRES = process.env.DATABASE_URL && !process.env.BETTER_SQLITE3;

let db;

if (USE_POSTGRES) {
  const { sql } = require('@vercel/postgres');
  db = { type: 'postgres', sql };
} else {
  const Database = require('better-sqlite3');
  const path = require('path');
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../nail-salon.db');
  db = { type: 'sqlite', db: new Database(DB_PATH) };
  db.db.pragma('journal_mode = WAL');
}

module.exports = db;
