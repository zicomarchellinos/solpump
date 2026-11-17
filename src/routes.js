'use strict';
// solpump API. Trading is REAL devnet trading through the server pool wallet
// (see src/pool.js) — no custom on-chain program:
//   GET  /api/coins                 list coins (?following=<wallet> filters
//                                   to coins by followed creators)
//   GET  /api/coins/:mint           coin detail (chart, stats, trades, PnL,
//                                   creator fees + fee claims, burns)
//   GET  /api/coins/:mint/candles   OHLC candlesticks (?timeframe=1m|5m|15m|1h)
//   GET  /api/coins/:mint/burns     burn history + totals for a coin
//   GET  /api/pairs                 available pair assets (SOL + listed coins)
//   GET  /api/portfolio             wallet portfolio (from recorded trades)
//   GET  /api/deposits?wallet=      recent incoming on-chain transfers
//   GET  /api/transfers?wallet=     transfer history (sent + received)
//   POST /api/transfers             record a verified user-to-user transfer
//   GET  /api/pool                  pool wallet address (public)
//   GET  /api/sol-price             current SOL/USD price (cached 60s;
//                                   null when no price was ever fetched)
// Coin/stats responses also carry solUsd + marketCapUsd (null when no USD
// price is available — the UI then falls back to the pair asset).
//   POST /api/trades/prepare        quote + pool/user balance pre-checks
//   POST /api/trades/buy            settle a buy after the user's leg tx
//   POST /api/trades/sell           settle a sell after the user's token tx
//   POST /api/coins/:mint/burn      record a verified burn (raises the price)
//   POST /api/coins/register        register a verified mint (+ funding)
//   POST /api/coins/:mint/fund      enable trading after a funding transfer
//   POST /api/coins/:mint/claim-fees  creator claims accrued 1% trade fees
//   GET  /api/creators/:wallet      creator profile (coins, volume, fees,
//                                   followers/following, callouts, profile)
//   GET  /api/follows/:wallet       a wallet's followers + following lists
//   POST /api/follows               follow/unfollow (signature-proved)
//   GET  /api/profiles/:wallet      editable profile (username/avatar/border/
//                                   cover) or null
//   POST /api/profiles/:wallet      edit a profile (signature-proved;
//                                   username unique case-insensitively)
//   GET  /api/coins/:mint/callouts  callouts for a coin (newest first)
//   POST /api/coins/:mint/callouts  post a callout (verified buyers only)
//   GET  /api/callouts              latest callouts (?following=<wallet>
//                                   filters to followed traders)
//
// Custom pairs (see src/pairs.js): every coin trades against a pair asset —
// SOL by default, or any other coin in the registry. Amounts in the trades
// table (sol_amount, fee_sol) and the *Sol response fields are denominated
// in the PAIR ASSET, not necessarily SOL; the field names are historical.
// Each coin response carries pairAsset { type, symbol, mint, available }
// and pairLabel (TICKER/SOL or TICKER/PAIR) so the UI labels amounts with
// the right asset. USD prices resolve through the pair chain toward SOL.
//
// Creator fee: 1% of every trade's pair-asset volume (CREATOR_FEE_BPS in
// src/bonding.js) accrues to the coin's creator. The fee stays in the pool
// wallet (buys add the full amount, sells pay out net of the fee), so the
// invariant poolAssetActual = assetReserve + unclaimedFees always holds and
// a claim can always be paid out of the pool.
//
// Every trade settles in two on-chain legs: the user's leg (signed by the
// user in Phantom) is verified on-chain first, then the pool's leg (signed
// by the server pool keypair) is sent, and only then is the trade recorded
// with both signatures. A user signature can only settle one trade.

const path = require('path');
const fs = require('fs');
const express = require('express');
const db = require('./db');
const bonding = require('./bonding');
const pairs = require('./pairs');
const pool = require('./pool');
const { getSolUsdPrice } = require('./solprice');
const {
  verifyMint,
  verifyFunding,
  verifySolTransfer,
  verifyTokenTransfer,
  verifyBurn,
} = require('./verify');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { PublicKey } = require('@solana/web3.js');
const { connection, withRetry } = require('./rpc');
const {
  followMessage,
  profileMessage,
  devBurnMessage,
  buybackMessage,
  sha256Hex,
  verifyWalletSignature,
} = require('./signverify');

const CREATOR_FEE_PCT = bonding.CREATOR_FEE_BPS / 100; // 1
const CALLOUT_MAX_CHARS = 280;

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const MAX_TRADE_SOL = 1000;
const MIN_BUY_SOL = 0.001;
// Coin-pair trades are denominated in pair tokens, where 0.001 would be
// dust: a minimum of 1,000 pair tokens per buy, and a 1B-token cap (the
// whole supply — the curve itself is the real bound).
const MAX_TRADE_TOKENS = 1_000_000_000;
const MIN_BUY_TOKENS = 1000;
const LAMPORTS_PER_SOL = 1_000_000_000;
const CANDLE_TIMEFRAMES = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };
// Editable profiles: username 3-20 chars (letters, digits, underscore),
// unique case-insensitively; border is one of the built-in presets
// (rendered as a CSS ring around the avatar; 'none' = no ring).
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const BORDER_PRESETS = ['none', 'green', 'gold', 'blue', 'purple', 'rainbow'];
const IMAGE_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const MAX_IMAGE_BASE64_LEN = 900000; // ~675 KB decoded
const MAX_IMAGE_BYTES = 675000;

// Serialize trade settlements: one at a time, so two concurrent confirms
// can never overdraw the pool or record against stale reserves.
let tradeQueue = Promise.resolve();

// Validate + save an uploaded image ({ dataBase64, mimeType }) under
// data/uploads (gitignored; ephemeral on Render's free tier — a redeploy
// wipes uploaded files, same caveat as coin logos). Shared by coin logos
// and profile avatar/cover uploads: PNG/JPEG/GIF/WebP, max ~675 KB.
// Returns { url } or { error } (the label names the image in messages).
function saveUploadImage(image, filenameBase, label) {
  const ext = IMAGE_MIME_EXT[image && image.mimeType];
  if (!ext || typeof image.dataBase64 !== 'string' || image.dataBase64.length > MAX_IMAGE_BASE64_LEN) {
    return { error: `${label} harus berupa gambar PNG/JPEG/GIF/WebP maksimal ~675 KB.` };
  }
  let buf;
  try {
    buf = Buffer.from(image.dataBase64, 'base64');
  } catch {
    return { error: `${label} tidak bisa dibaca.` };
  }
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
    return { error: `${label} harus berupa gambar PNG/JPEG/GIF/WebP maksimal ~675 KB.` };
  }
  const filename = `${filenameBase}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
  return { url: `/uploads/${filename}` };
}

// Profiles (editable display name / avatar / border / cover), keyed by
// wallet. publicProfile returns null when the wallet has no profile row.
function loadProfileMap() {
  const map = new Map();
  for (const row of db.prepare('SELECT * FROM profiles').all()) {
    map.set(row.wallet, row);
  }
  return map;
}

function publicProfile(row) {
  if (!row) return null;
  return {
    wallet: row.wallet,
    username: row.username || null,
    avatarUrl: row.avatar_url || null,
    border: row.border || 'none',
    coverUrl: row.cover_url || null,
  };
}
function withTradeLock(fn) {
  const run = tradeQueue.then(fn, fn);
  tradeQueue = run.catch(() => {});
  return run;
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function toRawTokens(tokens) {
  return BigInt(Math.round(tokens * 1e6));
}

function toLamports(sol) {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

// ---- Shared query helpers ----

function coinTradesAsc(mintAddress) {
  return db
    .prepare('SELECT * FROM trades WHERE mint_address = ? ORDER BY created_at ASC, id ASC')
    .all(mintAddress);
}

function walletTradesAsc(mintAddress, wallet) {
  return db
    .prepare(
      'SELECT * FROM trades WHERE mint_address = ? AND wallet = ? ORDER BY created_at ASC, id ASC'
    )
    .all(mintAddress, wallet);
}

function coinBurnsAsc(mintAddress) {
  return db
    .prepare('SELECT * FROM burns WHERE mint_address = ? ORDER BY created_at ASC, id ASC')
    .all(mintAddress);
}

function coinBurnsDesc(mintAddress, limit = 50) {
  return db
    .prepare('SELECT * FROM burns WHERE mint_address = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(mintAddress, limit);
}

// Total burned per coin (one GROUP BY query, used by every coin serializer).
function totalBurnedMap() {
  const map = new Map();
  for (const r of db
    .prepare('SELECT mint_address, COALESCE(SUM(amount), 0) AS total FROM burns GROUP BY mint_address')
    .all()) {
    map.set(r.mint_address, r.total);
  }
  return map;
}

function loadCoinMap() {
  const map = new Map();
  for (const row of db.prepare('SELECT * FROM coins').all()) {
    map.set(row.mint_address, row);
  }
  return map;
}

// Pricing context, built once per request: the SOL/USD rate, the full coin
// registry (for pair resolution), the per-coin burn totals (for the
// circulating-supply market cap), and a memo cache for pair-chain USD
// resolution (shared across every coin in the response).
async function priceCtx() {
  const { price: solUsd } = await getSolUsdPrice();
  return {
    solUsd,
    coinMap: loadCoinMap(),
    burnedMap: totalBurnedMap(),
    profileMap: loadProfileMap(),
    usdCache: new Map(),
  };
}

// USD price of one unit of a coin's pair asset (SOL/USD for SOL pairs, the
// pair coin's USD token price for coin pairs). Null when unresolvable.
function coinAssetUsd(coinRow, ctx) {
  return pairs.resolvePairAssetUsdPrice(coinRow, ctx.coinMap, ctx.solUsd, ctx.usdCache);
}

function publicCoin(row, trades, ctx) {
  const assetUsd = coinAssetUsd(row, ctx);
  const totalBurned = ctx.burnedMap.get(row.mint_address) || 0;
  const stats = bonding.computeStats(row, trades, assetUsd, totalBurned);
  const pairAsset = pairs.pairAssetOf(row, ctx.coinMap);
  return {
    mintAddress: row.mint_address,
    name: row.name,
    ticker: row.ticker,
    description: row.description,
    logoUrl: row.logo_url,
    creatorWallet: row.creator_wallet,
    // Creator's editable profile (username/avatar/border) — null when the
    // creator never set one; the UI falls back to the shortened address.
    creatorProfile: publicProfile(ctx.profileMap && ctx.profileMap.get(row.creator_wallet)),
    txSignature: row.tx_signature,
    fundingTxSignature: row.funding_tx_signature || null,
    tradingEnabled: row.trading_enabled === 1,
    createdAt: row.created_at,
    solReserve: row.sol_reserve,
    tokenReserve: row.token_reserve,
    // Custom pair: NULL pairMint = SOL. pairAsset.available is false when
    // the pair coin vanished from the registry (trading is then disabled).
    pairMint: row.pair_mint || null,
    pairAsset,
    pairLabel: pairs.pairLabel(row.ticker, pairAsset),
    pairAssetUsd: assetUsd,
    ...stats,
  };
}

function publicTrade(row, assetUsd = null) {
  const priceUsd = Number.isFinite(assetUsd) && assetUsd > 0 ? row.price * assetUsd : null;
  return {
    id: row.id,
    mintAddress: row.mint_address,
    wallet: row.wallet,
    side: row.side,
    solAmount: row.sol_amount,
    tokenAmount: row.token_amount,
    price: row.price,
    priceUsd,
    feeSol: row.fee_sol || 0,
    userTxSignature: row.user_tx_signature || null,
    poolTxSignature: row.pool_tx_signature || null,
    createdAt: row.created_at,
  };
}

function publicFeeClaim(row) {
  return {
    id: row.id,
    mintAddress: row.mint_address,
    creatorWallet: row.creator_wallet,
    amountSol: row.amount_sol,
    assetSymbol: row.asset_symbol || 'SOL',
    // 'claim' = payout to the creator's wallet; 'buyback' = fees spent
    // buying the coin back from the curve (tokens to the creator).
    kind: row.kind || 'claim',
    txSignature: row.tx_signature,
    createdAt: row.created_at,
  };
}

function publicBurn(row, assetUsd = null) {
  const priceAfterUsd =
    Number.isFinite(assetUsd) && assetUsd > 0 ? row.price_after * assetUsd : null;
  return {
    id: row.id,
    mintAddress: row.mint_address,
    wallet: row.wallet,
    amount: row.amount,
    // 'holder' = any holder's own tokens; 'dev' = the creator's holdings
    // via the dev panel; 'pool' = the pool reserve, server-signed.
    source: row.source || 'holder',
    priceAfter: row.price_after,
    priceAfterUsd,
    txSignature: row.tx_signature,
    createdAt: row.created_at,
  };
}

function publicTransfer(row, coinMap) {
  const coin = coinMap ? coinMap.get(row.mint_address) : undefined;
  return {
    id: row.id,
    mintAddress: row.mint_address,
    coinName: coin ? coin.name : null,
    coinTicker: coin ? coin.ticker : null,
    coinLogoUrl: coin ? coin.logo_url : null,
    fromWallet: row.from_wallet,
    toWallet: row.to_wallet,
    amount: row.amount,
    txSignature: row.tx_signature,
    createdAt: row.created_at,
  };
}

// Creator-fee totals for one coin: earned (1% of all trade SOL volume),
// claimed (paid out so far), and unclaimed (claimable now).
function coinFeeTotals(mintAddress) {
  const earned =
    db
      .prepare('SELECT COALESCE(SUM(fee_sol), 0) AS s FROM trades WHERE mint_address = ?')
      .get(mintAddress).s || 0;
  const claimed =
    db
      .prepare('SELECT COALESCE(SUM(amount_sol), 0) AS s FROM fee_claims WHERE mint_address = ?')
      .get(mintAddress).s || 0;
  return { totalEarnedSol: earned, totalClaimedSol: claimed, unclaimedSol: Math.max(0, earned - claimed) };
}

function coinFeeClaims(mintAddress) {
  return db
    .prepare('SELECT * FROM fee_claims WHERE mint_address = ? ORDER BY created_at DESC, id DESC')
    .all(mintAddress)
    .map(publicFeeClaim);
}

// Callout helpers. A callout's live PnL is derived at read time from the
// entry price + holdings recorded at posting (both computed server-side
// from real trades) against the coin's current price. `assetUsd` is the
// USD price of one unit of the coin's pair asset.
function publicCallout(row, coinRow, assetUsd = null, assetSymbol = 'SOL', authorProfile = null) {
  const price = bonding.currentPrice(coinRow);
  const pnlSol = (price - row.entry_price) * row.holdings_at_post;
  const pnlPct =
    row.entry_price > 0 ? ((price - row.entry_price) / row.entry_price) * 100 : 0;
  const toUsd = (sol) => (Number.isFinite(assetUsd) && assetUsd > 0 ? sol * assetUsd : null);
  return {
    id: row.id,
    mintAddress: row.mint_address,
    wallet: row.wallet,
    // Author's editable profile (username/avatar/border) — null when the
    // author never set one; the UI falls back to the shortened address
    // and an initials avatar.
    authorProfile,
    text: row.text,
    entryPrice: row.entry_price,
    entryPriceUsd: toUsd(row.entry_price),
    holdingsAtPost: row.holdings_at_post,
    currentPrice: price,
    currentPriceUsd: toUsd(price),
    pnlSol,
    pnlUsd: toUsd(pnlSol),
    pnlPct,
    isProfit: pnlSol >= 0,
    // The pair asset the pnlSol/entry figures are denominated in.
    assetSymbol,
    createdAt: row.created_at,
  };
}

// Attach coin name/ticker to callouts that span coins (profiles, feeds).
function withCoinMeta(callout, coinRow) {
  return {
    ...callout,
    coinName: coinRow.name,
    coinTicker: coinRow.ticker,
  };
}

function coinCallouts(mintAddress, ctx) {
  const coinRow = ctx.coinMap.get(mintAddress)
    || db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(mintAddress);
  if (!coinRow) return [];
  const assetUsd = coinAssetUsd(coinRow, ctx);
  const assetSymbol = pairs.pairAssetOf(coinRow, ctx.coinMap).symbol;
  return db
    .prepare('SELECT * FROM callouts WHERE mint_address = ? ORDER BY created_at DESC, id DESC')
    .all(mintAddress)
    .map((row) =>
      publicCallout(
        row,
        coinRow,
        assetUsd,
        assetSymbol,
        publicProfile(ctx.profileMap && ctx.profileMap.get(row.wallet))
      )
    );
}

// A wallet's buy history for a coin: total SOL spent, total tokens bought,
// and buy count. Entry price = total SOL / total tokens (average buy price
// from real trades — never user-supplied).
function walletBuyStats(mintAddress, wallet) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(sol_amount), 0) AS sol,
              COALESCE(SUM(token_amount), 0) AS tokens,
              COUNT(*) AS n
       FROM trades WHERE mint_address = ? AND wallet = ? AND side = 'buy'`
    )
    .get(mintAddress, wallet);
}

