'use strict';
// SQLite setup for solpump: coins (site registry for devnet SPL mints),
// real devnet bonding-curve trades (both on-chain legs recorded), and the
// server pool wallet secret (meta table, devnet only).
// Database file: data/solpump.db (created on first run).
// The feed starts EMPTY by design: coins only appear after a real,
// on-chain-verified devnet mint is registered.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'solpump.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS coins (
    mint_address TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ticker TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    logo_url TEXT,
    creator_wallet TEXT NOT NULL,
    tx_signature TEXT NOT NULL,
    sol_reserve REAL NOT NULL DEFAULT 30,
    token_reserve REAL NOT NULL DEFAULT 800000000,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint_address TEXT NOT NULL REFERENCES coins(mint_address),
    wallet TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    sol_amount REAL NOT NULL,
    token_amount REAL NOT NULL,
    price REAL NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades (mint_address, created_at);
  CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades (wallet, created_at);

  -- Key/value store: currently holds the pool wallet secret (base64).
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Trades whose first (user) leg confirmed on-chain but whose second
  -- (pool) leg failed: kept for transparency, never counted as trades.
  CREATE TABLE IF NOT EXISTS failed_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint_address TEXT NOT NULL,
    wallet TEXT NOT NULL,
    side TEXT NOT NULL,
    sol_amount REAL NOT NULL,
    token_amount REAL NOT NULL,
    user_tx_signature TEXT NOT NULL,
    error TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Lightweight migrations for databases created before these columns existed.
function hasColumn(table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
}
if (!hasColumn('coins', 'trading_enabled')) {
  db.exec('ALTER TABLE coins ADD COLUMN trading_enabled INTEGER NOT NULL DEFAULT 0');
}
if (!hasColumn('coins', 'funding_tx_signature')) {
  db.exec('ALTER TABLE coins ADD COLUMN funding_tx_signature TEXT');
}
if (!hasColumn('trades', 'user_tx_signature')) {
  db.exec('ALTER TABLE trades ADD COLUMN user_tx_signature TEXT');
}
if (!hasColumn('trades', 'pool_tx_signature')) {
  db.exec('ALTER TABLE trades ADD COLUMN pool_tx_signature TEXT');
}
// Replay protection: one user transaction can only settle one trade.
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_user_sig ON trades (user_tx_signature) WHERE user_tx_signature IS NOT NULL'
);

module.exports = db;
