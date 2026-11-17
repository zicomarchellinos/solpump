'use strict';
// Local end-to-end test for solpump's REAL devnet trading model.
// Requires the server running (default http://localhost:3100).
// Seeds test coins directly in the local DB, then checks:
//   1. bonding-curve + PnL math (direct module tests, no server)
//   2. GET /api/pool returns a valid devnet address
//   3. /api/trades/prepare rejects trades on unfunded coins, when the pool
//      is short on tokens/SOL, and on invalid amounts — BEFORE any signing
//   4. /api/trades/buy and /api/trades/sell reject fake user signatures
//      (on-chain verification), and /api/coins/:mint/fund rejects a fake
//      funding signature
//   5. /api/coins/register rejects a fake mint (on-chain verification)
//   6. chart / stats / PnL / portfolio math over DB-seeded real trades,
//      including the recorded user + pool transaction signatures
// The actual Phantom signature steps cannot be exercised here (no wallet
// extension), so no real on-chain trade is executed by this test.
// Run with:
//   node test/e2e.js [baseUrl]

const path = require('path');
const Database = require('better-sqlite3');
const { Keypair } = require('@solana/web3.js');
const bonding = require('../src/bonding');

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:3100';
const WALLET_A = 'HyevJPsT3Yf5MTWMph4LaArUqtKS27ScfHF5Cqim6eek';
const WALLET_B = 'J6uK6XxHL2T2bg8CefLKYTSCwpMeBmTG7Pa9K8NYWSvb';

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok - ${msg}`);
}
function approx(a, b, rel = 1e-9) {
  return Math.abs(a - b) <= Math.abs(b) * rel + 1e-12;
}
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function get(p) {
  const res = await fetch(`${BASE}${p}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${p} -> HTTP ${res.status}: ${data.error || ''}`);
  return data;
}

async function post(p, body, expectStatus = 200) {
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status !== expectStatus) {
    throw new Error(`POST ${p} -> HTTP ${res.status} (expected ${expectStatus}): ${data.error || ''}`);
  }
  return data;
}

async function main() {
  // ---------- 1. Bonding-curve + PnL math (module level) ----------
  console.log('bonding math (module):');
  const fresh = { sol_reserve: 30, token_reserve: 800000000 };
  const tok1 = bonding.quoteBuy(fresh, 1.5);
  assert(approx(tok1, (800000000 * 1.5) / 31.5), `quoteBuy(1.5 SOL) = ${tok1.toFixed(2)} tokens`);
  const after1 = { sol_reserve: 31.5, token_reserve: 800000000 - tok1 };
  const tok2 = bonding.quoteBuy(after1, 0.5);
  assert(approx(tok2, ((800000000 - tok1) * 0.5) / 32), `quoteBuy(0.5 SOL) = ${tok2.toFixed(2)} tokens`);
  const after2 = { sol_reserve: 32, token_reserve: 800000000 - tok1 - tok2 };
  const halfA = tok1 / 2;
  const solOut = bonding.quoteSell(after2, halfA);
  assert(approx(solOut, (32 * halfA) / (after2.token_reserve + halfA)), `quoteSell(half) = ${solOut.toFixed(6)} SOL`);
  const solFor1M = bonding.quoteBuySolForTokens(after2, 1000000);
  assert(
    Number.isFinite(solFor1M) && solFor1M > 0,
    `inverse buy quote for 1M tokens = ${solFor1M.toFixed(6)} SOL`
  );
  assert(
    bonding.quoteBuySolForTokens(after2, 800000000) === Infinity,
    'inverse buy quote is Infinity past the curve'
  );
  assert(
    approx(bonding.INITIAL_PRICE, 30 / 800000000),
    `initial price = ${bonding.INITIAL_PRICE}`
  );
  assert(bonding.FUNDING_TOKENS === 800000000, 'funding is 800M tokens');
  assert(
    bonding.FUNDING_TOKENS_RAW === 800000000000000n,
    'funding raw amount is 800M * 10^6'
  );

  // ---------- 2. Server: seed two coins ----------
  const db = new Database(path.join(__dirname, '..', 'data', 'solpump.db'));
  const mintUnfunded = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const now = Date.now();
  const insertCoin = db.prepare(
    `INSERT INTO coins
       (mint_address, name, ticker, description, logo_url, creator_wallet, tx_signature,
        sol_reserve, token_reserve, trading_enabled, funding_tx_signature, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
  );
  // Coin A: unfunded, trading disabled.
  insertCoin.run(
    mintUnfunded, 'Unfunded Cat', 'UCAT', 'Unfunded test coin', WALLET_A,
    'u'.repeat(88), 30, 800000000, 0, null, now
  );
  // Coin B: "funded" in the DB (the pool holds 0 of this mint on-chain,
  // which is exactly what the pool-short tests rely on). Four real-style
  // trades are seeded below; reserves are their final values.
  const tokBefore = 800000000 - tok1 - tok2;
  const solAfterSell = 32 - solOut;
  const tokAfterSell = tokBefore + halfA;
  const sol3 = (solAfterSell * 1000000) / (tokAfterSell - 1000000);
  const finalSol = solAfterSell + sol3;
  const finalTok = tokAfterSell - 1000000;
  insertCoin.run(
    mint, 'Test Cat', 'TCAT', 'Test coin (e2e)', WALLET_A,
    'x'.repeat(88), finalSol, finalTok, 1, 'f'.repeat(88), now - 60000
  );
  const insertTrade = db.prepare(
    `INSERT INTO trades
       (mint_address, wallet, side, sol_amount, token_amount, price,
        user_tx_signature, pool_tx_signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertTrade.run(mint, WALLET_A, 'buy', 1.5, tok1, 1.5 / tok1, 'a'.repeat(88), 'A'.repeat(88), now - 50000);
  insertTrade.run(mint, WALLET_B, 'buy', 0.5, tok2, 0.5 / tok2, 'b'.repeat(88), 'B'.repeat(88), now - 40000);
  insertTrade.run(mint, WALLET_A, 'sell', solOut, halfA, solOut / halfA, 'c'.repeat(88), 'C'.repeat(88), now - 30000);
  insertTrade.run(mint, WALLET_B, 'buy', sol3, 1000000, sol3 / 1000000, 'd'.repeat(88), 'D'.repeat(88), now - 10000);
  console.log('seeded test coins', mintUnfunded, mint);

  try {
    // ---------- 3. Pool endpoint ----------
    console.log('pool + feed:');
    const pool = await get('/api/pool');
    assert(BASE58_RE.test(pool.address), `pool address is a valid base58 pubkey (${pool.address})`);
    assert(pool.network === 'devnet', 'pool network is devnet');

    // Feed lists both coins; search works; unfunded coin is flagged.
    let feed = await get('/api/coins');
    assert(feed.coins.some((c) => c.mintAddress === mint), 'feed lists the funded test coin');
    const unfunded = feed.coins.find((c) => c.mintAddress === mintUnfunded);
    assert(unfunded && unfunded.tradingEnabled === false, 'unfunded coin reports tradingEnabled=false');
    const funded = feed.coins.find((c) => c.mintAddress === mint);
    assert(funded && funded.tradingEnabled === true, 'funded coin reports tradingEnabled=true');
    assert(funded.fundingTxSignature === 'f'.repeat(88), 'funded coin exposes its funding signature');
    feed = await get('/api/coins?search=tcat');
    assert(feed.coins.length === 1 && feed.coins[0].ticker === 'TCAT', 'search finds the coin');
    assert(approx(funded.price, finalSol / finalTok), 'price = finalSol / finalTok');

    // ---------- 4. Prepare: rejections BEFORE any signing ----------
    console.log('prepare rejections:');
    const notActive = await post(
      '/api/trades/prepare',
      { mintAddress: mintUnfunded, wallet: WALLET_A, side: 'buy', solAmount: 0.1 },
      400
    );
    assert(/Trading belum aktif/.test(notActive.error), 'prepare on unfunded coin rejected');

    // Pool holds 0 TCAT on-chain, so any buy must be refused.
    const poolShort = await post(
      '/api/trades/prepare',
      { mintAddress: mint, wallet: WALLET_A, side: 'buy', solAmount: 0.1 },
      400
    );
    assert(/Pool kehabisan token/.test(poolShort.error), `buy rejected when pool is short: ${poolShort.error}`);

    // Wallet A holds 0 TCAT on-chain, so any sell must be refused.
    const userShort = await post(
      '/api/trades/prepare',
      { mintAddress: mint, wallet: WALLET_A, side: 'sell', tokenAmount: 100 },
      400
    );
    assert(/Saldo token tidak cukup/.test(userShort.error), `sell rejected when user is short: ${userShort.error}`);

    const badAmount = await post(
      '/api/trades/prepare',
      { mintAddress: mint, wallet: WALLET_A, side: 'buy', solAmount: 0 },
      400
    );
    assert(/Beli butuh/.test(badAmount.error), 'prepare with zero amount rejected');

    const tooSmall = await post(
      '/api/trades/prepare',
      { mintAddress: mint, wallet: WALLET_A, side: 'buy', solAmount: 0.0005 },
      400
    );
    assert(/minimal 0.001/.test(tooSmall.error), 'prepare below the minimum buy rejected');

    const unknownCoin = await post(
      '/api/trades/prepare',
      { mintAddress: Keypair.generate().publicKey.toBase58(), wallet: WALLET_A, side: 'buy', solAmount: 0.1 },
      404
    );
    assert(/tidak ditemukan/.test(unknownCoin.error), 'prepare on unknown coin is 404');

    // ---------- 5. Settle: fake signatures rejected on-chain ----------
    // (Each fake verification retries against devnet RPC, ~20s each.)
    console.log('settle rejections (fake signatures, ~40s):');
    const fakeBuy = await post(
      '/api/trades/buy',
      { mintAddress: mint, wallet: WALLET_A, solAmount: 0.1, userTxSignature: 'e'.repeat(88) },
      422
    );
    assert(/Verifikasi transfer SOL gagal/.test(fakeBuy.error), `fake buy rejected: ${fakeBuy.error}`);

    const fakeSell = await post(
      '/api/trades/sell',
      { mintAddress: mint, wallet: WALLET_A, tokenAmount: 100, userTxSignature: 'g'.repeat(88) },
      422
    );
    assert(/Verifikasi transfer token gagal/.test(fakeSell.error), `fake sell rejected: ${fakeSell.error}`);

    const badSig = await post(
      '/api/trades/buy',
      { mintAddress: mint, wallet: WALLET_A, solAmount: 0.1, userTxSignature: 'not-a-signature' },
      400
    );
    assert(/tidak valid/.test(badSig.error), 'malformed signature rejected without an RPC call');

    // The old simulated endpoint is gone.
    const gone = await post(
      '/api/trades',
      { mintAddress: mint, wallet: WALLET_A, side: 'buy', solAmount: 0.1 },
      404
    );
    assert(gone.error, 'old simulated POST /api/trades is gone (404)');

    // ---------- 6. Fund + register: fake signatures rejected ----------
    console.log('fund/register rejections:');
    const fakeFund = await post(
      `/api/coins/${mintUnfunded}/fund`,
      { fundingTxSignature: 'h'.repeat(88) },
      422
    );
    assert(/funding/i.test(fakeFund.error), `fake funding rejected: ${fakeFund.error}`);

    const fakeMint = Keypair.generate().publicKey.toBase58();
    const rejected = await post(
      '/api/coins/register',
      {
        mintAddress: fakeMint,
        name: 'Fake',
        ticker: 'FAKE',
        creatorWallet: WALLET_A,
        txSignature: 'y'.repeat(88),
      },
      422
    );
    assert(/Verifikasi mint gagal/.test(rejected.error), `fake mint rejected: ${rejected.error}`);

    // ---------- 7. Coin detail: chart, stats, PnL, signatures ----------
    console.log('detail + PnL + portfolio:');
    const detail = await get(`/api/coins/${mint}?wallet=${WALLET_A}`);
    assert(detail.chart.length === 5, `chart has 5 points (launch + 4 trades), got ${detail.chart.length}`);
    assert(detail.stats.txCount === 4, 'stats txCount is 4');
    assert(detail.stats.uniqueTraders === 2, 'stats uniqueTraders is 2');
    assert(
      approx(detail.stats.volumeSol, 1.5 + 0.5 + solOut + sol3),
      'volume sums all trade SOL'
    );
    assert(detail.trades.length === 4, 'trade history has 4 rows');
    assert(detail.walletTrades.length === 2, 'wallet A has 2 trades');
    // Trades come back newest-first; find the first seeded trade by signature.
    const firstTrade = detail.trades.find((t) => t.userTxSignature === 'a'.repeat(88));
    assert(
      firstTrade && firstTrade.poolTxSignature === 'A'.repeat(88),
      'trade rows carry both real transaction signatures'
    );
    assert(
      detail.trades.every((t) => t.userTxSignature && t.poolTxSignature),
      'every trade row carries both signatures'
    );
    const pnl = detail.walletPnl;
    assert(approx(pnl.holdings, halfA), `A holdings = half of first buy (${pnl.holdings.toFixed(0)})`);
    assert(approx(pnl.totalBuySol, 1.5), 'A totalBuySol is 1.5');
    assert(approx(pnl.totalSellSol, solOut), 'A totalSellSol matches the sell');
    const avgCost = 1.5 / tok1;
    const expectedRealized = solOut - avgCost * halfA;
    assert(
      approx(pnl.realizedPnlSol, expectedRealized),
      `A realized PnL = ${pnl.realizedPnlSol.toFixed(6)} SOL (expected ${expectedRealized.toFixed(6)})`
    );
    assert(approx(pnl.costBasisSol, 0.75), 'A cost basis is 0.75 SOL (half of 1.5)');
    assert(
      approx(pnl.currentValueSol, halfA * detail.stats.price),
      'A current value = holdings x current price'
    );
    assert(
      approx(pnl.totalPnlSol, pnl.realizedPnlSol + pnl.unrealizedPnlSol),
      'total PnL = realized + unrealized'
    );

    // Portfolio aggregates across the wallet's positions.
    const pf = await get(`/api/portfolio?wallet=${WALLET_A}`);
    assert(pf.positions.length === 1, 'portfolio has 1 position for A');
    assert(pf.summary.coinCount === 1, 'portfolio coinCount is 1');
    assert(pf.summary.totalTrades === 2, 'portfolio totalTrades is 2');
    assert(approx(pf.summary.totalPnlSol, pnl.totalPnlSol), 'portfolio total PnL matches coin PnL');
    assert(
      approx(pf.summary.totalPnlPct, (pnl.totalPnlSol / 1.5) * 100),
      'portfolio ROI matches'
    );

    console.log('\nALL E2E CHECKS PASSED');
  } finally {
    db.prepare('DELETE FROM trades WHERE mint_address IN (?, ?)').run(mint, mintUnfunded);
    db.prepare('DELETE FROM coins WHERE mint_address IN (?, ?)').run(mint, mintUnfunded);
    const left = db.prepare('SELECT COUNT(*) AS n FROM coins').get().n;
    console.log(`test data cleaned; coins remaining in DB: ${left}`);
    db.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