// Follow helpers.
function isFollowing(followerWallet, followingWallet) {
  return !!db
    .prepare('SELECT 1 FROM follows WHERE follower_wallet = ? AND following_wallet = ?')
    .get(followerWallet, followingWallet);
}

function followLists(wallet) {
  const followers = db
    .prepare('SELECT follower_wallet AS wallet FROM follows WHERE following_wallet = ? ORDER BY created_at DESC')
    .all(wallet)
    .map((r) => r.wallet);
  const following = db
    .prepare('SELECT following_wallet AS wallet FROM follows WHERE follower_wallet = ? ORDER BY created_at DESC')
    .all(wallet)
    .map((r) => r.wallet);
  return { followers, following, followerCount: followers.length, followingCount: following.length };
}

function signatureAlreadyUsed(signature) {
  const inTrades = db
    .prepare('SELECT id FROM trades WHERE user_tx_signature = ?')
    .get(signature);
  if (inTrades) return true;
  const inFailed = db
    .prepare('SELECT id FROM failed_trades WHERE user_tx_signature = ?')
    .get(signature);
  return !!inFailed;
}

function recordFailedTrade({ mintAddress, wallet, side, solAmount, tokenAmount, userTxSignature, error }) {
  db.prepare(
    `INSERT INTO failed_trades
       (mint_address, wallet, side, sol_amount, token_amount, user_tx_signature, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(mintAddress, wallet, side, solAmount, tokenAmount, userTxSignature, error, Date.now());
}

function recordTradeAndReserves({ mintAddress, wallet, side, solAmount, tokenAmount, price, feeSol, userTxSignature, poolTxSignature, row }) {
  const now = Date.now();
  const apply = db.transaction(() => {
    const newSol = side === 'buy' ? row.sol_reserve + solAmount : row.sol_reserve - solAmount;
    const newTokens =
      side === 'buy' ? row.token_reserve - tokenAmount : row.token_reserve + tokenAmount;
    db.prepare('UPDATE coins SET sol_reserve = ?, token_reserve = ? WHERE mint_address = ?').run(
      newSol,
      newTokens,
      mintAddress
    );
    const info = db
      .prepare(
        `INSERT INTO trades
           (mint_address, wallet, side, sol_amount, token_amount, price, fee_sol,
            user_tx_signature, pool_tx_signature, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(mintAddress, wallet, side, solAmount, tokenAmount, price, feeSol || 0, userTxSignature, poolTxSignature, now);
    return info.lastInsertRowid;
  });
  return { tradeId: apply(), now };
}

// ---- GET /api/pool ----
// The pool wallet's public address (for the UI + client transactions).
router.get('/pool', (req, res) => {
  res.json({ address: pool.getPoolAddress(), network: 'devnet' });
});

// ---- GET /api/sol-price ----
// Current SOL/USD price for the USD market-cap display. Cached server-side
// for 60s; `solUsd` is null when no price was ever fetched.
router.get('/sol-price', async (req, res) => {
  const { price, source, fetchedAt, stale } = await getSolUsdPrice();
  res.json({ solUsd: price, source, fetchedAt, stale });
});

// ---- GET /api/coins ----
// Query: ?search= (name/ticker) &sort=newest|price|marketcap|volume|change
//   &creator=<wallet> (only that creator's coins)
//   &following=<wallet> (only coins by creators that wallet follows)
router.get('/coins', async (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const sort = String(req.query.sort || 'newest');
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 60));
  const creator = typeof req.query.creator === 'string' ? req.query.creator : null;
  const following = typeof req.query.following === 'string' ? req.query.following : null;
  if (creator && !BASE58_RE.test(creator)) {
    return badRequest(res, 'Parameter creator tidak valid.');
  }
  if (following && !BASE58_RE.test(following)) {
    return badRequest(res, 'Parameter following tidak valid.');
  }

  let rows = db.prepare('SELECT * FROM coins ORDER BY created_at DESC').all();
  if (creator) rows = rows.filter((c) => c.creator_wallet === creator);
  if (following) {
    const followed = new Set(
      db
        .prepare('SELECT following_wallet FROM follows WHERE follower_wallet = ?')
        .all(following)
        .map((r) => r.following_wallet)
    );
    rows = rows.filter((c) => followed.has(c.creator_wallet));
  }
  if (search) {
    rows = rows.filter(
      (c) =>
        c.name.toLowerCase().includes(search) || c.ticker.toLowerCase().includes(search)
    );
  }
  const ctx = await priceCtx();
  const coins = rows.map((row) => publicCoin(row, coinTradesAsc(row.mint_address), ctx));
  // Market-cap sort uses the USD figure when it resolves (coins on
  // different pairs are otherwise not comparable), else the pair-asset cap.
  const mc = (c) => (Number.isFinite(c.marketCapUsd) ? c.marketCapUsd : c.marketCapSol);
  switch (sort) {
    case 'price':
      coins.sort((a, b) => b.price - a.price);
      break;
    case 'marketcap':
      coins.sort((a, b) => mc(b) - mc(a));
      break;
    case 'volume':
      coins.sort((a, b) => b.volumeSol - a.volumeSol);
      break;
    case 'change':
      coins.sort((a, b) => b.changePct - a.changePct);
      break;
    default:
      coins.sort((a, b) => b.createdAt - a.createdAt);
  }
  res.json({ coins: coins.slice(0, limit), solUsd: ctx.solUsd });
});

// ---- GET /api/pairs ----
// Available pair assets for the create form's pair picker: SOL plus every
// coin in the registry (any trader-created coin can be a pair asset).
router.get('/pairs', (req, res) => {
  const coins = db
    .prepare('SELECT mint_address, name, ticker, logo_url FROM coins ORDER BY created_at DESC LIMIT 100')
    .all();
  res.json({
    pairs: [
      { mint: null, symbol: 'SOL', name: 'Solana', type: 'SOL', logoUrl: null },
      ...coins.map((c) => ({
        mint: c.mint_address,
        symbol: c.ticker,
        name: c.name,
        type: 'COIN',
        logoUrl: c.logo_url,
      })),
    ],
  });
});

// ---- GET /api/coins/:mint ----
router.get('/coins/:mint', async (req, res) => {
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });

  const ctx = await priceCtx();
  const assetUsd = coinAssetUsd(row, ctx);
  const trades = coinTradesAsc(row.mint_address);
  const burns = coinBurnsAsc(row.mint_address);
  const coin = publicCoin(row, trades, ctx);
  const wallet = typeof req.query.wallet === 'string' ? req.query.wallet : null;

  const result = {
    coin,
    solUsd: ctx.solUsd,
    stats: {
      price: coin.price,
      priceUsd: coin.priceUsd,
      marketCapSol: coin.marketCapSol,
      marketCapUsd: coin.marketCapUsd,
      changePct: coin.changePct,
      high: coin.high,
      highUsd: coin.highUsd,
      low: coin.low,
      lowUsd: coin.lowUsd,
      volumeSol: coin.volumeSol,
      totalFeesSol: coin.totalFeesSol,
      txCount: coin.txCount,
      uniqueTraders: coin.uniqueTraders,
      progressPct: coin.progressPct,
      totalBurned: coin.totalBurned,
      circulatingSupply: coin.circulatingSupply,
    },
    chart: bonding.chartPoints(row, trades, assetUsd, burns),
    trades: trades
      .slice()
      .reverse()
      .slice(0, 100)
      .map((t) => publicTrade(t, assetUsd)),
    // Creator-fee claims for this coin (shown in the transaction history).
    feeClaims: coinFeeClaims(row.mint_address),
    creatorFees: coinFeeTotals(row.mint_address),
    creatorFeePct: CREATOR_FEE_PCT,
    viewerFollowsCreator: wallet ? isFollowing(wallet, row.creator_wallet) : false,
    // Callouts (verified buyers only), newest first, with live PnL.
    callouts: coinCallouts(row.mint_address, ctx),
    // Burns (newest first) + totals: burning shrinks the circulating
    // supply and raises the price (see src/bonding.js).
    burns: coinBurnsDesc(row.mint_address).map((b) => publicBurn(b, assetUsd)),
    burnStats: {
      totalBurned: coin.totalBurned,
      circulatingSupply: coin.circulatingSupply,
      burnCount: burns.length,
    },
    walletPnl: null,
    walletTrades: [],
  };

  if (wallet) {
    const mine = walletTradesAsc(row.mint_address, wallet);
    result.walletPnl = bonding.computePnl(mine, coin.price, assetUsd);
    result.walletTrades = mine
      .slice()
      .reverse()
      .map((t) => publicTrade(t, assetUsd));
  }
  res.json(result);
});

// ---- GET /api/coins/:mint/candles?timeframe=5m ----
// OHLC candlesticks built from recorded trades (+ burns as price-only
// points). Timeframes: 1m / 5m / 15m / 1h (default 5m). Empty buckets
// produce no candle, so sparse data renders as gaps, never zero candles.
router.get('/coins/:mint/candles', async (req, res) => {
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });
  const timeframe = CANDLE_TIMEFRAMES[req.query.timeframe] ? req.query.timeframe : '5m';
  const ctx = await priceCtx();
  const assetUsd = coinAssetUsd(row, ctx);
  const points = bonding.chartPoints(
    row,
    coinTradesAsc(row.mint_address),
    assetUsd,
    coinBurnsAsc(row.mint_address)
  );
  const toUsd = (v) => (Number.isFinite(assetUsd) && assetUsd > 0 ? v * assetUsd : null);
  const candles = bonding.buildCandles(points, CANDLE_TIMEFRAMES[timeframe]).map((c) => ({
    ...c,
    openUsd: toUsd(c.open),
    highUsd: toUsd(c.high),
    lowUsd: toUsd(c.low),
    closeUsd: toUsd(c.close),
    volumeUsd: toUsd(c.volume),
  }));
  res.json({
    mintAddress: row.mint_address,
    timeframe,
    assetUsd,
    pairAsset: pairs.pairAssetOf(row, ctx.coinMap),
    candles,
  });
});

// ---- GET /api/coins/:mint/burns ----
// Burn history (newest first) + totals for a coin.
router.get('/coins/:mint/burns', async (req, res) => {
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });
  const ctx = await priceCtx();
  const assetUsd = coinAssetUsd(row, ctx);
  const burns = coinBurnsDesc(row.mint_address);
  const totalBurned = ctx.burnedMap.get(row.mint_address) || 0;
  res.json({
    mintAddress: row.mint_address,
    totalBurned,
    circulatingSupply: bonding.circulatingSupply(totalBurned),
    burnCount: db
      .prepare('SELECT COUNT(*) AS n FROM burns WHERE mint_address = ?')
      .get(row.mint_address).n,
    burns: burns.map((b) => publicBurn(b, assetUsd)),
  });
});

