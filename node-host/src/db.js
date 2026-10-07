const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { DB_PATH } = require('./env');

const dbPath = DB_PATH || path.join(__dirname, '..', 'data', 'flashcards.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS decks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wrong_delay_minutes INTEGER NOT NULL DEFAULT 2,
    hard_delay_minutes INTEGER NOT NULL DEFAULT 2,
    easy_delay_minutes INTEGER NOT NULL DEFAULT 10,
    done_delay_minutes INTEGER NOT NULL DEFAULT 1440,
    lapse_delay_minutes INTEGER NOT NULL DEFAULT 10
  );

  CREATE TABLE IF NOT EXISTS deck_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    hanzi TEXT NOT NULL,
    pinyin TEXT NOT NULL,
    english TEXT NOT NULL,
    bucket TEXT NOT NULL DEFAULT 'remaining',
    easy_streak INTEGER NOT NULL DEFAULT 0,
    ready_at TEXT,
    phase TEXT NOT NULL DEFAULT 'learning',
    review_step INTEGER NOT NULL DEFAULT 0,
    interval_days REAL NOT NULL DEFAULT 0
  );
`);

const deckColumns = db.pragma('table_info(decks)');
if (!deckColumns.some((column) => column.name === 'wrong_delay_minutes')) {
  db.exec('ALTER TABLE decks ADD COLUMN wrong_delay_minutes INTEGER NOT NULL DEFAULT 2');
}

if (!deckColumns.some((column) => column.name === 'lapse_delay_minutes')) {
  db.exec('ALTER TABLE decks ADD COLUMN lapse_delay_minutes INTEGER NOT NULL DEFAULT 10');
}

const cardColumns = db.pragma('table_info(deck_cards)');
if (!cardColumns.some((column) => column.name === 'phase')) {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE deck_cards ADD COLUMN phase TEXT NOT NULL DEFAULT 'learning';
      ALTER TABLE deck_cards ADD COLUMN review_step INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE deck_cards ADD COLUMN interval_days REAL NOT NULL DEFAULT 0;
      -- Cards that had already been marked Easy/Done under the old fixed-interval scheme enter
      -- the review phase at the 1-day step, keeping their pending due time.
      UPDATE deck_cards SET phase = 'review', interval_days = 1, bucket = 'easy' WHERE bucket IN ('easy', 'done');
    `);
  })();
}

module.exports = db;
