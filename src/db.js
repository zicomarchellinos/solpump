'use strict';
// SQLite setup for solpump: coins (site registry for devnet SPL mints)
// and simulated bonding-curve trades.
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
`);

module.exports = db;
