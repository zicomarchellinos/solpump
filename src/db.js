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

  -- Callout rewards: the creator funds a per-coin SOL reward pool with
  -- real devnet SOL sent to the pool wallet (verified on-chain before
  -- recording). tx_signature is unique: one funding transaction can only
  -- be recorded once. The pool balance for a coin is SUM(funds) -
  -- SUM(claims); it is a separate per-coin SOL ledger, independent of the
  -- coin's pair (SOL-paired and coin-paired coins both pay rewards in
  -- SOL). The SOL itself sits in the pool wallet alongside trading SOL —
  -- the ledgers are DB-side, so re-register reconstruction subtracts
  -- other coins' reward pools from the pool's SOL balance (see
  -- src/routes.js reconstructAssetReserve).
  CREATE TABLE IF NOT EXISTS reward_funds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint_address TEXT NOT NULL REFERENCES coins(mint_address),
    funder_wallet TEXT NOT NULL,
    amount_sol REAL NOT NULL,
    tx_signature TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_reward_funds_mint ON reward_funds (mint_address, created_at);

  -- Reward claims: a callout author claims a tier (+10% / +25% / +50%
  -- live PnL -> 0.01 / 0.025 / 0.05 SOL) once per callout per tier.
  -- UNIQUE(callout_id, tier) enforces the once-per-tier rule; the payout
  -- is a real SOL transfer from the pool wallet (tx_signature is the
  -- pool's payout transaction).
  CREATE TABLE IF NOT EXISTS reward_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    callout_id INTEGER NOT NULL REFERENCES callouts(id),
    mint_address TEXT NOT NULL REFERENCES coins(mint_address),
    wallet TEXT NOT NULL,
    tier INTEGER NOT NULL,
    amount_sol REAL NOT NULL,
    tx_signature TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (callout_id, tier)
  );

  CREATE INDEX IF NOT EXISTS idx_reward_claims_mint ON reward_claims (mint_address, created_at);
  CREATE INDEX IF NOT EXISTS idx_reward_claims_callout ON reward_claims (callout_id);

  -- Contacts: a per-wallet address book for transfers. One row per
  -- (owner, contact wallet) pair — an owner cannot save the same wallet
  -- twice. Writes are signature-proven (see src/signverify.js); reads
  -- are public (a wallet's contacts are its own address book, and the
  -- owner address is public on-chain anyway).
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_wallet TEXT NOT NULL,
    name TEXT NOT NULL,
    contact_wallet TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (owner_wallet, contact_wallet)
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts (owner_wallet, name);

  -- Manual community-badge grants by admins (see ADMIN_WALLETS):
  -- one row per (wallet, badge). Grants display on profiles exactly like
  -- earned badges (badges.js merges them, de-duplicated); revoking
  -- deletes the row, which un-grants the badge unless it was also earned.
  CREATE TABLE IF NOT EXISTS badge_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    badge TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (wallet, badge)
  );

  CREATE INDEX IF NOT EXISTS idx_badge_grants_wallet ON badge_grants (wallet);
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
// Referral fee portion of each trade (paid to the referral trader, not
// the creator). Defaults to 0 for pre-existing trades.
if (!hasColumn('trades', 'referral_fee_sol')) {
  db.exec('ALTER TABLE trades ADD COLUMN referral_fee_sol REAL NOT NULL DEFAULT 0');
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
// Coin categories (fixed list, see src/routes.js COIN_CATEGORIES):
// pre-existing coins become 'Lainnya'.
if (!hasColumn('coins', 'category')) {
  db.exec("ALTER TABLE coins ADD COLUMN category TEXT NOT NULL DEFAULT 'Lainnya'");
}
// Per-coin creator tax in basis points (0–1000, default 100 = 1%):
// set at creation, never changeable afterwards.
if (!hasColumn('coins', 'fee_bps')) {
  db.exec('ALTER TABLE coins ADD COLUMN fee_bps INTEGER NOT NULL DEFAULT 100');
}
// 18+ flag: the creator marks adult-content coins at creation; the UI
// blurs their cards and gates their detail page behind an age check.
if (!hasColumn('coins', 'is_adult')) {
  db.exec('ALTER TABLE coins ADD COLUMN is_adult INTEGER NOT NULL DEFAULT 0');
}
// Referral / trader fee: an optional trader wallet that receives a share
// of the trading fees generated by this coin, plus the bps rate (0–1000).
// Set at creation, never changeable afterwards. When set, the referral
// trader earns referral_fee_bps of each trade's fee, and the creator keeps
// the rest (fee_bps - referral_fee_bps).
if (!hasColumn('coins', 'referral_wallet')) {
  db.exec("ALTER TABLE coins ADD COLUMN referral_wallet TEXT");
}
if (!hasColumn('coins', 'referral_fee_bps')) {
  db.exec('ALTER TABLE coins ADD COLUMN referral_fee_bps INTEGER NOT NULL DEFAULT 0');
}
// Referral fee payouts: when a trader (referral wallet) claims their share
// of trading fees, the payout is recorded here (tx_signature is the pool's
// payout transaction).
db.exec(`
  CREATE TABLE IF NOT EXISTS referral_fee_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint_address TEXT NOT NULL REFERENCES coins(mint_address),
    referral_wallet TEXT NOT NULL,
    amount_sol REAL NOT NULL,
    asset_symbol TEXT NOT NULL DEFAULT 'SOL',
    tx_signature TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_referral_fee_claims_mint ON referral_fee_claims (mint_address, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_referral_fee_claims_wallet ON referral_fee_claims (referral_wallet, created_at)');
// Transfer receipt: the USD value of the transferred tokens, snapshotted
// at transfer time (NULL when no USD price was available then — the
// receipt then shows the token amount only).
if (!hasColumn('transfers', 'usd_value')) {
  db.exec('ALTER TABLE transfers ADD COLUMN usd_value REAL');
}
// Replay protection: one user transaction can only settle one trade.
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_user_sig ON trades (user_tx_signature) WHERE user_tx_signature IS NOT NULL'
);

module.exports = db;
