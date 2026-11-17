'use strict';
// Local end-to-end test for the simulated trading + PnL math.
// Requires the server running (default http://localhost:3100).
// Seeds a test coin directly in the local DB, runs trades via the HTTP API,
// asserts the constant-product math and the average-cost PnL, then removes
// all test data. Run with:
//   node test/e2e.js [baseUrl]

const path = require('path');
const Database = require('better-sqlite3');
const { Keypair } = require('@solana/web3.js');

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
  const db = new Database(path.join(__dirname, '..', 'data', 'solpump.db'));
  const mint = Keypair.generate().publicKey.toBase58();
  const now = Date.now();
  db.prepare(
    `INSERT INTO coins
       (mint_address, name, ticker, description, logo_url, creator_wallet, tx_signature,
        sol_reserve, token_reserve, created_at)
     VALUES (?, 'Test Cat', 'TCAT', 'Test coin (e2e)', NULL, ?, ?, 30, 800000000, ?)`
  ).run(mint, WALLET_A, 'x'.repeat(88), now);
  console.log('seeded test coin', mint);

  try {
    // 1. Feed lists the coin; search works.
    let feed = await get('/api/coins');
    assert(feed.coins.some((c) => c.mintAddress === mint), 'feed lists the test coin');
    feed = await get('/api/coins?search=tcat');
    assert(feed.coins.length === 1 && feed.coins[0].ticker === 'TCAT', 'search finds the coin');
    feed = await get('/api/coins?search=zzz-no-match');
    assert(feed.coins.length === 0, 'search with no match returns empty');
    const listed = (await get('/api/coins')).coins.find((c) => c.mintAddress === mint);
    assert(approx(listed.price, 30 / 800000000), 'initial price = 30 / 800M');
    assert(listed.progressPct === 0, 'initial curve progress is 0%');

    // 2. Wallet A buys 1.5 SOL. Constant product: 800M * 1.5 / 31.5.
    const buy1 = await post('/api/trades', {
      mintAddress: mint, wallet: WALLET_A, side: 'buy', solAmount: 1.5,
    });
    const expectedTokens1 = (800000000 * 1.5) / 31.5;
    assert(
      approx(buy1.trade.tokenAmount, expectedTokens1),
      `buy 1.5 SOL -> ${buy1.trade.tokenAmount.toFixed(2)} tokens (expected ${expectedTokens1.toFixed(2)})`
    );
    assert(approx(buy1.coin.solReserve, 31.5), 'sol reserve is 31.5 after buy');
    assert(approx(buy1.coin.tokenReserve, 800000000 - expectedTokens1), 'token reserve reduced');

    // 3. Wallet B buys 0.5 SOL.
    const buy2 = await post('/api/trades', {
      mintAddress: mint, wallet: WALLET_B, side: 'buy', solAmount: 0.5,
    });
    const expectedTokens2 = ((800000000 - expectedTokens1) * 0.5) / 32;
    assert(
      approx(buy2.trade.tokenAmount, expectedTokens2),
      `buy 0.5 SOL -> ${buy2.trade.tokenAmount.toFixed(2)} tokens`
    );
    assert(approx(buy2.coin.solReserve, 32), 'sol reserve is 32 after second buy');

    // 4. Wallet A sells half its holdings.
    const halfA = expectedTokens1 / 2;
    const solBefore = 32;
    const tokBefore = 800000000 - expectedTokens1 - expectedTokens2;
    const expectedSolOut = (solBefore * halfA) / (tokBefore + halfA);
    const sell1 = await post('/api/trades', {
      mintAddress: mint, wallet: WALLET_A, side: 'sell', tokenAmount: halfA,
    });
    assert(
      approx(sell1.trade.solAmount, expectedSolOut),
      `sell half holdings -> ${sell1.trade.solAmount.toFixed(6)} SOL (expected ${expectedSolOut.toFixed(6)})`
    );

    // 5. Oversell guard: A cannot sell more than it holds.
    const over = await post(
      '/api/trades',
      { mintAddress: mint, wallet: WALLET_A, side: 'sell', tokenAmount: halfA + 1 },
      400
    );
    assert(/Saldo tidak cukup/.test(over.error), 'oversell rejected with holdings message');

    // 6. Buy with tokenAmount (inverse quote).
    const buy3 = await post('/api/trades', {
      mintAddress: mint, wallet: WALLET_B, side: 'buy', tokenAmount: 1000000,
    });
    assert(buy3.trade.solAmount > 0 && buy3.trade.tokenAmount === 1000000, 'buy by token amount works');

    // 7. Coin detail: chart, stats, wallet PnL.
    const detail = await get(`/api/coins/${mint}?wallet=${WALLET_A}`);
    assert(detail.chart.length === 5, `chart has 5 points (launch + 4 trades), got ${detail.chart.length}`);
    assert(detail.stats.txCount === 4, 'stats txCount is 4');
    assert(detail.stats.uniqueTraders === 2, 'stats uniqueTraders is 2');
    assert(
      approx(detail.stats.volumeSol, 1.5 + 0.5 + expectedSolOut + buy3.trade.solAmount),
      'volume sums all trade SOL'
    );
    assert(detail.trades.length === 4, 'trade history has 4 rows');
    assert(detail.walletTrades.length === 2, 'wallet A has 2 trades');
    const pnl = detail.walletPnl;
    assert(approx(pnl.holdings, halfA), `A holdings = half of first buy (${pnl.holdings.toFixed(0)})`);
    assert(approx(pnl.totalBuySol, 1.5), 'A totalBuySol is 1.5');
    assert(approx(pnl.totalSellSol, expectedSolOut), 'A totalSellSol matches the sell');
    // Realized PnL: sold half at avg cost 1.5 / tokens1.
    const avgCost = 1.5 / expectedTokens1;
    const expectedRealized = expectedSolOut - avgCost * halfA;
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

    // 8. Portfolio aggregates across the wallet's positions.
    const pf = await get(`/api/portfolio?wallet=${WALLET_A}`);
    assert(pf.positions.length === 1, 'portfolio has 1 position for A');
    assert(pf.summary.coinCount === 1, 'portfolio coinCount is 1');
    assert(pf.summary.totalTrades === 2, 'portfolio totalTrades is 2');
    assert(approx(pf.summary.totalPnlSol, pnl.totalPnlSol), 'portfolio total PnL matches coin PnL');
    assert(
      approx(pf.summary.totalPnlPct, (pnl.totalPnlSol / 1.5) * 100),
      'portfolio ROI matches'
    );

    // 9. Register endpoint rejects a fake mint (on-chain verification).
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

    console.log('\nALL E2E CHECKS PASSED');
  } finally {
    db.prepare('DELETE FROM trades WHERE mint_address = ?').run(mint);
    db.prepare('DELETE FROM coins WHERE mint_address = ?').run(mint);
    const left = db.prepare('SELECT COUNT(*) AS n FROM coins').get().n;
    console.log(`test data cleaned; coins remaining in DB: ${left}`);
    db.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
