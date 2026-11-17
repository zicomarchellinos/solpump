'use strict';
// solpump API. Mirrors the artifact's actions:
//   GET  /api/coins                 listcoins
//   GET  /api/coins/:mint           getcoin
//   GET  /api/portfolio             getportfolio
//   POST /api/trades                recordtrade (SIMULATION — no on-chain tx)
//   POST /api/coins/register        registercoin (on-chain verified first)

const path = require('path');
const fs = require('fs');
const express = require('express');
const db = require('./db');
const bonding = require('./bonding');
const { verifyMint } = require('./verify');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_TRADE_SOL = 1000;

function badRequest(res, message) {
  return res.status(400).json({ error: message });
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
    createdAt: row.created_at,
  };
}

// ---- GET /api/coins ----
// Query: ?search= (name/ticker) &sort=newest|price|marketcap|volume|change
router.get('/coins', (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const sort = String(req.query.sort || 'newest');
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 60));

  let rows = db.prepare('SELECT * FROM coins ORDER BY created_at DESC').all();
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

// ---- POST /api/trades ----
// SIMULATION ONLY. Body: { mintAddress, wallet, side, solAmount?, tokenAmount? }
// Buy: give solAmount (tokens computed from the curve) or tokenAmount
// (SOL computed from the curve). Sell: give tokenAmount (SOL computed) or
// solAmount (tokens computed). Sells are guarded by current holdings.
router.post('/trades', (req, res) => {
  const { mintAddress, wallet, side } = req.body || {};
  if (typeof mintAddress !== 'string' || !BASE58_RE.test(mintAddress)) {
    return badRequest(res, 'Alamat mint tidak valid.');
  }
  if (typeof wallet !== 'string' || !BASE58_RE.test(wallet)) {
    return badRequest(res, 'Alamat dompet tidak valid.');
  }
  if (side !== 'buy' && side !== 'sell') {
    return badRequest(res, 'side harus "buy" atau "sell".');
  }
  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(mintAddress);
  if (!row) return res.status(404).json({ error: 'Coin tidak ditemukan.' });

  const solIn = Number(req.body.solAmount);
  const tokenIn = Number(req.body.tokenAmount);
  let solAmount;
  let tokenAmount;

  if (side === 'buy') {
    if (Number.isFinite(solIn) && solIn > 0) {
      if (solIn > MAX_TRADE_SOL) {
        return badRequest(res, `Beli maksimal ${MAX_TRADE_SOL} SOL per transaksi.`);
      }
      solAmount = solIn;
      tokenAmount = bonding.quoteBuy(row, solIn);
    } else if (Number.isFinite(tokenIn) && tokenIn > 0) {
      tokenAmount = tokenIn;
      solAmount = bonding.quoteBuySolForTokens(row, tokenIn);
      if (!Number.isFinite(solAmount)) {
        return badRequest(res, 'Jumlah token melebihi sisa kurva.');
      }
    } else {
      return badRequest(res, 'Beli butuh solAmount atau tokenAmount > 0.');
    }
  } else {
    const mine = walletTradesAsc(mintAddress, wallet);
    const holdings = mine.reduce(
      (sum, t) => sum + (t.side === 'buy' ? t.token_amount : -t.token_amount),
      0
    );
    if (Number.isFinite(tokenIn) && tokenIn > 0) {
      tokenAmount = tokenIn;
      solAmount = bonding.quoteSell(row, tokenIn);
    } else if (Number.isFinite(solIn) && solIn > 0) {
      solAmount = solIn;
      tokenAmount = bonding.quoteSellTokensForSol(row, solIn);
      if (!Number.isFinite(tokenAmount)) {
        return badRequest(res, 'Jumlah SOL melebihi cadangan kurva.');
      }
    } else {
      return badRequest(res, 'Jual butuh tokenAmount atau solAmount > 0.');
    }
    if (tokenAmount > holdings + 1e-9) {
      return badRequest(
        res,
        `Saldo tidak cukup: kamu memegang ${holdings.toLocaleString('id-ID')} ${row.ticker}.`
      );
    }
  }

  const price = solAmount / tokenAmount;
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
        `INSERT INTO trades (mint_address, wallet, side, sol_amount, token_amount, price, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(mintAddress, wallet, side, solAmount, tokenAmount, price, now);
    return info.lastInsertRowid;
  });
  const tradeId = apply();

  const updated = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(mintAddress);
  const trades = coinTradesAsc(mintAddress);
  const coin = publicCoin(updated, trades);
  const mine = walletTradesAsc(mintAddress, wallet);
  res.json({
    trade: publicTrade({
      id: tradeId,
      mint_address: mintAddress,
      wallet,
      side,
      sol_amount: solAmount,
      token_amount: tokenAmount,
      price,
      created_at: now,
    }),
    coin,
    walletPnl: bonding.computePnl(mine, coin.price),
  });
});

// ---- POST /api/coins/register ----
// Body: { mintAddress, name, ticker, description?, creatorWallet,
//         txSignature, image?: { dataBase64, mimeType } }
// The mint is verified on-chain on devnet before the coin enters the feed.
const IMAGE_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

router.post('/coins/register', async (req, res) => {
  const { mintAddress, name, ticker, description, creatorWallet, txSignature, image } =
    req.body || {};

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
  if (typeof txSignature !== 'string' || txSignature.length < 64 || txSignature.length > 90) {
    return badRequest(res, 'Tanda tangan transaksi tidak valid.');
  }

  const existing = db
    .prepare('SELECT mint_address FROM coins WHERE mint_address = ?')
    .get(mintAddress);
  if (existing) {
    return res.status(409).json({ error: 'Coin ini sudah terdaftar.' });
  }

  // Verify the mint on-chain before accepting anything.
  const verification = await verifyMint({ mintAddress, creatorWallet, txSignature });
  if (!verification.ok) {
    return res.status(422).json({ error: `Verifikasi mint gagal: ${verification.reason}` });
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
        sol_reserve, token_reserve, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    mintAddress,
    name.trim(),
    ticker.trim().toUpperCase(),
    description || '',
    logoUrl,
    creatorWallet,
    txSignature,
    bonding.VIRTUAL_SOL,
    bonding.VIRTUAL_TOKENS,
    now
  );

  const row = db.prepare('SELECT * FROM coins WHERE mint_address = ?').get(mintAddress);
  res.status(201).json({ coin: publicCoin(row, []), verified: verification });
});

module.exports = router;
