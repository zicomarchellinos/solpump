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
    sol_reserve REAL NOT NULL DEFAULT 55,
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

  -- Creator-fee claims: real devnet SOL the pool paid out to a coin's
  -- creator from accrued 1% trade fees (one row per claim, with the
  -- pool's payout transaction signature).
  CREATE TABLE IF NOT EXISTS fee_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint_address TEXT NOT NULL REFERENCES coins(mint_address),
    creator_wallet TEXT NOT NULL,
    amount_sol REAL NOT NULL,
    tx_signature TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_fee_claims_mint ON fee_claims (mint_address, created_at);

  -- Social follows, keyed by wallet address. A follow is only stored
  -- after the follower proves wallet ownership by signing a message
  -- (see src/signverify.js); a wallet cannot follow itself.
  CREATE TABLE IF NOT EXISTS follows (
    follower_wallet TEXT NOT NULL,
    following_wallet TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (follower_wallet, following_wallet)
  );

  CREATE INDEX IF NOT EXISTS idx_follows_following ON follows (following_wallet);

  -- Callouts: short trade calls (max 280 chars) attached to a coin. Only a
  -- wallet with a real BUY record for the coin may post one — verified
  -- server-side from the trades table. entry_price (average buy price) and
  -- holdings_at_post are computed server-side from real trades at posting
  -- time and never taken from the client; live PnL is derived from them
  -- against the current price at read time.
  CREATE TABLE IF NOT EXISTS callouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint_address TEXT NOT NULL REFERENCES coins(mint_address),
    wallet TEXT NOT NULL,
    text TEXT NOT NULL,
    entry_price REAL NOT NULL,
    holdings_at_post REAL NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_callouts_mint ON callouts (mint_address, created_at);
  CREATE INDEX IF NOT EXISTS idx_callouts_wallet ON callouts (wallet, created_at);

  -- Burns: real SPL burns (a holder destroys their own tokens via Phantom).
  -- Each burn is verified on-chain before recording, and reduces the coin's
  -- bonding-curve token_reserve by the burned amount — since price =
  -- sol_reserve / token_reserve, burning raises the price. price_after is
  -- the curve price right after the burn (for the chart). tx_signature is
  -- unique: one burn transaction can only be recorded once.
  -- Pool invariant: burned tokens belonged to the USER, not the pool, so
  -- the pool's on-chain token balance stays >= token_reserve after burns
  -- and trade pre-checks keep working (the pool ends up holding slightly
  -- more tokens than the curve accounts for).
  CREATE TABLE IF NOT EXISTS burns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint_address TEXT NOT NULL REFERENCES coins(mint_address),
    wallet TEXT NOT NULL,
    amount REAL NOT NULL,
    price_after REAL NOT NULL,
    tx_signature TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_burns_mint ON burns (mint_address, created_at);
  CREATE INDEX IF NOT EXISTS idx_burns_wallet ON burns (wallet, created_at);

  -- Transfers: real SPL transfers of a site coin between two user wallets
  -- (the pool is not involved). Verified on-chain before recording.
  -- Transfers move tokens without touching the curve or the recorded PnL
  -- (PnL is computed from trades only) — the UI shows the live on-chain
  -- balance next to the trade-based holdings so the difference is visible.
  CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint_address TEXT NOT NULL REFERENCES coins(mint_address),
    from_wallet TEXT NOT NULL,
    to_wallet TEXT NOT NULL,
    amount REAL NOT NULL,
    tx_signature TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_transfers_mint ON transfers (mint_address, created_at);
  CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers (from_wallet, created_at);
  CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers (to_wallet, created_at);

  -- Editable profiles, keyed by wallet (one profile per wallet). Username
  -- is UNIQUE with NOCASE collation, so uniqueness is case-insensitive
  -- ('SmokeCat' and 'smokecat' collide); NULL usernames are allowed and
  -- do not collide with each other. avatar_url / cover_url point at files
  -- under data/uploads (same ephemeral-on-Render caveat as coin logos:
  -- a redeploy wipes them; the profile row survives only in the DB, which
  -- is itself ephemeral on the free tier). border is a preset key
  -- ('none', 'green', 'gold', 'blue', 'purple', 'rainbow') rendered as a
  -- CSS ring around the avatar. Edits require a Phantom signMessage
  -- signature over a canonical message (see src/signverify.js).
  CREATE TABLE IF NOT EXISTS profiles (
    wallet TEXT PRIMARY KEY,
    username TEXT UNIQUE COLLATE NOCASE,
    avatar_url TEXT,
    border TEXT NOT NULL DEFAULT 'none',
    cover_url TEXT,
    updated_at INTEGER NOT NULL
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
if (!hasColumn('trades', 'fee_sol')) {
  db.exec('ALTER TABLE trades ADD COLUMN fee_sol REAL NOT NULL DEFAULT 0');
}
// Custom pairs: NULL = SOL pair, otherwise the pair coin's mint address.
if (!hasColumn('coins', 'pair_mint')) {
  db.exec('ALTER TABLE coins ADD COLUMN pair_mint TEXT');
}
// Creator-fee claims are paid in the pair asset (SOL for SOL pairs, pair
// tokens for coin pairs); asset_symbol records which one the amount is in.
if (!hasColumn('fee_claims', 'asset_symbol')) {
  db.exec("ALTER TABLE fee_claims ADD COLUMN asset_symbol TEXT NOT NULL DEFAULT 'SOL'");
}
// Burns record their source: 'holder' (any holder burning their own
// tokens), 'dev' (the creator burning their own holdings via the dev panel),
// 'pool' (the pool wallet burning its own reserve tokens, server-signed).
// Pre-existing rows are holder burns.
if (!hasColumn('burns', 'source')) {
  db.exec("ALTER TABLE burns ADD COLUMN source TEXT NOT NULL DEFAULT 'holder'");
}
// Fee claims record their kind: 'claim' (a payout to the creator's wallet)
// or 'buyback' (fees spent buying the coin back from the curve — the
// tokens go to the creator instead of a payout). Both reduce the
// unclaimed balance; the kind only distinguishes them in history.
if (!hasColumn('fee_claims', 'kind')) {
  db.exec("ALTER TABLE fee_claims ADD COLUMN kind TEXT NOT NULL DEFAULT 'claim'");
}
// Replay protection: one user transaction can only settle one trade.
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_user_sig ON trades (user_tx_signature) WHERE user_tx_signature IS NOT NULL'
);

module.exports = db;