// ---- GET /api/coins/:mint/burn-preview?amount= ----
// Full dev-burn calculation for the creator panel: current price /
// circulating supply / market cap, and the projected values after burning
// `amount` tokens (price, supply, market cap, % of supply burned, price
// increase %). Pure computation from the current reserves — no auth, no
// state change. Market-cap figures are in the pair asset and USD.
router.get('/coins/:mint/burn-preview', async (req, res) => {
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });
  const amount = Number(req.query.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return badRequest(res, 'Jumlah burn harus lebih dari 0.');
  }
  if (amount >= row.token_reserve) {
    return badRequest(
      res,
      `Jumlah burn melebihi cadangan kurva (${row.token_reserve.toLocaleString('id-ID')} ${row.ticker}).`
    );
  }
  const ctx = await priceCtx();
  const assetUsd = coinAssetUsd(row, ctx);
  const totalBurned = ctx.burnedMap.get(row.mint_address) || 0;
  const price = bonding.currentPrice(row);
  const supply = bonding.circulatingSupply(totalBurned);
  const newPrice = bonding.priceAfterBurn(row, amount);
  const newSupply = supply - amount;
  const toUsd = (v) => (Number.isFinite(assetUsd) && assetUsd > 0 ? v * assetUsd : null);
  res.json({
    mintAddress: row.mint_address,
    amount,
    current: {
      price,
      priceUsd: toUsd(price),
      circulatingSupply: supply,
      marketCapSol: price * supply,
      marketCapUsd: toUsd(price * supply),
    },
    projected: {
      price: newPrice,
      priceUsd: toUsd(newPrice),
      circulatingSupply: newSupply,
      marketCapSol: newPrice * newSupply,
      marketCapUsd: toUsd(newPrice * newSupply),
    },
    pctSupplyBurned: supply > 0 ? (amount / supply) * 100 : 0,
    priceIncreasePct: price > 0 ? ((newPrice - price) / price) * 100 : 0,
    maxBurn: row.token_reserve,
    pairAsset: pairs.pairAssetOf(row, ctx.coinMap),
    assetUsd,
  });
});

// ---- GET /api/coins/:mint/buyback-preview?amount= ----
// Buyback preview for the creator panel: how many tokens `amount` of
// unclaimed creator fees buys from the curve (or 'all' for the full
// unclaimed balance), the new price after the buyback, the unclaimed
// balance, and the minimum buy. Pure computation — no auth, no state
// change. Amounts are denominated in the pair asset.
router.get('/coins/:mint/buyback-preview', async (req, res) => {
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });
  const totals = coinFeeTotals(row.mint_address);
  const pairAsset = pairs.pairAssetOf(row, loadCoinMap());
  const minBuy = pairAsset.type === 'SOL' ? MIN_BUY_SOL : MIN_BUY_TOKENS;
  const raw = req.query.amount;
  const spend = raw === 'all' ? totals.unclaimedSol : Number(raw);
  if (!Number.isFinite(spend) || spend <= 0) {
    return badRequest(res, 'Jumlah buyback harus lebih dari 0.');
  }
  if (spend > totals.unclaimedSol) {
    return badRequest(
      res,
      `Jumlah buyback melebihi fee yang belum diklaim (${totals.unclaimedSol} ${pairAsset.symbol}).`
    );
  }
  const ctx = await priceCtx();
  const assetUsd = coinAssetUsd(row, ctx);
  const tokenAmount = bonding.quoteBuy(row, spend);
  const newPrice = (row.sol_reserve + spend) / (row.token_reserve - tokenAmount);
  const toUsd = (v) => (Number.isFinite(assetUsd) && assetUsd > 0 ? v * assetUsd : null);
  res.json({
    mintAddress: row.mint_address,
    amount: spend,
    isAll: raw === 'all',
    tokenAmount,
    price: bonding.currentPrice(row),
    priceUsd: toUsd(bonding.currentPrice(row)),
    newPrice,
    newPriceUsd: toUsd(newPrice),
    unclaimedSol: totals.unclaimedSol,
    minBuy,
    pairAsset,
    assetUsd,
  });
});

// ---- GET /api/portfolio?wallet= ----
router.get('/portfolio', async (req, res) => {
  const wallet = req.query.wallet;
  if (typeof wallet !== 'string' || !BASE58_RE.test(wallet)) {
    return badRequest(res, 'Parameter wallet tidak valid.');
  }

  const ctx = await priceCtx();
  const coins = db.prepare('SELECT * FROM coins').all();
  const positions = [];
  const summary = {
    coinCount: 0,
    totalBuySol: 0,
    totalSellSol: 0,
    totalCostBasisSol: 0,
    totalCurrentValueSol: 0,
    totalRealizedPnlSol: 0,
    totalUnrealizedPnlSol: 0,
    totalPnlSol: 0,
    totalPnlPct: 0,
    totalTrades: 0,
    isProfit: true,
    // USD totals are converted PER POSITION (each coin's own pair-asset
    // rate) and then summed — correct across mixed pairs. The *Sol totals
    // sum pair-asset amounts and are only exact when every position is a
    // SOL pair; the UI shows USD as the primary figure.
    totalCostBasisUsd: 0,
    totalCurrentValueUsd: 0,
    totalRealizedPnlUsd: 0,
    totalUnrealizedPnlUsd: 0,
    totalPnlUsd: 0,
  };

  for (const row of coins) {
    const mine = walletTradesAsc(row.mint_address, wallet);
    if (mine.length === 0) continue;
    const assetUsd = coinAssetUsd(row, ctx);
    const totalBurned = ctx.burnedMap.get(row.mint_address) || 0;
    const price = bonding.currentPrice(row);
    const pnl = bonding.computePnl(mine, price, assetUsd);
    const pairAsset = pairs.pairAssetOf(row, ctx.coinMap);
    positions.push({
      mintAddress: row.mint_address,
      name: row.name,
      ticker: row.ticker,
      logoUrl: row.logo_url,
      pairAsset,
      pairLabel: pairs.pairLabel(row.ticker, pairAsset),
      price,
      priceUsd: Number.isFinite(assetUsd) && assetUsd > 0 ? price * assetUsd : null,
      marketCapSol: bonding.marketCapSol(row, totalBurned),
      marketCapUsd: bonding.marketCapUsd(row, assetUsd, totalBurned),
      ...pnl,
    });
    summary.coinCount += 1;
    summary.totalBuySol += pnl.totalBuySol;
    summary.totalSellSol += pnl.totalSellSol;
    summary.totalCostBasisSol += pnl.costBasisSol;
    summary.totalCurrentValueSol += pnl.currentValueSol;
    summary.totalRealizedPnlSol += pnl.realizedPnlSol;
    summary.totalUnrealizedPnlSol += pnl.unrealizedPnlSol;
    summary.totalPnlSol += pnl.totalPnlSol;
    summary.totalTrades += pnl.totalTrades;
    summary.totalCostBasisUsd += pnl.costBasisUsd || 0;
    summary.totalCurrentValueUsd += pnl.currentValueUsd || 0;
    summary.totalRealizedPnlUsd += pnl.realizedPnlUsd || 0;
    summary.totalUnrealizedPnlUsd += pnl.unrealizedPnlUsd || 0;
    summary.totalPnlUsd += pnl.totalPnlUsd || 0;
  }
  summary.totalPnlPct =
    summary.totalBuySol > 0 ? (summary.totalPnlSol / summary.totalBuySol) * 100 : 0;
  summary.isProfit = summary.totalPnlSol >= 0;
  positions.sort((a, b) => b.currentValueSol - a.currentValueSol);

  // Transfer history (sent + received) for this wallet, newest first.
  const transfers = db
    .prepare(
      `SELECT * FROM transfers
       WHERE from_wallet = ? OR to_wallet = ?
       ORDER BY created_at DESC, id DESC LIMIT 100`
    )
    .all(wallet, wallet)
    .map((r) => publicTransfer(r, ctx.coinMap));

  res.json({ wallet, positions, summary, transfers, solUsd: ctx.solUsd });
});

// ---- GET /api/deposits?wallet= ----
// Recent INCOMING on-chain transfers to a wallet, detected live from devnet
// RPC: the wallet's own signatures (SOL transfers) plus the signatures of
// each of its token accounts (SPL transfers into its ATAs). Parsed into
// { type: 'SOL'|'SPL', mint, amount, from, signature, time }, newest first.
// This is a read-only RPC scan — the site never holds user funds (except
// the trading pool), and deposits are ordinary on-chain transfers to the
// user's own wallet address.
router.get('/deposits', async (req, res) => {
  const wallet = req.query.wallet;
  if (typeof wallet !== 'string' || !BASE58_RE.test(wallet)) {
    return badRequest(res, 'Parameter wallet tidak valid.');
  }
  try {
    const deposits = await findIncomingDeposits(wallet);
    res.json({ wallet, deposits });
  } catch (err) {
    res.status(502).json({ error: `Gagal membaca aktivitas on-chain: ${err.message}` });
  }
});

async function findIncomingDeposits(walletAddress) {
  const walletPubkey = new PublicKey(walletAddress);
  // The wallet's token accounts: ATA address + mint + decimals, so SPL
  // transfers into them can be recognized and converted to whole tokens.
  const tokenAccounts = await withRetry(
    () =>
      connection.getParsedTokenAccountsByOwner(walletPubkey, {
        programId: TOKEN_PROGRAM_ID,
      }),
    { label: 'deposits token accounts' }
  );
  const ataByAddress = new Map(); // ATA -> { mint, decimals }
  for (const a of tokenAccounts.value || []) {
    const info = a.account && a.account.data && a.account.data.parsed
      ? a.account.data.parsed.info
      : null;
    if (!info) continue;
    ataByAddress.set(a.pubkey.toBase58(), {
      mint: info.mint,
      decimals: info.tokenAmount.decimals,
    });
  }

  // Signatures touching the wallet itself (SOL) + each ATA (SPL), newest
  // first. Bounded: 15 for the wallet, 5 per ATA, max 10 ATAs, 25 txs
  // parsed in total — the public RPC is slow and rate-limited.
  const sigLists = await Promise.all([
    withRetry(() => connection.getSignaturesForAddress(walletPubkey, { limit: 15 }), {
      label: 'deposits wallet signatures',
    }).catch(() => []),
    ...[...ataByAddress.keys()].slice(0, 10).map((ata) =>
      withRetry(
        () => connection.getSignaturesForAddress(new PublicKey(ata), { limit: 5 }),
        { label: 'deposits ATA signatures' }
      ).catch(() => [])
    ),
  ]);
  const seen = new Set();
  const sigs = [];
  for (const list of sigLists) {
    for (const s of list || []) {
      if (!seen.has(s.signature)) {
        seen.add(s.signature);
        sigs.push(s);
      }
    }
  }
  sigs.sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0));
  const parsed = await Promise.all(
    sigs.slice(0, 25).map((s) =>
      withRetry(
        () =>
          connection.getParsedTransaction(s.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          }),
        { attempts: 2, label: 'deposits parsed tx' }
      ).catch(() => null)
    )
  );

  const deposits = [];
  for (const tx of parsed) {
    if (!tx || (tx.meta && tx.meta.err)) continue;
    const signature = tx.transaction.signatures[0];
    const time = tx.blockTime ? tx.blockTime * 1000 : null;
    for (const ix of tx.transaction.message.instructions || []) {
      if (!ix.parsed) continue;
      // Native SOL transfer into the wallet.
      if (
        ix.program === 'system' &&
        ix.parsed.type === 'transfer' &&
        ix.parsed.info.destination === walletAddress
      ) {
        deposits.push({
          type: 'SOL',
          mint: null,
          amount: Number(ix.parsed.info.lamports) / LAMPORTS_PER_SOL,
          from: ix.parsed.info.source,
          signature,
          time,
        });
      }
      // SPL transfer into one of the wallet's token accounts.
      if (ix.program === 'spl-token' && ix.parsed.info) {
        const dest = ix.parsed.info.destination;
        const ata = ataByAddress.get(dest);
        if (!ata) continue;
        let raw = null;
        if (ix.parsed.type === 'transferChecked' && ix.parsed.info.tokenAmount) {
          raw = ix.parsed.info.tokenAmount.amount;
        } else if (ix.parsed.type === 'transfer') {
          raw = ix.parsed.info.amount;
        }
        if (raw === null) continue;
        deposits.push({
          type: 'SPL',
          mint: ata.mint,
          amount: Number(raw) / 10 ** ata.decimals,
          from: ix.parsed.info.authority || ix.parsed.info.source,
          signature,
          time,
        });
      }
    }
  }
  deposits.sort((a, b) => (b.time || 0) - (a.time || 0));
  return deposits.slice(0, 20);
}

// ---- GET /api/transfers?wallet= ----
// Transfer history for a wallet (sent + received), newest first.
router.get('/transfers', (req, res) => {
  const wallet = req.query.wallet;
  if (typeof wallet !== 'string' || !BASE58_RE.test(wallet)) {
    return badRequest(res, 'Parameter wallet tidak valid.');
  }
  const coinMap = loadCoinMap();
  const rows = db
    .prepare(
      `SELECT * FROM transfers
       WHERE from_wallet = ? OR to_wallet = ?
       ORDER BY created_at DESC, id DESC LIMIT 100`
    )
    .all(wallet, wallet);
  res.json({ wallet, transfers: rows.map((r) => publicTransfer(r, coinMap)) });
});

