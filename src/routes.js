'use strict';
// solpump API. Trading is REAL devnet trading through the server pool wallet
// (see src/pool.js) — no custom on-chain program:
//   GET  /api/coins                 list coins (?following=<wallet> filters
//                                   to coins by followed creators)
//   GET  /api/coins/:mint           coin detail (chart, stats, trades, PnL,
//                                   creator fees + fee claims)
//   GET  /api/portfolio             wallet portfolio (from recorded trades)
//   GET  /api/pool                  pool wallet address (public)
//   POST /api/trades/prepare        quote + pool/user balance pre-checks
//   POST /api/trades/buy            settle a buy after the user's SOL tx
//   POST /api/trades/sell           settle a sell after the user's token tx
//   POST /api/coins/register        register a verified mint (+ funding)
//   POST /api/coins/:mint/fund      enable trading after a funding transfer
//   POST /api/coins/:mint/claim-fees  creator claims accrued 1% trade fees
//   GET  /api/creators/:wallet      creator profile (coins, volume, fees,
//                                   followers/following, callouts)
//   GET  /api/follows/:wallet       a wallet's followers + following lists
//   POST /api/follows               follow/unfollow (signature-proved)
//   GET  /api/coins/:mint/callouts  callouts for a coin (newest first)
//   POST /api/coins/:mint/callouts  post a callout (verified buyers only)
//   GET  /api/callouts              latest callouts (?following=<wallet>
//                                   filters to followed traders)
//
// Creator fee: 1% of every trade's SOL volume (CREATOR_FEE_BPS in
// src/bonding.js) accrues to the coin's creator. The fee stays in the pool
// wallet (buys add the full SOL, sells pay out net of the fee), so the
// invariant poolSolActual = solReserve + unclaimedFees always holds and a
// claim can always be paid out of the pool.
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
const pool = require('./pool');
const {
  verifyMint,
  verifyFunding,
  verifySolTransfer,
  verifyTokenTransfer,
} = require('./verify');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const { PublicKey } = require('@solana/web3.js');
const { followMessage, verifyWalletSignature } = require('./signverify');

const CREATOR_FEE_PCT = bonding.CREATOR_FEE_BPS / 100; // 1
const CALLOUT_MAX_CHARS = 280;

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const MAX_TRADE_SOL = 1000;
const MIN_BUY_SOL = 0.001;
const LAMPORTS_PER_SOL = 1_000_000_000;

// Serialize trade settlements: one at a time, so two concurrent confirms
// can never overdraw the pool or record against stale reserves.
let tradeQueue = Promise.resolve();
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

function publicCoin(row, trades) {
  const stats = bonding.computeStats(row, trades);
  return {
    mintAddress: row.mint_address,
    name: row.name,
    ticker: row.ticker,
    description: row.description,
    logoUrl: row.logo_url,
    creatorWallet: row.creator_wallet,
    txSignature: row.tx_signature,
    fundingTxSignature: row.funding_tx_signature || null,
    tradingEnabled: row.trading_enabled === 1,
    createdAt: row.created_at,
    solReserve: row.sol_reserve,
    tokenReserve: row.token_reserve,
    ...stats,
  };
}

