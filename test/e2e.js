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
//   7. creator fees: 1% fee math, fee totals on the detail endpoint,
//      claim validation (non-creator 403, zero claim 400), PnL net of fee
//   8. follows: signature verification (wrong message/signature 401,
//      self-follow 400), follow/unfollow + lists, creator profile
//      aggregation, and the feed's ?following= filter
//   9. market cap = price x 1B supply, everywhere it is exposed — in SOL
//      and in USD (x SOL/USD), with the $K/$M/$B suffix formatter, and a
//      fresh coin starting near a $5K USD market cap at current SOL prices
//  10. SOL/USD price: /api/sol-price, the *Usd fields on coins/stats/
//      trades/PnL/callouts, and the price-API fallback (stale cache, then
//      null — never a crash or NaN)
// The actual Phantom signature steps cannot be exercised here (no wallet
// extension), so no real on-chain trade is executed by this test — and the
// claim success path (a real pool payout) cannot be tested without
// funding the pool with devnet SOL, so only its validation paths are.
// Run with:
//   node test/e2e.js [baseUrl]

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { Keypair } = require('@solana/web3.js');
const bonding = require('../src/bonding');
const solprice = require('../src/solprice');

// A throwaway wallet that can sign follow messages: a real Solana keypair,
// signed with Node's built-in Ed25519 (same scheme Phantom uses).
function makeTestWallet() {
  const kp = Keypair.generate();
  const seed = Buffer.from(kp.secretKey.slice(0, 32));
  const pub = Buffer.from(kp.secretKey.slice(32));
  const keyObject = crypto.createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: pub.toString('base64url'),
      d: seed.toString('base64url'),
    },
    format: 'jwk',
  });
  return {
    address: kp.publicKey.toBase58(),
    sign: (message) =>
      crypto.sign(null, Buffer.from(message, 'utf8'), keyObject).toString('base64'),
  };
}

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
  assert(bonding.VIRTUAL_SOL === 55, 'virtual SOL reserve is 55 (tuned for a ~$5K starting market cap)');
  assert(
    approx(bonding.INITIAL_PRICE, bonding.VIRTUAL_SOL / 800000000),
    `initial price = ${bonding.INITIAL_PRICE}`
  );
  assert(bonding.FUNDING_TOKENS === 800000000, 'funding is 800M tokens');
  assert(
    bonding.FUNDING_TOKENS_RAW === 800000000000000n,
    'funding raw amount is 800M * 10^6'
  );
  assert(bonding.CREATOR_FEE_BPS === 100, 'creator fee is 1% (100 bps)');
  assert(approx(bonding.creatorFeeSol(1.5), 0.015), 'creatorFeeSol(1.5 SOL) = 0.015 SOL');
  assert(approx(bonding.creatorFeeSol(0.0005), 0.000005), 'creatorFeeSol(0.0005 SOL) = 0.000005 SOL');
  // Market cap = current price x 1B total supply.
  const mcFresh = { sol_reserve: bonding.VIRTUAL_SOL, token_reserve: 800000000 };
  assert(
    approx(bonding.marketCapSol(mcFresh), bonding.currentPrice(mcFresh) * 1000000000),
    'marketCapSol = price x 1B supply'
  );
  assert(approx(bonding.marketCapSol(mcFresh), 68.75), `fresh-coin market cap is 68.75 SOL`);
  // Starting market cap in USD at a mocked current SOL price: ~$5K.
  const mockedSolUsd = 72.85; // SOL/USD on 2026-11-17 (Jupiter / CoinGecko)
  const startingMcUsd = bonding.marketCapUsd(mcFresh, mockedSolUsd);
  assert(
    startingMcUsd > 4500 && startingMcUsd < 5500,
    `fresh-coin market cap at $${mockedSolUsd}/SOL is $${startingMcUsd.toFixed(0)} (near $5K)`
  );
  const startingPriceUsd = bonding.INITIAL_PRICE * mockedSolUsd;
  assert(
    startingPriceUsd > 4.5e-6 && startingPriceUsd < 5.5e-6,
    `fresh-coin starting price is ~$${startingPriceUsd.toExponential(2)}`
  );
  // marketCapUsd is null without a usable price (never NaN).
  assert(bonding.marketCapUsd(mcFresh, null) === null, 'marketCapUsd is null without a price');
  assert(bonding.marketCapUsd(mcFresh, NaN) === null, 'marketCapUsd is null for a NaN price');
  assert(bonding.marketCapUsd(mcFresh, 0) === null, 'marketCapUsd is null for a zero price');
  assert(bonding.marketCapUsd(mcFresh, -5) === null, 'marketCapUsd is null for a negative price');
  // Compact USD market-cap suffixes across the full range.
  const mcCases = [
    [4999, '$5K'],
    [5000, '$5K'],
    [5200, '$5.2K'],
    [500000, '$500K'],
    [5000000, '$5M'],
    [12400000, '$12.4M'],
    [50000000, '$50M'],
    [500000000, '$500M'],
    [5000000000, '$5B'],
    [999999, '$1M'],
    [999, '$999'],
    [0, '$0'],
  ];
  for (const [value, expected] of mcCases) {
    assert(
      bonding.fmtMarketCapUsd(value) === expected,
      `fmtMarketCapUsd(${value}) = ${bonding.fmtMarketCapUsd(value)} (expected ${expected})`
    );
  }
  assert(bonding.fmtMarketCapUsd(null) === null, 'fmtMarketCapUsd(null) is null');
  assert(bonding.fmtMarketCapUsd(NaN) === null, 'fmtMarketCapUsd(NaN) is null');
  // Chart points carry priceUsd when a price is given, null otherwise.
  const chartWithUsd = bonding.chartPoints(mcFresh, [], 100);
  assert(
    approx(chartWithUsd[0].priceUsd, bonding.INITIAL_PRICE * 100),
    'chart launch point priceUsd = initial price x SOL/USD'
  );
  assert(
    bonding.chartPoints(mcFresh, [])[0].priceUsd === null,
    'chart priceUsd is null without a price'
  );
  // PnL is net of the creator fee on sells: the seller received
  // solOut - fee, so realized PnL and totalSellSol use the net amount.
  const feeSell = bonding.creatorFeeSol(solOut);
  const pnlNet = bonding.computePnl(
    [
      { side: 'buy', sol_amount: 1.5, token_amount: tok1, fee_sol: bonding.creatorFeeSol(1.5) },
      { side: 'sell', sol_amount: solOut, token_amount: halfA, fee_sol: feeSell },
    ],
    bonding.currentPrice({ sol_reserve: 32 - solOut, token_reserve: 800000000 - tok1 - tok2 + halfA })
  );
  assert(approx(pnlNet.totalSellSol, solOut - feeSell), 'PnL totalSellSol is net of the sell fee');
  assert(
    approx(pnlNet.totalFeesPaidSol, bonding.creatorFeeSol(1.5) + feeSell),
    'PnL totalFeesPaidSol sums buy + sell fees'
  );
  assert(
    approx(pnlNet.realizedPnlSol, solOut - feeSell - (1.5 / tok1) * halfA),
    'PnL realized uses net sell proceeds'
  );
  // PnL USD fields: SOL figures converted at the current rate; null
  // without a price.
  const pnlUsd = bonding.computePnl(
    [
      { side: 'buy', sol_amount: 1.5, token_amount: tok1, fee_sol: bonding.creatorFeeSol(1.5) },
      { side: 'sell', sol_amount: solOut, token_amount: halfA, fee_sol: feeSell },
    ],
    bonding.currentPrice({ sol_reserve: 32 - solOut, token_reserve: 800000000 - tok1 - tok2 + halfA }),
    100
  );
  assert(approx(pnlUsd.totalPnlUsd, pnlUsd.totalPnlSol * 100), 'PnL totalPnlUsd = totalPnlSol x SOL/USD');
  assert(approx(pnlUsd.realizedPnlUsd, pnlUsd.realizedPnlSol * 100), 'PnL realizedPnlUsd = realizedPnlSol x SOL/USD');
  assert(approx(pnlUsd.costBasisUsd, pnlUsd.costBasisSol * 100), 'PnL costBasisUsd = costBasisSol x SOL/USD');
  assert(approx(pnlUsd.avgBuyPriceUsd, pnlUsd.avgBuyPrice * 100), 'PnL avgBuyPriceUsd = avgBuyPrice x SOL/USD');
  assert(pnlNet.totalPnlUsd === null, 'PnL USD fields are null without a price');

  // ---------- 1b. SOL/USD price fallback (module level) ----------
  // The test process itself must not see SOL_USD_PRICE (only the server
  // process is started with it); drop it defensively for this section.
  console.log('sol price fallback (module):');
  const savedEnvPrice = process.env.SOL_USD_PRICE;
  delete process.env.SOL_USD_PRICE;
  const realFetch = globalThis.fetch;
  try {
    solprice.setCachedPriceForTest(123.45);
    let pr = await solprice.getSolUsdPrice();
    assert(pr.price === 123.45 && pr.stale === false, 'fresh cached price is served without a network call');
    // Stale cache + dead network -> last cached price, marked stale.
    solprice.setCachedPriceForTest(123.45, Date.now() - 61_000);
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    pr = await solprice.getSolUsdPrice();
    assert(pr.price === 123.45 && pr.stale === true, 'dead network falls back to the stale cached price');
    // No cache + dead network -> null, never a crash or NaN.
    solprice.clearCacheForTest();
    pr = await solprice.getSolUsdPrice();
    assert(pr.price === null, 'dead network with no cache returns null');
  } finally {
    globalThis.fetch = realFetch;
    solprice.clearCacheForTest();
    if (savedEnvPrice !== undefined) process.env.SOL_USD_PRICE = savedEnvPrice;
  }

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
       (mint_address, wallet, side, sol_amount, token_amount, price, fee_sol,
        user_tx_signature, pool_tx_signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const fee = (sol) => bonding.creatorFeeSol(sol);
  const totalFees = fee(1.5) + fee(0.5) + fee(solOut) + fee(sol3);
  insertTrade.run(mint, WALLET_A, 'buy', 1.5, tok1, 1.5 / tok1, fee(1.5), 'a'.repeat(88), 'A'.repeat(88), now - 50000);
  insertTrade.run(mint, WALLET_B, 'buy', 0.5, tok2, 0.5 / tok2, fee(0.5), 'b'.repeat(88), 'B'.repeat(88), now - 40000);
  insertTrade.run(mint, WALLET_A, 'sell', solOut, halfA, solOut / halfA, fee(solOut), 'c'.repeat(88), 'C'.repeat(88), now - 30000);
  insertTrade.run(mint, WALLET_B, 'buy', sol3, 1000000, sol3 / 1000000, fee(sol3), 'd'.repeat(88), 'D'.repeat(88), now - 10000);
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
    assert(
      approx(funded.marketCapSol, funded.price * 1000000000),
      'feed market cap = price x 1B supply'
    );
    assert(approx(funded.totalFeesSol, totalFees), 'feed totalFeesSol sums the 1% trade fees');

    // SOL/USD price + USD fields. The test server is started with
    // SOL_USD_PRICE=100, so the USD path is exercised; if a server ever
    // has no price, the *Usd fields must be null (SOL fallback), never NaN.
    const solPriceRes = await get('/api/sol-price');
    assert(
      solPriceRes.solUsd === null || (Number.isFinite(solPriceRes.solUsd) && solPriceRes.solUsd > 0),
      `/api/sol-price returns a positive price or null (got ${solPriceRes.solUsd})`
    );
    const solUsd = feed.solUsd;
    if (Number.isFinite(solUsd)) {
      assert(solPriceRes.solUsd === solUsd, 'feed solUsd matches /api/sol-price');
      assert(
        approx(funded.priceUsd, funded.price * solUsd),
        'feed priceUsd = price x SOL/USD'
      );
      assert(
        approx(funded.marketCapUsd, funded.marketCapSol * solUsd),
        'feed marketCapUsd = marketCapSol x SOL/USD'
      );
    } else {
      assert(funded.priceUsd === null, 'feed priceUsd is null without a SOL price');
      assert(funded.marketCapUsd === null, 'feed marketCapUsd is null without a SOL price');
    }

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
    // Sell proceeds are net of the 1% creator fee.
    assert(approx(pnl.totalSellSol, solOut - fee(solOut)), 'A totalSellSol is net of the sell fee');
    assert(
      approx(pnl.totalFeesPaidSol, fee(1.5) + fee(solOut)),
      'A totalFeesPaidSol sums the buy + sell fees'
    );
    const avgCost = 1.5 / tok1;
    const expectedRealized = solOut - fee(solOut) - avgCost * halfA;
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
    // Detail USD fields: stats, chart points, trade rows, wallet PnL.
    if (Number.isFinite(solUsd)) {
      assert(
        approx(detail.stats.priceUsd, detail.stats.price * solUsd),
        'detail priceUsd = price x SOL/USD'
      );
      assert(
        approx(detail.stats.marketCapUsd, detail.stats.marketCapSol * solUsd),
        'detail marketCapUsd = marketCapSol x SOL/USD'
      );
      assert(
        approx(detail.stats.highUsd, detail.stats.high * solUsd) &&
          approx(detail.stats.lowUsd, detail.stats.low * solUsd),
        'detail highUsd/lowUsd = high/low x SOL/USD'
      );
      assert(
        detail.chart.every((pt) => approx(pt.priceUsd, pt.price * solUsd)),
        'chart points carry priceUsd = price x SOL/USD'
      );
      assert(
        detail.trades.every((t) => approx(t.priceUsd, t.price * solUsd)),
        'trade rows carry priceUsd = price x SOL/USD'
      );
      assert(
        approx(pnl.totalPnlUsd, pnl.totalPnlSol * solUsd) &&
          approx(pnl.avgBuyPriceUsd, pnl.avgBuyPrice * solUsd),
        'wallet PnL USD fields = SOL fields x SOL/USD'
      );
    } else {
      assert(detail.stats.priceUsd === null, 'detail priceUsd is null without a SOL price');
      assert(pnl.totalPnlUsd === null, 'wallet PnL USD fields are null without a SOL price');
    }

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
    const pfPos = pf.positions[0];
    assert(
      approx(pfPos.marketCapSol, pfPos.price * 1000000000),
      'portfolio position marketCapSol = price x 1B supply'
    );
    if (Number.isFinite(solUsd)) {
      assert(
        approx(pfPos.priceUsd, pfPos.price * solUsd),
        'portfolio position priceUsd = price x SOL/USD'
      );
      assert(
        approx(pfPos.marketCapUsd, pfPos.marketCapSol * solUsd),
        'portfolio position marketCapUsd = marketCapSol x SOL/USD'
      );
      assert(
        approx(pf.summary.totalPnlUsd, pf.summary.totalPnlSol * solUsd),
        'portfolio summary totalPnlUsd = totalPnlSol x SOL/USD'
      );
      assert(
        approx(pf.summary.totalCurrentValueUsd, pf.summary.totalCurrentValueSol * solUsd),
        'portfolio summary current value USD = SOL x SOL/USD'
      );
    } else {
      assert(pfPos.priceUsd === null, 'portfolio priceUsd is null without a SOL price');
    }

    // ---------- 8. Creator fees, claims, follows, profiles ----------
    console.log('creator fees + claims + follows + profiles:');
    assert(detail.creatorFeePct === 1, 'detail reports a 1% creator fee');
    assert(
      approx(detail.stats.totalFeesSol, totalFees),
      'detail stats totalFeesSol sums the 1% trade fees'
    );
    assert(
      approx(detail.creatorFees.totalEarnedSol, totalFees),
      'creatorFees earned = total fees'
    );
    assert(detail.creatorFees.totalClaimedSol === 0, 'creatorFees claimed starts at 0');
    assert(
      approx(detail.creatorFees.unclaimedSol, totalFees),
      'creatorFees unclaimed = earned before any claim'
    );
    assert(
      Array.isArray(detail.feeClaims) && detail.feeClaims.length === 0,
      'no fee claims yet'
    );
    const sellRow = detail.trades.find((t) => t.side === 'sell');
    assert(approx(sellRow.feeSol, fee(solOut)), 'trade rows carry their 1% fee');
    assert(
      approx(detail.stats.marketCapSol, detail.stats.price * 1000000000),
      'detail market cap = price x 1B supply'
    );

    // Claim validation (the success path needs a funded pool — not testable
    // here without devnet SOL, so only the guards are exercised).
    const notCreator = await post(
      `/api/coins/${mint}/claim-fees`,
      { wallet: WALLET_B },
      403
    );
    assert(/Hanya kreator/.test(notCreator.error), 'non-creator claim is 403');
    const zeroClaim = await post(
      `/api/coins/${mintUnfunded}/claim-fees`,
      { wallet: WALLET_A },
      400
    );
    assert(/Tidak ada fee/.test(zeroClaim.error), 'claiming 0 fees is 400');
    const badClaimWallet = await post(
      `/api/coins/${mint}/claim-fees`,
      { wallet: 'not-an-address' },
      400
    );
    assert(/tidak valid/.test(badClaimWallet.error), 'claim with invalid wallet is 400');

    // Follows: signature verification + rules. The follower is a fresh
    // throwaway wallet that can sign (WALLET_A/B private keys are unknown).
    const follower = makeTestWallet();
    const followMsg = `solpump:follow:${WALLET_A}`;
    const selfFollow = await post(
      '/api/follows',
      {
        followerWallet: WALLET_A,
        followingWallet: WALLET_A,
        action: 'follow',
        message: `solpump:follow:${WALLET_A}`,
        signature: follower.sign(`solpump:follow:${WALLET_A}`),
      },
      400
    );
    assert(/dirimu sendiri/.test(selfFollow.error), 'self-follow is 400');
    const wrongMsg = await post(
      '/api/follows',
      {
        followerWallet: follower.address,
        followingWallet: WALLET_A,
        action: 'follow',
        message: 'solpump:follow:someone-else',
        signature: follower.sign('solpump:follow:someone-else'),
      },
      401
    );
    assert(/tidak sesuai/.test(wrongMsg.error), 'follow with a mismatched message is 401');
    const badFollowSig = await post(
      '/api/follows',
      {
        followerWallet: follower.address,
        followingWallet: WALLET_A,
        action: 'follow',
        message: followMsg,
        signature: follower.sign(`solpump:unfollow:${WALLET_A}`),
      },
      401
    );
    assert(/tidak valid/.test(badFollowSig.error), 'follow with a wrong signature is 401');
    const followed = await post('/api/follows', {
      followerWallet: follower.address,
      followingWallet: WALLET_A,
      action: 'follow',
      message: followMsg,
      signature: follower.sign(followMsg),
    });
    assert(followed.following === true, 'valid signed follow succeeds');
    assert(followed.followerCount === 1, 'followerCount is 1 after the follow');
    // Idempotent: following again does not duplicate.
    await post('/api/follows', {
      followerWallet: follower.address,
      followingWallet: WALLET_A,
      action: 'follow',
      message: followMsg,
      signature: follower.sign(followMsg),
    });
    const lists = await get(`/api/follows/${follower.address}`);
    assert(
      lists.following.length === 1 && lists.following[0] === WALLET_A,
      'following list contains the followed creator'
    );
    assert(lists.followerCount === 0, 'follower has no followers of their own');
    const creatorLists = await get(`/api/follows/${WALLET_A}`);
    assert(
      creatorLists.followers.length === 1 && creatorLists.followers[0] === follower.address,
      'creator followers list contains the follower'
    );

    // Creator profile aggregates coins, volume, fees, followers.
    const profile = await get(`/api/creators/${WALLET_A}?viewer=${follower.address}`);
    assert(profile.coins.length === 2, 'creator profile lists both coins');
    assert(
      approx(profile.totalVolumeSol, 1.5 + 0.5 + solOut + sol3),
      'profile total volume sums all coins'
    );
    assert(approx(profile.totalFeesEarnedSol, totalFees), 'profile total fees earned');
    assert(profile.totalFeesClaimedSol === 0, 'profile fees claimed starts at 0');
    assert(profile.followerCount === 1, 'profile followerCount is 1');
    assert(profile.isFollowing === true, 'viewer follows this creator');
    assert(profile.isSelf === false, 'viewer is not the creator');
    const fundedProfileCoin = profile.coins.find((c) => c.mintAddress === mint);
    assert(
      approx(fundedProfileCoin.feesUnclaimedSol, totalFees),
      'profile coin carries its unclaimed fees'
    );
    const selfProfile = await get(`/api/creators/${WALLET_A}?viewer=${WALLET_A}`);
    assert(selfProfile.isSelf === true, 'own profile reports isSelf');
    assert(selfProfile.isFollowing === false, 'own profile reports isFollowing=false');

    // Feed ?following= filter: only coins by followed creators.
    const followingFeed = await get(`/api/coins?following=${follower.address}`);
    assert(
      followingFeed.coins.length === 2 &&
        followingFeed.coins.every((c) => c.creatorWallet === WALLET_A),
      'following feed shows only the followed creator coins'
    );
    const emptyFeed = await get(`/api/coins?following=${WALLET_B}`);
    assert(emptyFeed.coins.length === 0, 'following feed is empty for a wallet following nobody');
    const creatorFeed = await get(`/api/coins?creator=${WALLET_A}`);
    assert(creatorFeed.coins.length === 2, 'creator feed filter lists the creator coins');

    // Unfollow (signed) removes the follow.
    const unfollowMsg = `solpump:unfollow:${WALLET_A}`;
    const unfollowed = await post('/api/follows', {
      followerWallet: follower.address,
      followingWallet: WALLET_A,
      action: 'unfollow',
      message: unfollowMsg,
      signature: follower.sign(unfollowMsg),
    });
    assert(unfollowed.following === false, 'valid signed unfollow succeeds');
    assert(unfollowed.followerCount === 0, 'followerCount is 0 after the unfollow');
    const afterUnfollow = await get(`/api/follows/${follower.address}`);
    assert(afterUnfollow.following.length === 0, 'following list is empty after unfollow');

    // ---------- 9. Callouts: verified buyers only, server-side entry ----------
    console.log('callouts:');
    const noBuyer = Keypair.generate().publicKey.toBase58();
    const noBuyPost = await post(
      `/api/coins/${mint}/callouts`,
      { wallet: noBuyer, text: 'To the moon!' },
      403
    );
    assert(/pernah membeli/.test(noBuyPost.error), 'wallet with no buy cannot post a callout (403)');
    const tooLong = await post(
      `/api/coins/${mint}/callouts`,
      { wallet: WALLET_B, text: 'x'.repeat(281) },
      400
    );
    assert(/280/.test(tooLong.error), 'callout over 280 chars is 400');
    const emptyPost = await post(
      `/api/coins/${mint}/callouts`,
      { wallet: WALLET_B, text: '   ' },
      400
    );
    assert(/kosong/.test(emptyPost.error), 'empty callout is 400');
    const unknownCallout = await post(
      `/api/coins/${Keypair.generate().publicKey.toBase58()}/callouts`,
      { wallet: WALLET_B, text: 'Hi' },
      404
    );
    assert(/tidak ditemukan/.test(unknownCallout.error), 'callout on unknown coin is 404');
    // B's buys: 0.5 SOL for tok2 + sol3 for 1M tokens; B never sold.
    const bEntry = (0.5 + sol3) / (tok2 + 1000000);
    const bHoldings = tok2 + 1000000;
    const currentPrice = finalSol / finalTok;
    // A client-supplied entryPrice must be ignored: the server derives it
    // from real trades.
    const created = await post(
      `/api/coins/${mint}/callouts`,
      { wallet: WALLET_B, text: 'TCAT masih awal, kurva baru jalan!', entryPrice: 999 },
      201
    );
    const c = created.callout;
    assert(approx(c.entryPrice, bEntry), `callout entry price = avg buy price (${c.entryPrice})`);
    assert(approx(c.holdingsAtPost, bHoldings), 'callout holdings = net holdings at posting');
    assert(approx(c.currentPrice, currentPrice), 'callout current price matches the coin price');
    assert(
      approx(c.pnlSol, (currentPrice - bEntry) * bHoldings),
      'callout live PnL (SOL) = (current - entry) x holdings'
    );
    assert(
      approx(c.pnlPct, ((currentPrice - bEntry) / bEntry) * 100),
      'callout live PnL (%) = price move vs entry'
    );
    if (Number.isFinite(solUsd)) {
      assert(
        approx(c.entryPriceUsd, bEntry * solUsd) &&
          approx(c.currentPriceUsd, currentPrice * solUsd) &&
          approx(c.pnlUsd, c.pnlSol * solUsd),
        'callout USD fields = SOL fields x SOL/USD'
      );
    } else {
      assert(c.entryPriceUsd === null, 'callout USD fields are null without a SOL price');
    }
    const coinCallouts = await get(`/api/coins/${mint}/callouts`);
    assert(
      coinCallouts.callouts.length === 1 && coinCallouts.callouts[0].id === c.id,
      'coin callouts endpoint lists the new callout'
    );
    const detail2 = await get(`/api/coins/${mint}`);
    assert(
      detail2.callouts.length === 1 && detail2.callouts[0].text.includes('masih awal'),
      'coin detail includes the callout'
    );
    const profileB = await get(`/api/creators/${WALLET_B}`);
    assert(
      profileB.callouts.length === 1 && profileB.callouts[0].coinTicker === 'TCAT',
      'creator profile lists the trader callout with its coin'
    );
    // Following feed: callouts from followed traders only.
    const followBMsg = `solpump:follow:${WALLET_B}`;
    await post('/api/follows', {
      followerWallet: follower.address,
      followingWallet: WALLET_B,
      action: 'follow',
      message: followBMsg,
      signature: follower.sign(followBMsg),
    });
    const followingCallouts = await get(`/api/callouts?following=${follower.address}`);
    assert(
      followingCallouts.callouts.length === 1 && followingCallouts.callouts[0].id === c.id,
      'following callouts feed shows the followed trader callout'
    );
    const otherCallouts = await get(`/api/callouts?following=${WALLET_A}`);
    assert(otherCallouts.callouts.length === 0, 'following feed is empty when nobody followed posts');

    console.log('\nALL E2E CHECKS PASSED');
  } finally {
    db.prepare('DELETE FROM trades WHERE mint_address IN (?, ?)').run(mint, mintUnfunded);
    db.prepare('DELETE FROM fee_claims WHERE mint_address IN (?, ?)').run(mint, mintUnfunded);
    db.prepare('DELETE FROM callouts WHERE mint_address IN (?, ?)').run(mint, mintUnfunded);
    db.prepare('DELETE FROM coins WHERE mint_address IN (?, ?)').run(mint, mintUnfunded);
    db.prepare('DELETE FROM follows WHERE follower_wallet = ? OR following_wallet = ?').run(
      WALLET_A, WALLET_A
    );
    db.prepare('DELETE FROM follows WHERE follower_wallet = ? OR following_wallet = ?').run(
      WALLET_B, WALLET_B
    );
    const left = db.prepare('SELECT COUNT(*) AS n FROM coins').get().n;
    console.log(`test data cleaned; coins remaining in DB: ${left}`);
    db.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