// ---- POST /api/transfers ----
// Record a user-to-user transfer of a site coin after verifying the SPL
// transfer on-chain (sender ATA -> recipient ATA, exact amount). The pool
// is not involved. Body: { mintAddress, fromWallet, toWallet, amount,
// txSignature }. One signature can only be recorded once.
router.post('/transfers', async (req, res) => {
  const { mintAddress, fromWallet, toWallet, amount, txSignature } = req.body || {};
  if (typeof mintAddress !== 'string' || !BASE58_RE.test(mintAddress)) {
    return badRequest(res, 'Alamat mint tidak valid.');
  }
  if (typeof fromWallet !== 'string' || !BASE58_RE.test(fromWallet)) {
    return badRequest(res, 'Alamat pengirim tidak valid.');
  }
  if (typeof toWallet !== 'string' || !BASE58_RE.test(toWallet)) {
    return badRequest(res, 'Alamat penerima tidak valid.');
  }
  if (fromWallet === toWallet) {
    return badRequest(res, 'Pengirim dan penerima tidak boleh sama.');
  }
  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return badRequest(res, 'Jumlah transfer harus lebih dari 0.');
  }
  if (typeof txSignature !== 'string' || !SIGNATURE_RE.test(txSignature)) {
    return badRequest(res, 'Tanda tangan transaksi tidak valid.');
  }
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(mintAddress);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });
  const existing = db
    .prepare('SELECT id FROM transfers WHERE tx_signature = ?')
    .get(txSignature);
  if (existing) {
    return res.status(409).json({ error: 'Transfer ini sudah tercatat.' });
  }
  const amountRaw = toRawTokens(amountNum);
  if (amountRaw <= 0n) {
    return badRequest(res, 'Jumlah terlalu kecil.');
  }
  try {
    const fromAta = (
      await getAssociatedTokenAddress(new PublicKey(mintAddress), new PublicKey(fromWallet))
    ).toBase58();
    const toAta = (
      await getAssociatedTokenAddress(new PublicKey(mintAddress), new PublicKey(toWallet))
    ).toBase58();
    const verified = await verifyTokenTransfer({
      signature: txSignature,
      fromAta,
      toAta,
      amountRaw,
    });
    if (!verified.ok) {
      return res.status(422).json({ error: `Verifikasi transfer gagal: ${verified.reason}` });
    }
    const info = db
      .prepare(
        `INSERT INTO transfers
           (mint_address, from_wallet, to_wallet, amount, tx_signature, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(mintAddress, fromWallet, toWallet, amountNum, txSignature, Date.now());
    const created = db.prepare('SELECT * FROM transfers WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ transfer: publicTransfer(created, loadCoinMap()) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Transfer ini sudah tercatat.' });
    }
    res.status(502).json({ error: `Gagal mencatat transfer: ${err.message}` });
  }
});

// ---- Quote helper (shared by prepare + settle) ----
// Returns { solAmount, tokenAmount } for a side, or { error }. `solAmount`
// is denominated in the PAIR ASSET (SOL for SOL pairs, pair tokens for
// coin pairs); maxIn/assetSymbol make the cap pair-aware.
function quoteTrade(row, side, solIn, tokenIn, maxIn = MAX_TRADE_SOL, assetSymbol = 'SOL') {
  if (side === 'buy') {
    if (Number.isFinite(solIn) && solIn > 0) {
      if (solIn > maxIn) {
        return { error: `Beli maksimal ${maxIn.toLocaleString('id-ID')} ${assetSymbol} per transaksi.` };
      }
      return { solAmount: solIn, tokenAmount: bonding.quoteBuy(row, solIn) };
    }
    if (Number.isFinite(tokenIn) && tokenIn > 0) {
      const solAmount = bonding.quoteBuySolForTokens(row, tokenIn);
      if (!Number.isFinite(solAmount)) {
        return { error: 'Jumlah token melebihi sisa kurva.' };
      }
      return { solAmount, tokenAmount: tokenIn };
    }
    return { error: 'Beli butuh solAmount atau tokenAmount > 0.' };
  }
  if (Number.isFinite(tokenIn) && tokenIn > 0) {
    return { solAmount: bonding.quoteSell(row, tokenIn), tokenAmount: tokenIn };
  }
  if (Number.isFinite(solIn) && solIn > 0) {
    const tokenAmount = bonding.quoteSellTokensForSol(row, solIn);
    if (!Number.isFinite(tokenAmount)) {
      return { error: 'Jumlah SOL melebihi cadangan kurva.' };
    }
    return { solAmount: solIn, tokenAmount };
  }
  return { error: 'Jual butuh tokenAmount atau solAmount > 0.' };
}

// `expectedSide`: for the side-specific settle endpoints (/trades/buy,
// /trades/sell) the URL already determines the side, so the body need not
// repeat it. Prepare (shared endpoint) still requires body.side.
function validateTradeInput(req, res, expectedSide) {
  const { mintAddress, wallet } = req.body || {};
  const side = expectedSide || req.body?.side;
  if (typeof mintAddress !== 'string' || !BASE58_RE.test(mintAddress)) {
    badRequest(res, 'Alamat mint tidak valid.');
    return null;
  }
  if (typeof wallet !== 'string' || !BASE58_RE.test(wallet)) {
    badRequest(res, 'Alamat dompet tidak valid.');
    return null;
  }
  if (side !== 'buy' && side !== 'sell') {
    badRequest(res, 'side harus "buy" atau "sell".');
    return null;
  }
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(mintAddress);
  if (!row) {
    res.status(404).json({ error: 'Coin tidak ditemukan.' });
    return null;
  }
  if (row.trading_enabled !== 1) {
    badRequest(
      res,
      'Trading belum aktif untuk coin ini: kreator belum memindahkan 800.000.000 token ke pool.'
    );
    return null;
  }
  // If the pair coin vanished from the registry (e.g. after a database
  // reset), trading is disabled with an explanation instead of crashing.
  const pairAsset = pairs.pairAssetOf(row, loadCoinMap());
  if (!pairAsset.available) {
    badRequest(
      res,
      'Trading nonaktif: coin pasangan untuk coin ini tidak ditemukan di registry (kemungkinan setelah reset database). Trading tidak dapat dilakukan sampai pasangan tersedia lagi.'
    );
    return null;
  }
  return { mintAddress, wallet, side, row, pairAsset };
}

// ---- POST /api/trades/prepare ----
// Quote a trade and check every on-chain balance BEFORE the user signs
// anything. Body: { mintAddress, wallet, side, solAmount?, tokenAmount? }
// solAmount is denominated in the PAIR ASSET (SOL for SOL pairs, pair
// tokens for coin pairs).
router.post('/trades/prepare', async (req, res) => {
  const input = validateTradeInput(req, res);
  if (!input) return;
  const { mintAddress, wallet, side, row, pairAsset } = input;
  const maxTrade = pairAsset.type === 'SOL' ? MAX_TRADE_SOL : MAX_TRADE_TOKENS;
  const solIn = Number(req.body.solAmount);
  const tokenIn = Number(req.body.tokenAmount);
  const quote = quoteTrade(row, side, solIn, tokenIn, maxTrade, pairAsset.symbol);
  if (quote.error) return badRequest(res, quote.error);
  const { solAmount, tokenAmount } = quote;
  if (side === 'buy') {
    const minBuy = pairAsset.type === 'SOL' ? MIN_BUY_SOL : MIN_BUY_TOKENS;
    if (solAmount < minBuy) {
      // Keep the SOL message exactly "Beli minimal 0.001 SOL." (plain
      // number, not id-ID grouping) — the e2e suite asserts on it.
      const minLabel = pairAsset.type === 'SOL' ? String(minBuy) : minBuy.toLocaleString('id-ID');
      return badRequest(res, `Beli minimal ${minLabel} ${pairAsset.symbol}.`);
    }
  }
  if (toRawTokens(tokenAmount) <= 0n) {
    return badRequest(res, 'Jumlah terlalu kecil.');
  }

  try {
    if (side === 'buy') {
      // Pool checks first: the pool must hold the tokens it owes.
      const poolTokens = await pool.getPoolTokenBalance(mintAddress);
      if (poolTokens < tokenAmount) {
        return badRequest(
          res,
          `Pool kehabisan token: pool hanya memegang ${poolTokens.toLocaleString('id-ID')} ${row.ticker}, kamu minta ${tokenAmount.toLocaleString('id-ID')}. Kurangi jumlahnya.`
        );
      }
      // Then the buyer's own leg: they must be able to pay solAmount of
      // the pair asset (+ a small SOL buffer for the tx fee on SOL pairs).
      if (pairAsset.type === 'SOL') {
        const userSol = (await pool.getSolBalanceOf(wallet)) / LAMPORTS_PER_SOL;
        const needed = solAmount + 0.005;
        if (userSol < needed) {
          return badRequest(
            res,
            `Saldo SOL devnet tidak cukup: dompetmu memegang ${userSol.toFixed(4)} SOL, butuh ${needed.toFixed(4)} SOL (termasuk biaya transaksi). Isi saldo lewat faucet devnet.`
          );
        }
      } else {
        const userPair = await pool.getTokenBalanceOf(pairAsset.mint, wallet);
        if (userPair < solAmount) {
          return badRequest(
            res,
            `Saldo ${pairAsset.symbol} tidak cukup: dompetmu memegang ${userPair.toLocaleString('id-ID')} ${pairAsset.symbol} on-chain.`
          );
        }
      }
    } else {
      const userTokens = await pool.getTokenBalanceOf(mintAddress, wallet);
      if (userTokens < tokenAmount) {
        return badRequest(
          res,
          `Saldo token tidak cukup: dompetmu memegang ${userTokens.toLocaleString('id-ID')} ${row.ticker} on-chain.`
        );
      }
      // The pool pays out net of the creator fee, so it only needs the
      // net amount (+ its own tx-fee headroom) on hand. For coin pairs
      // the payout is pair tokens, and the pool still needs SOL for the
      // transfer's tx fee.
      const netSol = solAmount - bonding.creatorFeeSol(solAmount);
      if (pairAsset.type === 'SOL') {
        const poolSol = (await pool.getPoolSolBalance()) / LAMPORTS_PER_SOL;
        const needed = netSol + pool.FEE_BUFFER_LAMPORTS / LAMPORTS_PER_SOL;
        if (poolSol < needed) {
          return badRequest(
            res,
            `Pool kekurangan SOL: pool memegang ${poolSol.toFixed(4)} SOL, butuh ${needed.toFixed(4)} SOL untuk membayar jual ini. Coba jumlah yang lebih kecil atau nanti lagi.`
          );
        }
      } else {
        const poolPair = await pool.getPoolTokenBalance(pairAsset.mint);
        if (poolPair < netSol) {
          return badRequest(
            res,
            `Pool kekurangan ${pairAsset.symbol}: pool memegang ${poolPair.toLocaleString('id-ID')} ${pairAsset.symbol}, butuh ${netSol.toLocaleString('id-ID')} ${pairAsset.symbol} untuk membayar jual ini. Coba jumlah yang lebih kecil atau nanti lagi.`
          );
        }
        const poolSolLamports = await pool.getPoolSolBalance();
        if (poolSolLamports < pool.FEE_BUFFER_LAMPORTS) {
          return badRequest(
            res,
            'Pool kekurangan SOL untuk biaya transaksi pembayaran jual ini. Coba lagi nanti.'
          );
        }
      }
    }
  } catch (err) {
    return res.status(502).json({ error: `Gagal memeriksa saldo on-chain: ${err.message}` });
  }

  const feeSol = bonding.creatorFeeSol(solAmount);
  res.json({
    mintAddress,
    wallet,
    side,
    solAmount,
    tokenAmount,
    price: solAmount / tokenAmount,
    pairAsset: { type: pairAsset.type, symbol: pairAsset.symbol, mint: pairAsset.mint },
    // 1% creator fee on the pair-asset volume. On a buy the buyer pays
    // the full solAmount (fee included); on a sell the seller receives
    // netSolAmount.
    feeSol,
    feePct: CREATOR_FEE_PCT,
    netSolAmount: side === 'sell' ? solAmount - feeSol : solAmount,
    poolAddress: pool.getPoolAddress(),
  });
});

// ---- POST /api/trades/buy ----
// Settle a buy after the user signed their leg: a real SOL transfer to the
// pool (SOL pairs) or a real pair-token transfer to the pool (coin pairs).
// Body: { mintAddress, wallet, solAmount, userTxSignature }
router.post('/trades/buy', async (req, res) => {
  const input = validateTradeInput(req, res, 'buy');
  if (!input) return;
  const { mintAddress, wallet, row, pairAsset } = input;
  const maxTrade = pairAsset.type === 'SOL' ? MAX_TRADE_SOL : MAX_TRADE_TOKENS;
  const solAmount = Number(req.body.solAmount);
  const userTxSignature = req.body.userTxSignature;
  if (!Number.isFinite(solAmount) || solAmount <= 0 || solAmount > maxTrade) {
    return badRequest(res, 'solAmount tidak valid.');
  }
  if (typeof userTxSignature !== 'string' || !SIGNATURE_RE.test(userTxSignature)) {
    return badRequest(res, 'Tanda tangan transaksi tidak valid.');
  }
  if (signatureAlreadyUsed(userTxSignature)) {
    return res.status(409).json({ error: 'Transaksi ini sudah dipakai untuk satu trade.' });
  }

  try {
    const result = await withTradeLock(async () => {
      // Re-read reserves inside the lock: another trade may have landed.
      const fresh = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(mintAddress);
      // 1. Verify the user's leg on-chain: SOL for SOL pairs, a pair-token
      // SPL transfer (user's pair ATA -> pool's pair ATA) for coin pairs.
      if (pairAsset.type === 'SOL') {
        const verified = await verifySolTransfer({
          signature: userTxSignature,
          fromWallet: wallet,
          toWallet: pool.getPoolAddress(),
          lamports: toLamports(solAmount),
        });
        if (!verified.ok) return { status: 422, error: `Verifikasi transfer SOL gagal: ${verified.reason}` };
      } else {
        const userPairAta = await getAssociatedTokenAddress(
          new PublicKey(pairAsset.mint),
          new PublicKey(wallet)
        );
        const poolPairAta = await pool.getPoolAta(pairAsset.mint);
        const verified = await verifyTokenTransfer({
          signature: userTxSignature,
          fromAta: userPairAta.toBase58(),
          toAta: poolPairAta.toBase58(),
          amountRaw: toRawTokens(solAmount),
        });
        if (!verified.ok) {
          return { status: 422, error: `Verifikasi transfer ${pairAsset.symbol} gagal: ${verified.reason}` };
        }
      }

      // 2. Market-order quote at current reserves; pool must hold the tokens.
      const tokenAmount = bonding.quoteBuy(fresh, solAmount);
      const tokenRaw = toRawTokens(tokenAmount);
      if (tokenRaw <= 0n) {
        return { status: 400, error: 'Jumlah terlalu kecil untuk kurva saat ini.' };
      }
      const poolTokens = await pool.getPoolTokenBalance(mintAddress);
      if (poolTokens < tokenAmount) {
        return {
          status: 400,
          error: `Pool kehabisan token saat konfirmasi (tersisa ${poolTokens.toLocaleString('id-ID')} ${fresh.ticker}). SOL-mu tetap di pool — coba lagi dengan jumlah lebih kecil.`,
        };
      }

      // 3. Pool sends the tokens; on failure record it and tell the user.
      const exactTokens = Number(tokenRaw) / 1e6;
      let poolSignature;
      try {
        poolSignature = await pool.sendTokens(mintAddress, wallet, tokenRaw);
      } catch (err) {
        recordFailedTrade({
          mintAddress,
          wallet,
          side: 'buy',
          solAmount,
          tokenAmount: exactTokens,
          userTxSignature,
          error: err.message,
        });
        return {
          status: 502,
          error: `Transfer SOL-mu terkonfirmasi on-chain, tapi pengiriman token dari pool gagal (${err.message}). Transaksimu: ${userTxSignature}. Coba lagi nanti — SOL-mu tercatat di pool.`,
        };
      }

      // 4. Record the trade + update reserves atomically. The 1% creator
      // fee accrues from the full pair-asset amount the buyer paid; it
      // stays in the pool until the creator claims it.
      const price = solAmount / exactTokens;
      const feeSol = bonding.creatorFeeSol(solAmount);
      const { tradeId, now } = recordTradeAndReserves({
        mintAddress,
        wallet,
        side: 'buy',
        solAmount,
        tokenAmount: exactTokens,
        price,
        feeSol,
        userTxSignature,
        poolTxSignature: poolSignature,
        row: fresh,
      });
      return { status: 200, tradeId, now, solAmount, tokenAmount: exactTokens, price, feeSol, poolSignature };
    });

    if (result.status !== 200) {
      return res.status(result.status).json({ error: result.error });
    }
    const ctx = await priceCtx();
    const updated = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(mintAddress);
    const trades = coinTradesAsc(mintAddress);
    const coin = publicCoin(updated, trades, ctx);
    const mine = walletTradesAsc(mintAddress, wallet);
    res.json({
      trade: publicTrade({
        id: result.tradeId,
        mint_address: mintAddress,
        wallet,
        side: 'buy',
        sol_amount: result.solAmount,
        token_amount: result.tokenAmount,
        price: result.price,
        fee_sol: result.feeSol,
        user_tx_signature: userTxSignature,
        pool_tx_signature: result.poolSignature,
        created_at: result.now,
      }, coinAssetUsd(updated, ctx)),
      coin,
      walletPnl: bonding.computePnl(mine, coin.price, coinAssetUsd(updated, ctx)),
    });
  } catch (err) {
    res.status(502).json({ error: `Gagal menyelesaikan beli: ${err.message}` });
  }
});

// ---- POST /api/trades/sell ----
// Settle a sell after the user signed a real token transfer to the pool.
// Body: { mintAddress, wallet, tokenAmount, userTxSignature }
router.post('/trades/sell', async (req, res) => {
  const input = validateTradeInput(req, res, 'sell');
  if (!input) return;
  const { mintAddress, wallet, row, pairAsset } = input;
  const tokenAmount = Number(req.body.tokenAmount);
  const userTxSignature = req.body.userTxSignature;
  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
    return badRequest(res, 'tokenAmount tidak valid.');
  }
  if (typeof userTxSignature !== 'string' || !SIGNATURE_RE.test(userTxSignature)) {
    return badRequest(res, 'Tanda tangan transaksi tidak valid.');
  }
  if (signatureAlreadyUsed(userTxSignature)) {
    return res.status(409).json({ error: 'Transaksi ini sudah dipakai untuk satu trade.' });
  }

  try {
    const result = await withTradeLock(async () => {
      const fresh = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(mintAddress);
      const tokenRaw = toRawTokens(tokenAmount);
      if (tokenRaw <= 0n) return { status: 400, error: 'Jumlah terlalu kecil.' };
      const userAta = await getAssociatedTokenAddress(
        new PublicKey(mintAddress),
        new PublicKey(wallet)
      );
      const poolAta = await pool.getPoolAta(mintAddress);

      // 1. Verify the user's token leg on-chain.
      const verified = await verifyTokenTransfer({
        signature: userTxSignature,
        fromAta: userAta.toBase58(),
        toAta: poolAta.toBase58(),
        amountRaw: tokenRaw,
      });
      if (!verified.ok) {
        return { status: 422, error: `Verifikasi transfer token gagal: ${verified.reason}` };
      }

      // 2. Market-order quote at current reserves; pool must hold the
      // payout (SOL for SOL pairs, pair tokens for coin pairs).
      // The seller receives the quote NET of the 1% creator fee — the fee
      // stays in the pool and accrues to the creator.
      const solAmount = bonding.quoteSell(fresh, tokenAmount);
      const feeSol = bonding.creatorFeeSol(solAmount);
      const netSol = solAmount - feeSol;

      // 3. Pool sends the net payout; on failure record it and tell the
      // user. `exactSol` is the exact payout amount (SOL or pair tokens).
      let poolSignature;
      let exactSol;
      if (pairAsset.type === 'SOL') {
        const lamports = toLamports(netSol);
        if (lamports <= 0) {
          return { status: 400, error: 'Jumlah terlalu kecil untuk kurva saat ini.' };
        }
        const poolSolLamports = await pool.getPoolSolBalance();
        if (poolSolLamports < lamports + pool.FEE_BUFFER_LAMPORTS) {
          return {
            status: 400,
            error: `Pool kekurangan SOL saat konfirmasi (tersisa ${(poolSolLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL). Token-mu tetap di pool — coba lagi dengan jumlah lebih kecil.`,
          };
        }
        exactSol = lamports / LAMPORTS_PER_SOL;
        try {
          poolSignature = await pool.sendSol(wallet, lamports);
        } catch (err) {
          recordFailedTrade({
            mintAddress,
            wallet,
            side: 'sell',
            solAmount: exactSol,
            tokenAmount,
            userTxSignature,
            error: err.message,
          });
          return {
            status: 502,
            error: `Transfer token-mu terkonfirmasi on-chain, tapi pengiriman SOL dari pool gagal (${err.message}). Transaksimu: ${userTxSignature}. Coba lagi nanti — token-mu tercatat di pool.`,
          };
        }
      } else {
        const netRaw = toRawTokens(netSol);
        if (netRaw <= 0n) {
          return { status: 400, error: 'Jumlah terlalu kecil untuk kurva saat ini.' };
        }
        const poolPair = await pool.getPoolTokenBalance(pairAsset.mint);
        if (poolPair < netSol) {
          return {
            status: 400,
            error: `Pool kekurangan ${pairAsset.symbol} saat konfirmasi (tersisa ${poolPair.toLocaleString('id-ID')} ${pairAsset.symbol}). Token-mu tetap di pool — coba lagi dengan jumlah lebih kecil.`,
          };
        }
        const poolSolLamports = await pool.getPoolSolBalance();
        if (poolSolLamports < pool.FEE_BUFFER_LAMPORTS) {
          return {
            status: 400,
            error: `Pool kekurangan SOL untuk biaya transaksi pembayaran jual ini. Token-mu tetap di pool — coba lagi nanti.`,
          };
        }
        exactSol = Number(netRaw) / 1e6;
        try {
          poolSignature = await pool.sendTokens(pairAsset.mint, wallet, netRaw);
        } catch (err) {
          recordFailedTrade({
            mintAddress,
            wallet,
            side: 'sell',
            solAmount: exactSol,
            tokenAmount,
            userTxSignature,
            error: err.message,
          });
          return {
            status: 502,
            error: `Transfer token-mu terkonfirmasi on-chain, tapi pengiriman ${pairAsset.symbol} dari pool gagal (${err.message}). Transaksimu: ${userTxSignature}. Coba lagi nanti — token-mu tercatat di pool.`,
          };
        }
      }

      // 4. Record the trade + update reserves atomically. sol_amount is
      // the gross curve amount (for price/reserves); the fee is stored
      // separately and PnL uses the net proceeds.
      const exactTokens = Number(tokenRaw) / 1e6;
      const price = solAmount / exactTokens;
      const { tradeId, now } = recordTradeAndReserves({
        mintAddress,
        wallet,
        side: 'sell',
        solAmount,
        tokenAmount: exactTokens,
        price,
        feeSol,
        userTxSignature,
        poolTxSignature: poolSignature,
        row: fresh,
      });
      return { status: 200, tradeId, now, solAmount, netSolAmount: exactSol, tokenAmount: exactTokens, price, feeSol, poolSignature };
    });

    if (result.status !== 200) {
      return res.status(result.status).json({ error: result.error });
    }
    const ctx = await priceCtx();
    const updated = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(mintAddress);
    const trades = coinTradesAsc(mintAddress);
    const coin = publicCoin(updated, trades, ctx);
    const mine = walletTradesAsc(mintAddress, wallet);
    res.json({
      trade: publicTrade({
        id: result.tradeId,
        mint_address: mintAddress,
        wallet,
        side: 'sell',
        sol_amount: result.solAmount,
        token_amount: result.tokenAmount,
        price: result.price,
        fee_sol: result.feeSol,
        user_tx_signature: userTxSignature,
        pool_tx_signature: result.poolSignature,
        created_at: result.now,
      }, coinAssetUsd(updated, ctx)),
      netSolAmount: result.netSolAmount,
      coin,
      walletPnl: bonding.computePnl(mine, coin.price, coinAssetUsd(updated, ctx)),
    });
  } catch (err) {
    res.status(502).json({ error: `Gagal menyelesaikan jual: ${err.message}` });
  }
});

// ---- POST /api/coins/:mint/burn ----
// Record a verified burn: the holder destroyed `amount` of their own
// tokens on-chain (real SPL burn via Phantom). The server verifies the
// burn instruction on-chain, then reduces the coin's bonding-curve
// token_reserve by the burned amount — since price = sol_reserve /
// token_reserve, burning raises the price. Burns are allowed regardless
// of trading status (a holder can burn even an unfunded coin).
// Body: { wallet, amount, txSignature }. One signature burns once.
router.post('/coins/:mint/burn', async (req, res) => {
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });
  const { wallet, amount, txSignature } = req.body || {};
  if (typeof wallet !== 'string' || !BASE58_RE.test(wallet)) {
    return badRequest(res, 'Alamat dompet tidak valid.');
  }
  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return badRequest(res, 'Jumlah burn harus lebih dari 0.');
  }
  if (typeof txSignature !== 'string' || !SIGNATURE_RE.test(txSignature)) {
    return badRequest(res, 'Tanda tangan transaksi tidak valid.');
  }
  const existing = db.prepare('SELECT id FROM burns WHERE tx_signature = ?').get(txSignature);
  if (existing) {
    return res.status(409).json({ error: 'Burn ini sudah tercatat.' });
  }
  const amountRaw = toRawTokens(amountNum);
  if (amountRaw <= 0n) {
    return badRequest(res, 'Jumlah terlalu kecil.');
  }
  try {
    const result = await withTradeLock(async () => {
      // Re-read reserves inside the lock: another burn/trade may have
      // landed. The reserve must stay positive after the burn.
      const fresh = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
      if (amountNum >= fresh.token_reserve) {
        return {
          status: 400,
          error: `Jumlah burn melebihi cadangan kurva (${fresh.token_reserve.toLocaleString('id-ID')} ${fresh.ticker}).`,
        };
      }
      // The on-chain burn is the source of truth for the user's balance:
      // burning more than they hold fails on-chain, so a verified burn
      // already proves they held the tokens.
      const verified = await verifyBurn({
        signature: txSignature,
        mintAddress: req.params.mint,
        wallet,
        amountRaw,
      });
      if (!verified.ok) {
        return { status: 422, error: `Verifikasi burn gagal: ${verified.reason}` };
      }
      const newReserve = fresh.token_reserve - amountNum;
      const priceAfter = fresh.sol_reserve / newReserve;
      const now = Date.now();
      const burnId = db.transaction(() => {
        db.prepare('UPDATE coins SET token_reserve = ? WHERE mint_address = ?').run(
          newReserve,
          req.params.mint
        );
        return db
          .prepare(
            `INSERT INTO burns
               (mint_address, wallet, amount, source, price_after, tx_signature, created_at)
             VALUES (?, ?, ?, 'holder', ?, ?, ?)`
          )
          .run(req.params.mint, wallet, amountNum, priceAfter, txSignature, now).lastInsertRowid;
      })();
      return { status: 200, burnId, priceAfter };
    });
    if (result.status !== 200) {
      return res.status(result.status).json({ error: result.error });
    }
    const ctx = await priceCtx();
    const updated = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
    const burnRow = db.prepare('SELECT * FROM burns WHERE id = ?').get(result.burnId);
    res.status(201).json({
      burn: publicBurn(burnRow, coinAssetUsd(updated, ctx)),
      coin: publicCoin(updated, coinTradesAsc(req.params.mint), ctx),
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Burn ini sudah tercatat.' });
    }
    res.status(502).json({ error: `Gagal mencatat burn: ${err.message}` });
  }
});

// ---- POST /api/coins/:mint/dev-burn ----
// Creator-only dev burn with two sources. Body:
//   { wallet, amount, source: 'holdings' | 'pool',
//     txSignature? (holdings only), message?, signature? (pool only) }
//   - 'holdings': the creator burns their OWN tokens — a real SPL
//     BurnChecked signed in Phantom, verified on-chain exactly like a
//     holder burn (the burn transaction itself proves the creator signed
//     it, so no signMessage is needed). Recorded with source 'dev'.
//   - 'pool': the pool wallet burns its own reserve tokens of this coin,
//     server-signed (pool.burnTokens). No user transaction exists, so the
//     creator must prove authorization by signing the canonical dev-burn
//     message (Ed25519, same scheme as follows/profile edits). The burn
//     reduces BOTH the pool's on-chain token balance and the curve's
//     token_reserve by the same amount. Recorded with source 'pool' and
//     the pool address as the wallet.
// Both sources raise the price (token_reserve shrinks, sol_reserve
// unchanged). Creator-only: anyone else gets 403.
router.post('/coins/:mint/dev-burn', async (req, res) => {
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });
  const { wallet, amount, source, txSignature, message, signature } = req.body || {};
  if (typeof wallet !== 'string' || !BASE58_RE.test(wallet)) {
    return badRequest(res, 'Alamat dompet tidak valid.');
  }
  if (wallet !== row.creator_wallet) {
    return res.status(403).json({ error: 'Hanya kreator coin ini yang bisa melakukan dev burn.' });
  }
  if (source !== 'holdings' && source !== 'pool') {
    return badRequest(res, 'source harus "holdings" atau "pool".');
  }
  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return badRequest(res, 'Jumlah burn harus lebih dari 0.');
  }
  const amountRaw = toRawTokens(amountNum);
  if (amountRaw <= 0n) {
    return badRequest(res, 'Jumlah terlalu kecil.');
  }
  // Pool burns are server-signed and destructive, so they need the
  // creator's signature over the canonical message (holdings burns are
  // authenticated by the on-chain burn transaction itself).
  if (source === 'pool') {
    const expected = devBurnMessage({
      wallet,
      mint: req.params.mint,
      amount: String(amountNum),
      source: 'pool',
    });
    if (message !== expected) {
      return res.status(401).json({ error: 'Pesan tanda tangan tidak sesuai dengan dev burn ini.' });
    }
    if (!verifyWalletSignature({ walletAddress: wallet, message, signatureBase64: signature })) {
      return res.status(401).json({ error: 'Tanda tangan tidak valid untuk dompet ini.' });
    }
  } else if (typeof txSignature !== 'string' || !SIGNATURE_RE.test(txSignature)) {
    return badRequest(res, 'Tanda tangan transaksi tidak valid.');
  }
  if (source === 'holdings') {
    const existing = db.prepare('SELECT id FROM burns WHERE tx_signature = ?').get(txSignature);
    if (existing) {
      return res.status(409).json({ error: 'Burn ini sudah tercatat.' });
    }
  }
  try {
    const result = await withTradeLock(async () => {
      // Re-read reserves inside the lock: another burn/trade may have
      // landed. The reserve must stay positive after the burn.
      const fresh = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
      if (amountNum >= fresh.token_reserve) {
        return {
          status: 400,
          error: `Jumlah burn melebihi cadangan kurva (${fresh.token_reserve.toLocaleString('id-ID')} ${fresh.ticker}).`,
        };
      }
      let poolSignature = null;
      if (source === 'holdings') {
        const verified = await verifyBurn({
          signature: txSignature,
          mintAddress: req.params.mint,
          wallet,
          amountRaw,
        });
        if (!verified.ok) {
          return { status: 422, error: `Verifikasi burn gagal: ${verified.reason}` };
        }
      } else {
        // Pool reserve: the pool must actually hold the tokens it is
        // about to burn.
        const poolTokens = await pool.getPoolTokenBalance(req.params.mint);
        if (poolTokens < amountNum) {
          return {
            status: 400,
            error: `Pool hanya memegang ${poolTokens.toLocaleString('id-ID')} ${fresh.ticker} — kurangi jumlah burn.`,
          };
        }
        try {
          poolSignature = await pool.burnTokens(req.params.mint, amountRaw);
        } catch (err) {
          return { status: 502, error: `Burn dari pool gagal on-chain: ${err.message}` };
        }
      }
      const newReserve = fresh.token_reserve - amountNum;
      const priceAfter = fresh.sol_reserve / newReserve;
      const now = Date.now();
      const burnId = db.transaction(() => {
        db.prepare('UPDATE coins SET token_reserve = ? WHERE mint_address = ?').run(
          newReserve,
          req.params.mint
        );
        return db
          .prepare(
            `INSERT INTO burns
               (mint_address, wallet, amount, source, price_after, tx_signature, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            req.params.mint,
            source === 'pool' ? pool.getPoolAddress() : wallet,
            amountNum,
            source === 'pool' ? 'pool' : 'dev',
            priceAfter,
            source === 'pool' ? poolSignature : txSignature,
            now
          ).lastInsertRowid;
      })();
      return { status: 200, burnId, priceAfter };
    });
    if (result.status !== 200) {
      return res.status(result.status).json({ error: result.error });
    }
    const ctx = await priceCtx();
    const updated = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
    const burnRow = db.prepare('SELECT * FROM burns WHERE id = ?').get(result.burnId);
    res.status(201).json({
      burn: publicBurn(burnRow, coinAssetUsd(updated, ctx)),
      coin: publicCoin(updated, coinTradesAsc(req.params.mint), ctx),
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Burn ini sudah tercatat.' });
    }
    res.status(502).json({ error: `Gagal mencatat dev burn: ${err.message}` });
  }
});