function publicTrade(row) {
  return {
    id: row.id,
    mintAddress: row.mint_address,
    wallet: row.wallet,
    side: row.side,
    solAmount: row.sol_amount,
    tokenAmount: row.token_amount,
    price: row.price,
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
// from real trades) against the coin's current price.
function publicCallout(row, coinRow) {
  const price = bonding.currentPrice(coinRow);
  const pnlSol = (price - row.entry_price) * row.holdings_at_post;
  const pnlPct =
    row.entry_price > 0 ? ((price - row.entry_price) / row.entry_price) * 100 : 0;
  return {
    id: row.id,
    mintAddress: row.mint_address,
    wallet: row.wallet,
    text: row.text,
    entryPrice: row.entry_price,
    holdingsAtPost: row.holdings_at_post,
    currentPrice: price,
    pnlSol,
    pnlPct,
    isProfit: pnlSol >= 0,
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

function coinCallouts(mintAddress) {
  const coinRow = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(mintAddress);
  if (!coinRow) return [];
  return db
    .prepare('SELECT * FROM callouts WHERE mint_address = ? ORDER BY created_at DESC, id DESC')
    .all(mintAddress)
    .map((row) => publicCallout(row, coinRow));
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

// ---- GET /api/coins ----
// Query: ?search= (name/ticker) &sort=newest|price|marketcap|volume|change
//   &creator=<wallet> (only that creator's coins)
//   &following=<wallet> (only coins by creators that wallet follows)
router.get('/coins', (req, res) => {
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
  const coins = rows.map((row) => publicCoin(row, coinTradesAsc(row.mint_address)));
  switch (sort) {
    case 'price':
      coins.sort((a, b) => b.price - a.price);
      break;
    case 'marketcap':
      coins.sort((a, b) => b.marketCapSol - a.marketCapSol);
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
  res.json({ coins: coins.slice(0, limit) });
});

// ---- GET /api/coins/:mint ----
router.get('/coins/:mint', (req, res) => {
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });

  const trades = coinTradesAsc(row.mint_address);
  const coin = publicCoin(row, trades);
  const wallet = typeof req.query.wallet === 'string' ? req.query.wallet : null;

  const result = {
    coin,
    stats: {
      price: coin.price,
      marketCapSol: coin.marketCapSol,
      changePct: coin.changePct,
      high: coin.high,
      low: coin.low,
      volumeSol: coin.volumeSol,
      totalFeesSol: coin.totalFeesSol,
      txCount: coin.txCount,
      uniqueTraders: coin.uniqueTraders,
      progressPct: coin.progressPct,
    },
    chart: bonding.chartPoints(row, trades),
    trades: trades
      .slice()
      .reverse()
      .slice(0, 100)
      .map(publicTrade),
    // Creator-fee claims for this coin (shown in the transaction history).
    feeClaims: coinFeeClaims(row.mint_address),
    creatorFees: coinFeeTotals(row.mint_address),
    creatorFeePct: CREATOR_FEE_PCT,
    viewerFollowsCreator: wallet ? isFollowing(wallet, row.creator_wallet) : false,
    // Callouts (verified buyers only), newest first, with live PnL.
    callouts: coinCallouts(row.mint_address),
    walletPnl: null,
    walletTrades: [],
  };

  if (wallet) {
    const mine = walletTradesAsc(row.mint_address, wallet);
    result.walletPnl = bonding.computePnl(mine, coin.price);
    result.walletTrades = mine
      .slice()
      .reverse()
      .map(publicTrade);
  }
  res.json(result);
});

// ---- GET /api/portfolio?wallet= ----
router.get('/portfolio', (req, res) => {
  const wallet = req.query.wallet;
  if (typeof wallet !== 'string' || !BASE58_RE.test(wallet)) {
    return badRequest(res, 'Parameter wallet tidak valid.');
  }

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
  };

  for (const row of coins) {
    const mine = walletTradesAsc(row.mint_address, wallet);
    if (mine.length === 0) continue;
    const price = bonding.currentPrice(row);
    const pnl = bonding.computePnl(mine, price);
    positions.push({
      mintAddress: row.mint_address,
      name: row.name,
      ticker: row.ticker,
      logoUrl: row.logo_url,
      price,
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
  }
  summary.totalPnlPct =
    summary.totalBuySol > 0 ? (summary.totalPnlSol / summary.totalBuySol) * 100 : 0;
  summary.isProfit = summary.totalPnlSol >= 0;
  positions.sort((a, b) => b.currentValueSol - a.currentValueSol);

  res.json({ wallet, positions, summary });
});

// ---- Quote helper (shared by prepare + settle) ----
// Returns { solAmount, tokenAmount } for a side, or { error }.
function quoteTrade(row, side, solIn, tokenIn) {
  if (side === 'buy') {
    if (Number.isFinite(solIn) && solIn > 0) {
      if (solIn > MAX_TRADE_SOL) {
        return { error: `Beli maksimal ${MAX_TRADE_SOL} SOL per transaksi.` };
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
  return { mintAddress, wallet, side, row };
}

// ---- POST /api/trades/prepare ----
// Quote a trade and check every on-chain balance BEFORE the user signs
// anything. Body: { mintAddress, wallet, side, solAmount?, tokenAmount? }
router.post('/trades/prepare', async (req, res) => {
  const input = validateTradeInput(req, res);
  if (!input) return;
  const { mintAddress, wallet, side, row } = input;
  const solIn = Number(req.body.solAmount);
  const tokenIn = Number(req.body.tokenAmount);
  const quote = quoteTrade(row, side, solIn, tokenIn);
  if (quote.error) return badRequest(res, quote.error);
  const { solAmount, tokenAmount } = quote;
  if (side === 'buy' && solAmount < MIN_BUY_SOL) {
    return badRequest(res, `Beli minimal ${MIN_BUY_SOL} SOL.`);
  }
  if (toRawTokens(tokenAmount) <= 0n || toLamports(solAmount) <= 0) {
    return badRequest(res, 'Jumlah terlalu kecil.');
  }

  try {
    if (side === 'buy') {
      const poolTokens = await pool.getPoolTokenBalance(mintAddress);
      if (poolTokens < tokenAmount) {
        return badRequest(
          res,
          `Pool kehabisan token: pool hanya memegang ${poolTokens.toLocaleString('id-ID')} ${row.ticker}, kamu minta ${tokenAmount.toLocaleString('id-ID')}. Kurangi jumlahnya.`
        );
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
      // net amount (+ its own tx-fee headroom) on hand.
      const netSol = solAmount - bonding.creatorFeeSol(solAmount);
      const poolSol = (await pool.getPoolSolBalance()) / LAMPORTS_PER_SOL;
      const needed = netSol + pool.FEE_BUFFER_LAMPORTS / LAMPORTS_PER_SOL;
      if (poolSol < needed) {
        return badRequest(
          res,
          `Pool kekurangan SOL: pool memegang ${poolSol.toFixed(4)} SOL, butuh ${needed.toFixed(4)} SOL untuk membayar jual ini. Coba jumlah yang lebih kecil atau nanti lagi.`
        );
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
    // 1% creator fee on the SOL volume. On a buy the buyer pays the full
    // solAmount (fee included); on a sell the seller receives netSolAmount.
    feeSol,
    feePct: CREATOR_FEE_PCT,
    netSolAmount: side === 'sell' ? solAmount - feeSol : solAmount,
    poolAddress: pool.getPoolAddress(),
  });
});

// ---- POST /api/trades/buy ----
// Settle a buy after the user signed a real SOL transfer to the pool.
// Body: { mintAddress, wallet, solAmount, userTxSignature }
router.post('/trades/buy', async (req, res) => {
  const input = validateTradeInput(req, res, 'buy');
  if (!input) return;
  const { mintAddress, wallet, row } = input;
  const solAmount = Number(req.body.solAmount);
  const userTxSignature = req.body.userTxSignature;
  if (!Number.isFinite(solAmount) || solAmount <= 0 || solAmount > MAX_TRADE_SOL) {
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
      // 1. Verify the user's SOL leg on-chain.
      const verified = await verifySolTransfer({
        signature: userTxSignature,
        fromWallet: wallet,
        toWallet: pool.getPoolAddress(),
        lamports: toLamports(solAmount),
      });
      if (!verified.ok) return { status: 422, error: `Verifikasi transfer SOL gagal: ${verified.reason}` };

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
      // fee accrues from the full SOL the buyer paid; it stays in the pool
      // until the creator claims it.
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
    const updated = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(mintAddress);
    const trades = coinTradesAsc(mintAddress);
    const coin = publicCoin(updated, trades);
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
      }),
      coin,
      walletPnl: bonding.computePnl(mine, coin.price),
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
  const { mintAddress, wallet, row } = input;
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

      // 2. Market-order quote at current reserves; pool must hold the SOL.
      // The seller receives the quote NET of the 1% creator fee — the fee
      // stays in the pool and accrues to the creator.
      const solAmount = bonding.quoteSell(fresh, tokenAmount);
      const feeSol = bonding.creatorFeeSol(solAmount);
      const netSol = solAmount - feeSol;
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

      // 3. Pool sends the net SOL; on failure record it and tell the user.
      const exactSol = lamports / LAMPORTS_PER_SOL;
      let poolSignature;
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
    const updated = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(mintAddress);
    const trades = coinTradesAsc(mintAddress);
    const coin = publicCoin(updated, trades);
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
      }),
      netSolAmount: result.netSolAmount,
      coin,
      walletPnl: bonding.computePnl(mine, coin.price),
    });
  } catch (err) {
    res.status(502).json({ error: `Gagal menyelesaikan jual: ${err.message}` });
  }
});

// ---- POST /api/coins/register ----
// Body: { mintAddress, name, ticker, description?, creatorWallet,
//         txSignature, fundingTxSignature?, image?: { dataBase64, mimeType } }
// The mint is verified on-chain on devnet before the coin enters the feed.
// When fundingTxSignature is given, the pool's 800M funding is verified too
// and trading is enabled; without it the coin lists with trading disabled.
const IMAGE_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

router.post('/coins/register', async (req, res) => {
  const {
    mintAddress,
    name,
    ticker,
    description,
    creatorWallet,
    txSignature,
    fundingTxSignature,
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
    const ext = IMAGE_MIME_EXT[image.mimeType];
    if (!ext || typeof image.dataBase64 !== 'string' || image.dataBase64.length > 900000) {
      return badRequest(res, 'Logo harus berupa gambar PNG/JPEG/GIF/WebP maksimal ~675 KB.');
    }
    let buf;
    try {
      buf = Buffer.from(image.dataBase64, 'base64');
    } catch {
      return badRequest(res, 'Logo tidak bisa dibaca.');
    }
    if (buf.length === 0 || buf.length > 675000) {
      return badRequest(res, 'Logo harus berupa gambar PNG/JPEG/GIF/WebP maksimal ~675 KB.');
    }
    const filename = `${mintAddress}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
    logoUrl = `/uploads/${filename}`;
  }

  const now = Date.now();
  db.prepare(
    `INSERT INTO coins
       (mint_address, name, ticker, description, logo_url, creator_wallet, tx_signature,
        funding_tx_signature, trading_enabled, sol_reserve, token_reserve, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    now
  );

  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(mintAddress);
  res.status(201).json({ coin: publicCoin(row, []), verified: verification });
});

// ---- POST /api/coins/:mint/fund ----
// Enable trading for a coin whose creator skipped funding at launch (or
// whose funding failed): verify the pool holds the 800M tokens, then flip
// trading on. Body: { fundingTxSignature }
router.post('/coins/:mint/fund', async (req, res) => {
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });
  if (row.trading_enabled === 1) {
    return res.json({ coin: publicCoin(row, coinTradesAsc(row.mint_address)) });
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
  res.json({ coin: publicCoin(updated, coinTradesAsc(row.mint_address)) });
});

// ---- GET /api/coins/:mint/callouts ----
// Callouts for one coin, newest first, with live PnL vs the current price.
router.get('/coins/:mint/callouts', (req, res) => {
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(req.params.mint);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });
  res.json({ mintAddress: row.mint_address, callouts: coinCallouts(row.mint_address) });
});

// ---- POST /api/coins/:mint/callouts ----
// Publish a callout (max 280 chars) for a coin. Only a wallet with a real
// BUY record for this coin may post — verified from the trades table, so
// every callout carries a "pembeli terverifikasi" marker honestly. Entry
// price (average buy price) and holdings at posting time are computed
// server-side from real trades; the client cannot supply prices.
router.post('/coins/:mint/callouts', (req, res) => {
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
  res.status(201).json({ callout: publicCallout(created, row) });
});

// ---- GET /api/callouts ----
// Latest callouts across all coins (newest first, max 50).
//   ?following=<wallet> — only callouts by traders that wallet follows
//   ?wallet=<wallet> — only callouts by one wallet
router.get('/callouts', (req, res) => {
  const following = typeof req.query.following === 'string' ? req.query.following : null;
  const wallet = typeof req.query.wallet === 'string' ? req.query.wallet : null;
  if (following && !BASE58_RE.test(following)) {
    return badRequest(res, 'Parameter following tidak valid.');
  }
  if (wallet && !BASE58_RE.test(wallet)) {
    return badRequest(res, 'Parameter wallet tidak valid.');
  }
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
  const coinRows = new Map();
  const out = rows
    .map((row) => {
      if (!coinRows.has(row.mint_address)) {
        coinRows.set(
          row.mint_address,
          db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(row.mint_address)
        );
      }
      const coinRow = coinRows.get(row.mint_address);
      if (!coinRow) return null;
      return withCoinMeta(publicCallout(row, coinRow), coinRow);
    })
    .filter(Boolean);
  res.json({ callouts: out });
});

// ---- POST /api/coins/:mint/claim-fees ----
// The coin's creator claims their accrued 1% trade fees as a real devnet
// SOL transfer from the pool wallet. Body: { wallet } — the caller must be
// the creator; the payout always goes to the creator address stored in the
// DB, never to a client-supplied destination, so claiming needs no
// signature (the worst a stranger can do is trigger a payout to the
// rightful creator). Claiming 0 is blocked. Serialized with trades via
// the trade lock because it moves pool SOL.
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

  try {
    const result = await withTradeLock(async () => {
      // Re-compute inside the lock: a trade may have landed meanwhile.
      const fresh = coinFeeTotals(row.mint_address);
      if (fresh.unclaimedSol <= 0) {
        return { status: 400, error: 'Tidak ada fee untuk diklaim.' };
      }
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
             (mint_address, creator_wallet, amount_sol, tx_signature, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(row.mint_address, row.creator_wallet, amountSol, signature, Date.now());
      return { status: 200, claimId: info.lastInsertRowid, amountSol, signature };
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
        txSignature: result.signature,
        createdAt: Date.now(),
      },
      creatorFees: coinFeeTotals(row.mint_address),
    });
  } catch (err) {
    res.status(502).json({ error: `Gagal mengklaim fee: ${err.message}` });
  }
});