// ---- POST /api/coins/register ----
// Body: { mintAddress, name, ticker, description?, creatorWallet,
//         txSignature, fundingTxSignature?, pairMint?, image?: { dataBase64, mimeType } }
// The mint is verified on-chain on devnet before the coin enters the feed.
// When fundingTxSignature is given, the pool's 800M funding is verified too
// and trading is enabled; without it the coin lists with trading disabled.

router.post('/coins/register', async (req, res) => {
  const {
    mintAddress,
    name,
    ticker,
    description,
    creatorWallet,
    txSignature,
    fundingTxSignature,
    pairMint,
    image,
  } = req.body || {};

  if (typeof mintAddress !== 'string' || !BASE58_RE.test(mintAddress)) {
    return badRequest(res, 'Alamat mint tidak valid.');
  }
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 32) {
    return badRequest(res, 'Nama coin harus 1–32 karakter.');
  }
  if (typeof ticker !== 'string' || ticker.trim().length < 1 || ticker.trim().length > 10) {
    return badRequest(res, 'Ticker harus 1–10 karakter.');
  }
  if (description !== undefined && (typeof description !== 'string' || description.length > 500)) {
    return badRequest(res, 'Deskripsi maksimal 500 karakter.');
  }
  if (typeof creatorWallet !== 'string' || !BASE58_RE.test(creatorWallet)) {
    return badRequest(res, 'Alamat dompet kreator tidak valid.');
  }
  if (typeof txSignature !== 'string' || !SIGNATURE_RE.test(txSignature)) {
    return badRequest(res, 'Tanda tangan transaksi tidak valid.');
  }
  if (
    fundingTxSignature !== undefined &&
    fundingTxSignature !== null &&
    (typeof fundingTxSignature !== 'string' || !SIGNATURE_RE.test(fundingTxSignature))
  ) {
    return badRequest(res, 'Tanda tangan transaksi funding tidak valid.');
  }
  // Custom pair: NULL/omitted = SOL (default). Otherwise the pair must be
  // a coin already in the registry, not the new coin itself, and its pair
  // chain must not loop back (see src/pairs.js).
  const pairMintValue =
    pairMint === undefined || pairMint === null || pairMint === '' ? null : pairMint;
  if (pairMintValue !== null) {
    if (typeof pairMintValue !== 'string' || !BASE58_RE.test(pairMintValue)) {
      return badRequest(res, 'Alamat coin pasangan tidak valid.');
    }
    const pairCheck = pairs.validatePairChoice(pairMintValue, mintAddress, loadCoinMap());
    if (!pairCheck.ok) {
      return badRequest(res, pairCheck.reason);
    }
  }

  const existing = db
    .prepare('SELECT mint_address FROM coins WHERE mint_address = ?')
    .get(mintAddress);
  if (existing) {
    return res.status(409).json({ error: 'Coin ini sudah terdaftar.' });
  }

  // Verify the mint on-chain before accepting anything.
  const expectFunded = !!fundingTxSignature;
  const verification = await verifyMint({
    mintAddress,
    creatorWallet,
    txSignature,
    expectFunded,
  });
  if (!verification.ok) {
    return res.status(422).json({ error: `Verifikasi mint gagal: ${verification.reason}` });
  }

  // When funding is claimed, the pool must hold the 800M tokens.
  if (expectFunded) {
    const funding = await verifyFunding({
      mintAddress,
      poolWallet: pool.getPoolAddress(),
    });
    if (!funding.ok) {
      return res.status(422).json({ error: `Verifikasi funding gagal: ${funding.reason}` });
    }
  }

  // Optional logo upload (stored as a file under data/uploads, gitignored).
  let logoUrl = null;
  if (image) {
    const saved = saveUploadImage(image, mintAddress, 'Logo');
    if (saved.error) return badRequest(res, saved.error);
    logoUrl = saved.url;
  }

  const now = Date.now();
  db.prepare(
    `INSERT INTO coins
       (mint_address, name, ticker, description, logo_url, creator_wallet, tx_signature,
        funding_tx_signature, trading_enabled, sol_reserve, token_reserve, pair_mint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    mintAddress,
    name.trim(),
    ticker.trim().toUpperCase(),
    description || '',
    logoUrl,
    creatorWallet,
    txSignature,
    fundingTxSignature || null,
    expectFunded ? 1 : 0,
    bonding.VIRTUAL_SOL,
    bonding.VIRTUAL_TOKENS,
    pairMintValue,
    now
  );

  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(mintAddress);
  const ctx = await priceCtx();
  res.status(201).json({ coin: publicCoin(row, [], ctx), verified: verification });
});

// ---- POST /api/coins/:mint/fund ----
// Enable trading for a coin whose creator skipped funding at launch (or
// whose funding failed): verify the pool holds the 800M tokens, then flip
// trading on. Body: { fundingTxSignature }
router.post('/coins/:mint/fund', async (req, res) => {
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });
  const ctx = await priceCtx();
  if (row.trading_enabled === 1) {
    return res.json({ coin: publicCoin(row, coinTradesAsc(row.mint_address), ctx) });
  }
  const { fundingTxSignature } = req.body || {};
  if (typeof fundingTxSignature !== 'string' || !SIGNATURE_RE.test(fundingTxSignature)) {
    return badRequest(res, 'Tanda tangan transaksi funding tidak valid.');
  }
  const funding = await verifyFunding({
    mintAddress: row.mint_address,
    poolWallet: pool.getPoolAddress(),
  });
  if (!funding.ok) {
    return res.status(422).json({ error: `Verifikasi funding gagal: ${funding.reason}` });
  }
  db.prepare(
    'UPDATE coins SET trading_enabled = 1, funding_tx_signature = ? WHERE mint_address = ?'
  ).run(fundingTxSignature, row.mint_address);
  const updated = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(row.mint_address);
  res.json({ coin: publicCoin(updated, coinTradesAsc(row.mint_address), ctx) });
});

// ---- GET /api/coins/:mint/callouts ----
// Callouts for one coin, newest first, with live PnL vs the current price.
router.get('/coins/:mint/callouts', async (req, res) => {
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });
  const ctx = await priceCtx();
  res.json({ mintAddress: row.mint_address, solUsd: ctx.solUsd, callouts: coinCallouts(row.mint_address, ctx) });
});

// ---- POST /api/coins/:mint/callouts ----
// Publish a callout (max 280 chars) for a coin. Only a wallet with a real
// BUY record for this coin may post — verified from the trades table, so
// every callout carries a "pembeli terverifikasi" marker honestly. Entry
// price (average buy price) and holdings at posting time are computed
// server-side from real trades; the client cannot supply prices.
router.post('/coins/:mint/callouts', async (req, res) => {
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });
  const { wallet, text } = req.body || {};
  if (typeof wallet !== 'string' || !BASE58_RE.test(wallet)) {
    return badRequest(res, 'Alamat dompet tidak valid.');
  }
  if (typeof text !== 'string' || !text.trim()) {
    return badRequest(res, 'Callout tidak boleh kosong.');
  }
  if (text.length > CALLOUT_MAX_CHARS) {
    return badRequest(res, `Callout maksimal ${CALLOUT_MAX_CHARS} karakter.`);
  }
  const buys = walletBuyStats(row.mint_address, wallet);
  if (buys.n === 0 || buys.tokens <= 0) {
    return res.status(403).json({
      error: 'Hanya trader yang pernah membeli coin ini yang bisa membuat callout. Beli dulu, baru posting.',
    });
  }
  const entryPrice = buys.sol / buys.tokens;
  const price = bonding.currentPrice(row);
  const holdings = bonding.computePnl(walletTradesAsc(row.mint_address, wallet), price).holdings;
  const info = db
    .prepare(
      `INSERT INTO callouts
         (mint_address, wallet, text, entry_price, holdings_at_post, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(row.mint_address, wallet, text.trim(), entryPrice, holdings, Date.now());
  const created = db.prepare('SELECT * FROM callouts WHERE id = ?').get(info.lastInsertRowid);
  const ctx = await priceCtx();
  res.status(201).json({
    callout: publicCallout(
      created,
      row,
      coinAssetUsd(row, ctx),
      pairs.pairAssetOf(row, ctx.coinMap).symbol,
      publicProfile(ctx.profileMap.get(wallet))
    ),
  });
});

// ---- GET /api/callouts ----
// Latest callouts across all coins (newest first, max 50).
//   ?following=<wallet> — only callouts by traders that wallet follows
//   ?wallet=<wallet> — only callouts by one wallet
router.get('/callouts', async (req, res) => {
  const following = typeof req.query.following === 'string' ? req.query.following : null;
  const wallet = typeof req.query.wallet === 'string' ? req.query.wallet : null;
  if (following && !BASE58_RE.test(following)) {
    return badRequest(res, 'Parameter following tidak valid.');
  }
  if (wallet && !BASE58_RE.test(wallet)) {
    return badRequest(res, 'Parameter wallet tidak valid.');
  }
  const ctx = await priceCtx();
  let rows;
  if (following) {
    rows = db
      .prepare(
        `SELECT c.* FROM callouts c
         JOIN follows f ON f.following_wallet = c.wallet
         WHERE f.follower_wallet = ?
         ORDER BY c.created_at DESC, c.id DESC LIMIT 50`
      )
      .all(following);
  } else if (wallet) {
    rows = db
      .prepare('SELECT * FROM callouts WHERE wallet = ? ORDER BY created_at DESC, id DESC LIMIT 50')
      .all(wallet);
  } else {
    rows = db
      .prepare('SELECT * FROM callouts ORDER BY created_at DESC, id DESC LIMIT 50')
      .all();
  }
  const out = rows
    .map((row) => {
      const coinRow = ctx.coinMap.get(row.mint_address);
      if (!coinRow) return null;
      return withCoinMeta(
        publicCallout(
          row,
          coinRow,
          coinAssetUsd(coinRow, ctx),
          pairs.pairAssetOf(coinRow, ctx.coinMap).symbol,
          publicProfile(ctx.profileMap.get(row.wallet))
        ),
        coinRow
      );
    })
    .filter(Boolean);
  res.json({ callouts: out, solUsd: ctx.solUsd });
});

// ---- POST /api/coins/:mint/claim-fees ----
// The coin's creator claims their accrued 1% trade fees as a real devnet
// transfer from the pool wallet — SOL for SOL pairs, pair tokens for coin
// pairs. Body: { wallet } — the caller must be the creator; the payout
// always goes to the creator address stored in the DB, never to a
// client-supplied destination, so claiming needs no signature (the worst a
// stranger can do is trigger a payout to the rightful creator). Claiming 0
// is blocked. Serialized with trades via the trade lock because it moves
// pool funds.
router.post('/coins/:mint/claim-fees', async (req, res) => {
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });
  const { wallet } = req.body || {};
  if (typeof wallet !== 'string' || !BASE58_RE.test(wallet)) {
    return badRequest(res, 'Alamat dompet tidak valid.');
  }
  if (wallet !== row.creator_wallet) {
    return res.status(403).json({ error: 'Hanya kreator coin ini yang bisa mengklaim fee-nya.' });
  }
  const totals = coinFeeTotals(row.mint_address);
  if (totals.unclaimedSol <= 0) {
    return badRequest(res, 'Tidak ada fee untuk diklaim — belum ada trading yang menghasilkan fee, atau semuanya sudah diklaim.');
  }
  const pairAsset = pairs.pairAssetOf(row, loadCoinMap());
  if (!pairAsset.available) {
    return badRequest(
      res,
      'Klaim tidak dapat dilakukan: coin pasangan untuk coin ini tidak ditemukan di registry.'
    );
  }

  try {
    const result = await withTradeLock(async () => {
      // Re-compute inside the lock: a trade may have landed meanwhile.
      const fresh = coinFeeTotals(row.mint_address);
      if (fresh.unclaimedSol <= 0) {
        return { status: 400, error: 'Tidak ada fee untuk diklaim.' };
      }
      if (pairAsset.type === 'SOL') {
        const lamports = Math.floor(fresh.unclaimedSol * LAMPORTS_PER_SOL);
        if (lamports <= 0) {
          return { status: 400, error: 'Fee yang belum diklaim terlalu kecil untuk ditransfer.' };
        }
        const poolSolLamports = await pool.getPoolSolBalance();
        if (poolSolLamports < lamports + pool.FEE_BUFFER_LAMPORTS) {
          return {
            status: 400,
            error: `Pool kekurangan SOL untuk membayar klaim ini (pool memegang ${(poolSolLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL, butuh ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL + biaya). Coba lagi nanti.`,
          };
        }
        const signature = await pool.sendSol(row.creator_wallet, lamports);
        const amountSol = lamports / LAMPORTS_PER_SOL;
        const info = db
          .prepare(
            `INSERT INTO fee_claims
               (mint_address, creator_wallet, amount_sol, asset_symbol, tx_signature, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(row.mint_address, row.creator_wallet, amountSol, 'SOL', signature, Date.now());
        return { status: 200, claimId: info.lastInsertRowid, amountSol, signature, assetSymbol: 'SOL' };
      }
      // Coin pair: the fee is paid in pair tokens; the pool also needs SOL
      // for the transfer's tx fee.
      const amountRaw = BigInt(Math.floor(fresh.unclaimedSol * 1e6));
      if (amountRaw <= 0n) {
        return { status: 400, error: 'Fee yang belum diklaim terlalu kecil untuk ditransfer.' };
      }
      const poolPair = await pool.getPoolTokenBalance(pairAsset.mint);
      if (poolPair < fresh.unclaimedSol) {
        return {
          status: 400,
          error: `Pool kekurangan ${pairAsset.symbol} untuk membayar klaim ini (pool memegang ${poolPair.toLocaleString('id-ID')} ${pairAsset.symbol}). Coba lagi nanti.`,
        };
      }
      const poolSolLamports = await pool.getPoolSolBalance();
      if (poolSolLamports < pool.FEE_BUFFER_LAMPORTS) {
        return {
          status: 400,
          error: 'Pool kekurangan SOL untuk biaya transaksi klaim ini. Coba lagi nanti.',
        };
      }
      const signature = await pool.sendTokens(pairAsset.mint, row.creator_wallet, amountRaw);
      const amountSol = Number(amountRaw) / 1e6;
      const info = db
        .prepare(
          `INSERT INTO fee_claims
             (mint_address, creator_wallet, amount_sol, asset_symbol, tx_signature, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(row.mint_address, row.creator_wallet, amountSol, pairAsset.symbol, signature, Date.now());
      return { status: 200, claimId: info.lastInsertRowid, amountSol, signature, assetSymbol: pairAsset.symbol };
    });

    if (result.status !== 200) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({
      claim: {
        id: result.claimId,
        mintAddress: row.mint_address,
        creatorWallet: row.creator_wallet,
        amountSol: result.amountSol,
        assetSymbol: result.assetSymbol,
        txSignature: result.signature,
        createdAt: Date.now(),
      },
      creatorFees: coinFeeTotals(row.mint_address),
    });
  } catch (err) {
    res.status(502).json({ error: `Gagal mengklaim fee: ${err.message}` });
  }
});

// ---- POST /api/coins/:mint/buyback ----
// Creator-only buyback: spend the coin's unclaimed creator-fee balance to
// buy the coin back from the bonding curve. Body:
//   { wallet, amount (number, or 'all' for the full unclaimed balance),
//     message, signature }
// The creator signs the canonical buyback message (Ed25519, same scheme
// as follows/profile edits) — the pool pays the bought tokens to the
// creator from a server-signed transfer, so the request needs proof it
// came from the creator. Creator-only: anyone else gets 403.
// Execution, inside the trade lock:
//   1. The spend is the requested amount ('all' = whatever is unclaimed
//      at execution time). Blocked when unclaimed fees are 0 or the spend
//      is below the minimum buy (0.001 SOL / 1,000 pair tokens).
//   2. The pool sends the bought tokens (curve quote) to the creator as a
//      real on-chain transfer; on failure nothing is recorded and the fee
//      ledger is untouched.
//   3. Atomically: the curve's pair-asset reserve increases by the spend
//      (the pool already holds those fees — no on-chain payment moves for
//      that leg), token_reserve decreases by the tokens bought, the spend
//      is recorded as a fee_claims row (kind 'buyback') so the unclaimed
//      balance drops, and the buyback is recorded as a trade (side 'buy',
//      wallet = creator, fee 0) so the chart, stats, and volume reflect it.
// Accounting note: the fee ledger and the curve stay consistent — the
// invariant poolAssetActual = (assetReserve - VIRTUAL) + unclaimedFees
// holds before and after, because the reserve grows by the spend while
// the unclaimed balance shrinks by the same amount. Buybacks accrue NO
// creator fee (the spend IS the fees — charging a fee on it would be
// circular). Works for SOL pairs and coin pairs (fees accrue in the pair
// asset either way).
router.post('/coins/:mint/buyback', async (req, res) => {
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });
  const { wallet, amount, message, signature } = req.body || {};
  if (typeof wallet !== 'string' || !BASE58_RE.test(wallet)) {
    return badRequest(res, 'Alamat dompet tidak valid.');
  }
  if (wallet !== row.creator_wallet) {
    return res.status(403).json({ error: 'Hanya kreator coin ini yang bisa melakukan buyback.' });
  }
  const isAll = amount === 'all';
  const amountNum = isAll ? NaN : Number(amount);
  if (!isAll && (!Number.isFinite(amountNum) || amountNum <= 0)) {
    return badRequest(res, 'Jumlah buyback harus lebih dari 0.');
  }
  const amountStr = isAll ? 'all' : String(amountNum);
  const expected = buybackMessage({ wallet, mint: req.params.mint, amount: amountStr });
  if (message !== expected) {
    return res.status(401).json({ error: 'Pesan tanda tangan tidak sesuai dengan buyback ini.' });
  }
  if (!verifyWalletSignature({ walletAddress: wallet, message, signatureBase64: signature })) {
    return res.status(401).json({ error: 'Tanda tangan tidak valid untuk dompet ini.' });
  }
  if (row.trading_enabled !== 1) {
    return badRequest(
      res,
      'Trading belum aktif untuk coin ini: kreator belum memindahkan 800.000.000 token ke pool.'
    );
  }
  const pairAsset = pairs.pairAssetOf(row, loadCoinMap());
  if (!pairAsset.available) {
    return badRequest(
      res,
      'Buyback tidak dapat dilakukan: coin pasangan untuk coin ini tidak ditemukan di registry.'
    );
  }
  const minBuy = pairAsset.type === 'SOL' ? MIN_BUY_SOL : MIN_BUY_TOKENS;

  try {
    const result = await withTradeLock(async () => {
      // Re-read reserves + fee totals inside the lock: a trade may have
      // landed meanwhile.
      const fresh = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
      const totals = coinFeeTotals(req.params.mint);
      if (totals.unclaimedSol <= 0) {
        return {
          status: 400,
          error: 'Tidak ada fee untuk buyback — belum ada trading yang menghasilkan fee, atau semuanya sudah diklaim.',
        };
      }
      const spend = isAll ? totals.unclaimedSol : amountNum;
      if (spend > totals.unclaimedSol) {
        return {
          status: 400,
          error: `Jumlah buyback melebihi fee yang belum diklaim (${totals.unclaimedSol} ${pairAsset.symbol}).`,
        };
      }
      if (spend < minBuy) {
        const minLabel = pairAsset.type === 'SOL' ? String(minBuy) : minBuy.toLocaleString('id-ID');
        return { status: 400, error: `Buyback minimal ${minLabel} ${pairAsset.symbol}.` };
      }
      const tokenAmount = bonding.quoteBuy(fresh, spend);
      const tokenRaw = toRawTokens(tokenAmount);
      if (tokenRaw <= 0n) {
        return { status: 400, error: 'Jumlah terlalu kecil untuk kurva saat ini.' };
      }
      const poolTokens = await pool.getPoolTokenBalance(req.params.mint);
      if (poolTokens < tokenAmount) {
        return {
          status: 400,
          error: `Pool kehabisan token: pool hanya memegang ${poolTokens.toLocaleString('id-ID')} ${fresh.ticker}.`,
        };
      }
      // The pool pays the bought tokens to the creator first — only then
      // is anything recorded, so a failed transfer leaves the fee ledger
      // untouched.
      const exactTokens = Number(tokenRaw) / 1e6;
      let poolSignature;
      try {
        poolSignature = await pool.sendTokens(req.params.mint, wallet, tokenRaw);
      } catch (err) {
        return { status: 502, error: `Pengiriman token buyback dari pool gagal: ${err.message}` };
      }
      const price = spend / exactTokens;
      const now = Date.now();
      const ids = db.transaction(() => {
        db.prepare('UPDATE coins SET sol_reserve = ?, token_reserve = ? WHERE mint_address = ?').run(
          fresh.sol_reserve + spend,
          fresh.token_reserve - exactTokens,
          req.params.mint
        );
        const tradeId = db
          .prepare(
            `INSERT INTO trades
               (mint_address, wallet, side, sol_amount, token_amount, price, fee_sol,
                user_tx_signature, pool_tx_signature, created_at)
             VALUES (?, ?, 'buy', ?, ?, ?, 0, NULL, ?, ?)`
          )
          .run(req.params.mint, wallet, spend, exactTokens, price, poolSignature, now).lastInsertRowid;
        const claimId = db
          .prepare(
            `INSERT INTO fee_claims
               (mint_address, creator_wallet, amount_sol, asset_symbol, kind, tx_signature, created_at)
             VALUES (?, ?, ?, ?, 'buyback', ?, ?)`
          )
          .run(req.params.mint, wallet, spend, pairAsset.symbol, poolSignature, now).lastInsertRowid;
        return { tradeId, claimId };
      })();
      return { status: 200, ...ids, spend, tokenAmount: exactTokens, price, poolSignature, now };
    });
    if (result.status !== 200) {
      return res.status(result.status).json({ error: result.error });
    }
    const ctx = await priceCtx();
    const updated = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
    const trades = coinTradesAsc(req.params.mint);
    res.json({
      buyback: {
        tradeId: result.tradeId,
        claimId: result.claimId,
        amountSol: result.spend,
        tokenAmount: result.tokenAmount,
        price: result.price,
        txSignature: result.poolSignature,
        createdAt: result.now,
      },
      trade: publicTrade(
        {
          id: result.tradeId,
          mint_address: req.params.mint,
          wallet,
          side: 'buy',
          sol_amount: result.spend,
          token_amount: result.tokenAmount,
          price: result.price,
          fee_sol: 0,
          user_tx_signature: null,
          pool_tx_signature: result.poolSignature,
          created_at: result.now,
        },
        coinAssetUsd(updated, ctx)
      ),
      coin: publicCoin(updated, trades, ctx),
      creatorFees: coinFeeTotals(req.params.mint),
    });
  } catch (err) {
    res.status(502).json({ error: `Gagal menjalankan buyback: ${err.message}` });
  }
});