// ---- GET /api/creators/:wallet ----
// Public creator/trader profile: coins created, total trading volume,
// creator fees earned/claimed/unclaimed, followers + following.
// Query ?viewer=<wallet> adds isFollowing (viewer follows this creator)
// and isSelf.
router.get('/creators/:wallet', (req, res) => {
  const wallet = req.params.wallet;
  if (!BASE58_RE.test(wallet)) {
    return badRequest(res, 'Alamat dompet tidak valid.');
  }
  const viewer = typeof req.query.viewer === 'string' ? req.query.viewer : null;

  const coinRows = db
    .prepare('SELECT * FROM coins WHERE creator_wallet = ? ORDER BY created_at DESC')
    .all(wallet);
  const coins = coinRows.map((row) => {
    const coin = publicCoin(row, coinTradesAsc(row.mint_address));
    const fees = coinFeeTotals(row.mint_address);
    coin.feesClaimedSol = fees.totalClaimedSol;
    coin.feesUnclaimedSol = fees.unclaimedSol;
    return coin;
  });

  let totalVolumeSol = 0;
  let totalFeesEarnedSol = 0;
  for (const c of coins) {
    totalVolumeSol += c.volumeSol;
    totalFeesEarnedSol += c.totalFeesSol;
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
  const calloutCoinRows = new Map();
  const callouts = calloutRows
    .map((row) => {
      if (!calloutCoinRows.has(row.mint_address)) {
        calloutCoinRows.set(
          row.mint_address,
          db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(row.mint_address)
        );
      }
      const coinRow = calloutCoinRows.get(row.mint_address);
      if (!coinRow) return null;
      return withCoinMeta(publicCallout(row, coinRow), coinRow);
    })
    .filter(Boolean);

  res.json({
    wallet,
    coins,
    callouts,
    totalVolumeSol,
    totalFeesEarnedSol,
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
// A wallet's followers + following lists (addresses) and counts.
router.get('/follows/:wallet', (req, res) => {
  const wallet = req.params.wallet;
  if (!BASE58_RE.test(wallet)) {
    return badRequest(res, 'Alamat dompet tidak valid.');
  }
  const lists = followLists(wallet);
  res.json({ wallet, ...lists });
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

module.exports = router;