// ---- GET /api/creators/:wallet ----
// Public creator/trader profile: coins created, total trading volume,
// creator fees earned/claimed/unclaimed, followers + following.
// Query ?viewer=<wallet> adds isFollowing (viewer follows this creator)
// and isSelf.
router.get('/creators/:wallet', async (req, res) => {
  const wallet = req.params.wallet;
  if (!BASE58_RE.test(wallet)) {
    return badRequest(res, 'Alamat dompet tidak valid.');
  }
  const viewer = typeof req.query.viewer === 'string' ? req.query.viewer : null;

  const ctx = await priceCtx();
  const coinRows = db
    .prepare('SELECT * FROM coins WHERE creator_wallet = ? ORDER BY created_at DESC')
    .all(wallet);
  const coins = coinRows.map((row) => {
    const coin = publicCoin(row, coinTradesAsc(row.mint_address), ctx);
    const fees = coinFeeTotals(row.mint_address);
    coin.feesClaimedSol = fees.totalClaimedSol;
    coin.feesUnclaimedSol = fees.unclaimedSol;
    return coin;
  });

  // USD totals are converted per coin (each coin's own pair-asset rate)
  // and then summed — correct across mixed pairs. The *Sol totals sum
  // pair-asset amounts and are only exact for SOL pairs.
  let totalVolumeSol = 0;
  let totalVolumeUsd = 0;
  let totalFeesEarnedSol = 0;
  let totalFeesEarnedUsd = 0;
  for (const c of coins) {
    totalVolumeSol += c.volumeSol;
    totalFeesEarnedSol += c.totalFeesSol;
    const assetUsd = c.pairAssetUsd;
    if (Number.isFinite(assetUsd) && assetUsd > 0) {
      totalVolumeUsd += c.volumeSol * assetUsd;
      totalFeesEarnedUsd += c.totalFeesSol * assetUsd;
    }
  }
  const totalFeesClaimedSol =
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_sol), 0) AS s FROM fee_claims
          WHERE mint_address IN (SELECT mint_address FROM coins WHERE creator_wallet = ?)`
      )
      .get(wallet).s || 0;

  const { followers, following, followerCount, followingCount } = followLists(wallet);

  // The wallet's callouts, newest first, with live PnL + coin info.
  const calloutRows = db
    .prepare('SELECT * FROM callouts WHERE wallet = ? ORDER BY created_at DESC, id DESC')
    .all(wallet);
  const callouts = calloutRows
    .map((row) => {
      const coinRow = ctx.coinMap.get(row.mint_address);
      if (!coinRow) return null;
      return withCoinMeta(
        publicCallout(
          row,
          coinRow,
          coinAssetUsd(coinRow, ctx),
          pairs.pairAssetOf(coinRow, ctx.coinMap).symbol,
          publicProfile(ctx.profileMap.get(row.wallet))
        ),
        coinRow
      );
    })
    .filter(Boolean);

  // Editable profile of this wallet (username/avatar/border/cover) plus
  // the profiles of the wallets in the follower/following lists, so the
  // UI can show usernames there instead of bare addresses.
  const listProfiles = {};
  for (const w of [...followers, ...following]) {
    const p = publicProfile(ctx.profileMap.get(w));
    if (p) listProfiles[w] = p;
  }

  res.json({
    wallet,
    coins,
    solUsd: ctx.solUsd,
    callouts,
    profile: publicProfile(ctx.profileMap.get(wallet)),
    profiles: listProfiles,
    totalVolumeSol,
    totalVolumeUsd,
    totalFeesEarnedSol,
    totalFeesEarnedUsd,
    totalFeesClaimedSol,
    totalFeesUnclaimedSol: Math.max(0, totalFeesEarnedSol - totalFeesClaimedSol),
    followerCount,
    followingCount,
    followers,
    following,
    isFollowing: viewer ? isFollowing(viewer, wallet) : false,
    isSelf: viewer === wallet,
  });
});

// ---- GET /api/follows/:wallet ----
// A wallet's followers + following lists (addresses) and counts, plus the
// editable profiles of the listed wallets (for usernames/avatars).
router.get('/follows/:wallet', (req, res) => {
  const wallet = req.params.wallet;
  if (!BASE58_RE.test(wallet)) {
    return badRequest(res, 'Alamat dompet tidak valid.');
  }
  const lists = followLists(wallet);
  const profileMap = loadProfileMap();
  const profiles = {};
  for (const w of [...lists.followers, ...lists.following]) {
    const p = publicProfile(profileMap.get(w));
    if (p) profiles[w] = p;
  }
  res.json({ wallet, ...lists, profiles });
});

// ---- POST /api/follows ----
// Follow or unfollow a wallet. Body:
//   { followerWallet, followingWallet, action: 'follow'|'unfollow',
//     message, signature }
// The follower must prove wallet ownership: `message` must be exactly the
// canonical message for this action + target, and `signature` (base64)
// must verify against the follower's address (Ed25519). A wallet cannot
// follow itself. Follow/unfollow are idempotent.
router.post('/follows', (req, res) => {
  const { followerWallet, followingWallet, action, message, signature } = req.body || {};
  if (typeof followerWallet !== 'string' || !BASE58_RE.test(followerWallet)) {
    return badRequest(res, 'Alamat dompet follower tidak valid.');
  }
  if (typeof followingWallet !== 'string' || !BASE58_RE.test(followingWallet)) {
    return badRequest(res, 'Alamat dompet yang diikuti tidak valid.');
  }
  if (action !== 'follow' && action !== 'unfollow') {
    return badRequest(res, 'action harus "follow" atau "unfollow".');
  }
  if (followerWallet === followingWallet) {
    return badRequest(res, 'Kamu tidak bisa mengikuti dirimu sendiri.');
  }
  if (message !== followMessage(action, followingWallet)) {
    return res.status(401).json({ error: 'Pesan tanda tangan tidak sesuai dengan aksi ini.' });
  }
  if (
    !verifyWalletSignature({
      walletAddress: followerWallet,
      message,
      signatureBase64: signature,
    })
  ) {
    return res.status(401).json({ error: 'Tanda tangan tidak valid untuk dompet ini.' });
  }

  const now = Date.now();
  if (action === 'follow') {
    db.prepare(
      'INSERT OR IGNORE INTO follows (follower_wallet, following_wallet, created_at) VALUES (?, ?, ?)'
    ).run(followerWallet, followingWallet, now);
  } else {
    db.prepare(
      'DELETE FROM follows WHERE follower_wallet = ? AND following_wallet = ?'
    ).run(followerWallet, followingWallet);
  }
  const lists = followLists(followingWallet);
  res.json({
    following: action === 'follow',
    followerWallet,
    followingWallet,
    followerCount: lists.followerCount,
  });
});

// ---- GET /api/profiles/:wallet ----
// One wallet's editable profile (username/avatar/border/cover), or null
// when the wallet never set one.
router.get('/profiles/:wallet', (req, res) => {
  const wallet = req.params.wallet;
  if (!BASE58_RE.test(wallet)) {
    return badRequest(res, 'Alamat dompet tidak valid.');
  }
  const row = db.prepare('SELECT * FROM profiles WHERE wallet = ?').get(wallet);
  res.json({ wallet, profile: publicProfile(row) });
});

// ---- POST /api/profiles/:wallet ----
// Edit a wallet's profile. Body:
//   { username?: string | null, border?: string,
//     avatar?: { dataBase64, mimeType } | null,
//     cover?: { dataBase64, mimeType } | null,
//     message, signature }
// Fields omitted from the body are left unchanged; username null clears
// it; avatar/cover null clears the image (omitting keeps the old one).
// Ownership is proven with a Phantom signMessage signature (Ed25519) over
// the canonical profile message (see src/signverify.js), which binds the
// submitted username, border, and the CONTENT of any uploaded image
// (sha256 of its base64 payload) — no signature, no edit (401), and a
// signature from another wallet cannot edit this profile (the wallet is
// part of the message). Username is 3-20 chars [A-Za-z0-9_] and unique
// case-insensitively (409 when taken). Images reuse the coin-logo upload
// validation (PNG/JPEG/GIF/WebP, max ~675 KB) and live under data/uploads
// (ephemeral on Render's free tier — a redeploy wipes them).
router.post('/profiles/:wallet', (req, res) => {
  const wallet = req.params.wallet;
  if (!BASE58_RE.test(wallet)) {
    return badRequest(res, 'Alamat dompet tidak valid.');
  }
  const { username, border, avatar, cover, message, signature } = req.body || {};

  // Validate the submitted fields BEFORE the signature (field rules are
  // public; this also keeps bad requests cheap).
  let newUsername;
  if (username === undefined) newUsername = undefined; // unchanged
  else if (username === null) newUsername = null; // clear
  else if (typeof username === 'string' && USERNAME_RE.test(username)) newUsername = username;
  else {
    return badRequest(res, 'Username harus 3–20 karakter (huruf, angka, underscore).');
  }
  let newBorder;
  if (border === undefined) newBorder = undefined; // unchanged
  else if (typeof border === 'string' && BORDER_PRESETS.includes(border)) newBorder = border;
  else {
    return badRequest(res, 'Gaya border tidak dikenal.');
  }
  // Images are validated (not yet saved) before the signature check so an
  // unauthenticated request can never write a file.
  for (const [img, label] of [
    [avatar, 'Foto profil'],
    [cover, 'Cover'],
  ]) {
    if (img === undefined || img === null) continue;
    const ext = IMAGE_MIME_EXT[img.mimeType];
    if (
      !ext ||
      typeof img.dataBase64 !== 'string' ||
      img.dataBase64.length > MAX_IMAGE_BASE64_LEN ||
      Buffer.from(img.dataBase64, 'base64').length === 0 ||
      Buffer.from(img.dataBase64, 'base64').length > MAX_IMAGE_BYTES
    ) {
      return badRequest(res, `${label} harus berupa gambar PNG/JPEG/GIF/WebP maksimal ~675 KB.`);
    }
  }

  // The canonical message is rebuilt from the SUBMITTED fields (never
  // trusted from the client): username '' when cleared/absent, border
  // 'none' when absent, and the sha256 of each submitted image payload
  // ('' when no image is submitted in this edit).
  const expectedMessage = profileMessage({
    wallet,
    username: newUsername === undefined ? '' : newUsername || '',
    border: newBorder === undefined ? 'none' : newBorder,
    avatarHash: avatar ? sha256Hex(avatar.dataBase64) : '',
    coverHash: cover ? sha256Hex(cover.dataBase64) : '',
  });
  if (message !== expectedMessage) {
    return res.status(401).json({ error: 'Pesan tanda tangan tidak sesuai dengan edit ini.' });
  }
  if (
    !verifyWalletSignature({
      walletAddress: wallet,
      message,
      signatureBase64: signature,
    })
  ) {
    return res.status(401).json({ error: 'Tanda tangan tidak valid untuk dompet ini.' });
  }

  // Username uniqueness, case-insensitive (the UNIQUE COLLATE NOCASE
  // constraint is the backstop; this check gives the clear message).
  if (newUsername) {
    const taken = db
      .prepare('SELECT wallet FROM profiles WHERE username = ? COLLATE NOCASE AND wallet != ?')
      .get(newUsername, wallet);
    if (taken) {
      return res.status(409).json({ error: 'Username sudah dipakai, pilih yang lain.' });
    }
  }

  // Save images now that the edit is authenticated.
  const existing = db.prepare('SELECT * FROM profiles WHERE wallet = ?').get(wallet);
  let avatarUrl = existing ? existing.avatar_url : null;
  let coverUrl = existing ? existing.cover_url : null;
  if (avatar) {
    const saved = saveUploadImage(avatar, `${wallet}-avatar`, 'Foto profil');
    if (saved.error) return badRequest(res, saved.error);
    avatarUrl = saved.url;
  } else if (avatar === null) {
    avatarUrl = null;
  }
  if (cover) {
    const saved = saveUploadImage(cover, `${wallet}-cover`, 'Cover');
    if (saved.error) return badRequest(res, saved.error);
    coverUrl = saved.url;
  } else if (cover === null) {
    coverUrl = null;
  }

  const finalUsername = newUsername === undefined ? existing?.username ?? null : newUsername;
  const finalBorder = newBorder === undefined ? existing?.border ?? 'none' : newBorder;
  const now = Date.now();
  try {
    db.prepare(
      `INSERT INTO profiles (wallet, username, avatar_url, border, cover_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(wallet) DO UPDATE SET
         username = excluded.username,
         avatar_url = excluded.avatar_url,
         border = excluded.border,
         cover_url = excluded.cover_url,
         updated_at = excluded.updated_at`
    ).run(wallet, finalUsername, avatarUrl, finalBorder, coverUrl, now);
  } catch (err) {
    // UNIQUE backstop (e.g. a race between the check above and the write).
    if (/UNIQUE constraint failed: profiles.username/i.test(err.message)) {
      return res.status(409).json({ error: 'Username sudah dipakai, pilih yang lain.' });
    }
    throw err;
  }
  const row = db.prepare('SELECT * FROM profiles WHERE wallet = ?').get(wallet);
  res.json({ wallet, profile: publicProfile(row) });
});

module.exports = router;
