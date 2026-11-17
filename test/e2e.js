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
//   9. market cap = price x circulating supply (1B minus total burned),
//      everywhere it is exposed — in SOL and in USD (x SOL/USD), with
//      the $K/$M/$B suffix formatter, and a fresh coin starting near a
//      $5K USD market cap at current SOL prices
//  10. SOL/USD price: /api/sol-price, the *Usd fields on coins/stats/
//      trades/PnL/callouts, and the price-API fallback (stale cache, then
//      null — never a crash or NaN)
//  11. burn: circulating supply, price-after-burn math, market cap on
//      circulating supply, and the burn endpoint's validation (fake burn
//      signature rejected on-chain, amount >= reserve rejected)
//  12. candles: OHLC aggregation per time bucket (empty buckets produce
//      no candle) and the /api/coins/:mint/candles endpoint
//  13. transfers: validation (bad recipient, self-transfer, bad amount,
//      unknown coin, fake signature rejected on-chain) + transfer history
//  14. custom pairs: pair-asset registry + USD resolution through a pair
//      chain (module level), the /api/pairs endpoint, pair-coin pricing
//      on the detail endpoint, cycle/self/unknown-pair rejection at
//      registration, pair-aware prepare (min buy in pair tokens, pool
//      pair-asset checks), and the graceful unresolvable-pair fallback
//      (pair coin missing from the registry: price in pair asset only,
//      trading disabled, no crash)
//  15. one wallet, many coins: no UNIQUE constraint or per-wallet limit
//      on creator_wallet (schema + register endpoint), and the same
//      wallet's coins all appear in the feed and on its creator profile
//      with their own stats
//  16. editable profiles: username validation + case-insensitive
//      uniqueness, the signature requirement (no signature / wrong
//      wallet / wrong message all 401), non-owner cannot edit, avatar
//      upload validation, and the profile surfacing on the creator
//      endpoint, feed coin cards (creatorProfile), callouts
//      (authorProfile), and follow lists (profiles map)
//  17. dev burn: the burn-preview calculation (current vs projected
//      price / supply / market cap, % burned, price gain) against
//      hand-computed values, creator-only guards (403), the pool-burn
//      signature requirement (401 without a valid signature), the
//      pool-short guard, fake holdings-burn rejection on-chain (422),
//      and the burn source (holder/dev/pool) in burn history
//  18. buyback: the buyback-preview calculation (tokens out, new price)
//      against the bonding module, creator-only guards (403), the
//      signature requirement (401), the no-fees / below-minimum /
//      above-unclaimed / pool-short guards (400), and the fee-claim
//      kind ('claim' vs 'buyback') on the detail endpoint
// The actual Phantom signature steps cannot be exercised here (no wallet
// extension), so no real on-chain trade is executed by this test — and the
// claim success path (a real pool payout) cannot be tested without
// funding the pool with devnet SOL, so only its validation paths are.
// The same holds for the pool-burn and buyback success paths: the pool
// holds 0 of the seeded fake mints on-chain, so only their validation
// paths are testable here; the pool-burn transaction construction is a
// single standard BurnChecked instruction (the same instruction the
// client burn already exercises in test/mint-flow.js).
// Run with:
//   node test/e2e.js [baseUrl]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { Keypair } = require('@solana/web3.js');
const bonding = require('../src/bonding');
const pairs = require('../src/pairs');
const solprice = require('../src/solprice');
const {
  profileMessage,
  devBurnMessage,
  buybackMessage,
  sha256Hex,
} = require('../src/signverify');

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
  // Market cap = current price x CIRCULATING supply (1B minus total
  // burned); with zero burns it equals the old price x 1B formula.
  const mcFresh = { sol_reserve: bonding.VIRTUAL_SOL, token_reserve: 800000000 };
  assert(
    approx(bonding.marketCapSol(mcFresh), bonding.currentPrice(mcFresh) * 1000000000),
    'marketCapSol = price x 1B supply (zero burns)'
  );
  assert(
    approx(bonding.circulatingSupply(0), 1000000000),
    'circulatingSupply(0) = 1B'
  );
  assert(
    approx(bonding.circulatingSupply(100000000), 900000000),
    'circulatingSupply(100M burned) = 900M'
  );
  assert(
    approx(bonding.circulatingSupply(2000000000), 0),
    'circulatingSupply never goes below 0'
  );
  assert(
    approx(bonding.marketCapSol(mcFresh, 100000000), bonding.currentPrice(mcFresh) * 900000000),
    'marketCapSol with 100M burned = price x 900M circulating'
  );
  // Burning raises the price: price = sol_reserve / token_reserve, and a
  // burn shrinks token_reserve (the burned tokens belonged to the user,
  // not the pool, so the pool invariant is untouched).
  const priceBefore = bonding.currentPrice(mcFresh);
  const priceAfter100M = bonding.priceAfterBurn(mcFresh, 100000000);
  assert(
    approx(priceAfter100M, 55 / 700000000),
    `priceAfterBurn(100M) = ${priceAfter100M} (was ${priceBefore})`
  );
  assert(priceAfter100M > priceBefore, 'burning 100M tokens raises the price');
  const effect = bonding.burnPriceEffect(mcFresh, 100000000);
  assert(
    approx(effect.pctChange, (priceAfter100M / priceBefore - 1) * 100),
    `burnPriceEffect pct = ${effect.pctChange.toFixed(2)}%`
  );
  assert(
    bonding.priceAfterBurn(mcFresh, 800000000) === null,
    'priceAfterBurn is null when the burn would empty the reserve'
  );
  assert(
    bonding.priceAfterBurn(mcFresh, 900000000) === null,
    'priceAfterBurn is null when the burn exceeds the reserve'
  );
  // Candle aggregation: OHLC per bucket, volume sums trade amounts,
  // empty buckets produce NO candle (never a zero candle).
  const candlePts = [
    { t: 60000, price: 10, amount: 1 },
    { t: 90000, price: 12, amount: 2 },
    { t: 119000, price: 11, amount: 3 },
    { t: 300000, price: 20, amount: 5 },
  ];
  const candles = bonding.buildCandles(candlePts, 60000);
  assert(candles.length === 2, `buildCandles(1m) yields 2 candles for 2 non-empty buckets, got ${candles.length}`);
  assert(
    candles[0].t === 60000 && candles[0].open === 10 && candles[0].high === 12 &&
      candles[0].low === 10 && candles[0].close === 11 && candles[0].volume === 6 &&
      candles[0].count === 3,
    'first candle OHLC/volume/count are correct'
  );
  assert(
    candles[1].t === 300000 && candles[1].open === 20 && candles[1].close === 20 &&
      candles[1].volume === 5 && candles[1].count === 1,
    'second candle (single trade) OHLC/volume/count are correct'
  );
  assert(
    bonding.buildCandles([], 60000).length === 0,
    'buildCandles with no points yields no candles'
  );
  assert(
    bonding.buildCandles([{ t: 0, price: 5, amount: 0 }], 60000)[0].volume === 0,
    'a launch/burn point (amount 0) adds no volume'
  );
  // Chart points merge burns as price-only points (side 'burn').
  const chartWithBurn = bonding.chartPoints(
    mcFresh,
    [],
    null,
    [{ created_at: Date.now(), price_after: 9.5e-8 }]
  );
  assert(
    chartWithBurn.length === 2 && chartWithBurn[1].side === 'burn' && chartWithBurn[1].amount === 0,
    'chartPoints merges burns as price-only points'
  );
  // computeStats reports burns.
  const statsWithBurn = bonding.computeStats(mcFresh, [], null, 250000000);
  assert(
    statsWithBurn.totalBurned === 250000000 && statsWithBurn.circulatingSupply === 750000000,
    'computeStats reports totalBurned + circulatingSupply'
  );

  // ---------- 1a. Custom pairs (module level) ----------
  console.log('custom pairs (module):');
  const pairMap = new Map([
    ['MINT_SOL', { mint_address: 'MINT_SOL', ticker: 'BASE', name: 'Base', sol_reserve: 55, token_reserve: 800000000, pair_mint: null }],
    ['MINT_L1', { mint_address: 'MINT_L1', ticker: 'L1', name: 'Level 1', sol_reserve: 100, token_reserve: 700000000, pair_mint: 'MINT_SOL' }],
    ['MINT_L2', { mint_address: 'MINT_L2', ticker: 'L2', name: 'Level 2', sol_reserve: 50, token_reserve: 600000000, pair_mint: 'MINT_L1' }],
    ['MINT_ORPHAN', { mint_address: 'MINT_ORPHAN', ticker: 'ORPH', name: 'Orphan', sol_reserve: 55, token_reserve: 800000000, pair_mint: 'MINT_GONE' }],
  ]);
  const solAsset = pairs.pairAssetOf(pairMap.get('MINT_SOL'), pairMap);
  assert(solAsset.type === 'SOL' && solAsset.symbol === 'SOL' && solAsset.available === true, 'SOL pair asset for a NULL pair_mint');
  const coinAsset = pairs.pairAssetOf(pairMap.get('MINT_L1'), pairMap);
  assert(coinAsset.type === 'COIN' && coinAsset.symbol === 'BASE' && coinAsset.available === true, 'coin pair asset resolves the pair ticker');
  const orphanAsset = pairs.pairAssetOf(pairMap.get('MINT_ORPHAN'), pairMap);
  assert(orphanAsset.type === 'COIN' && orphanAsset.available === false && orphanAsset.symbol === '?', 'missing pair coin reports available=false');
  assert(pairs.pairLabel('L1', coinAsset) === 'L1/BASE', 'pairLabel is TICKER/PAIR-TICKER');
  assert(pairs.pairLabel('BASE', solAsset) === 'BASE/SOL', 'pairLabel is TICKER/SOL for SOL pairs');
  // USD resolution through the chain: L2 price (in L1) x L1 price (in
  // BASE) x BASE price (in SOL) x SOL/USD.
  const baseUsd = (55 / 800000000) * 100;
  const l1Usd = (100 / 700000000) * baseUsd;
  const l2Usd = (50 / 600000000) * l1Usd;
  assert(
    approx(pairs.resolveTokenUsdPrice('MINT_SOL', pairMap, 100), baseUsd),
    'SOL-pair USD price = price x SOL/USD'
  );
  assert(
    approx(pairs.resolveTokenUsdPrice('MINT_L1', pairMap, 100), l1Usd),
    '1-hop pair-chain USD price resolves'
  );
  assert(
    approx(pairs.resolveTokenUsdPrice('MINT_L2', pairMap, 100), l2Usd),
    '2-hop pair-chain USD price resolves'
  );
  assert(
    pairs.resolveTokenUsdPrice('MINT_ORPHAN', pairMap, 100) === null,
    'unresolvable chain (missing pair coin) yields null, never a crash'
  );
  assert(
    pairs.resolveTokenUsdPrice('MINT_SOL', pairMap, null) === null,
    'no SOL/USD price yields null'
  );
  assert(
    approx(pairs.resolvePairAssetUsdPrice(pairMap.get('MINT_L1'), pairMap, 100), baseUsd),
    'resolvePairAssetUsdPrice returns the pair coin USD price'
  );
  assert(
    pairs.resolvePairAssetUsdPrice(pairMap.get('MINT_SOL'), pairMap, 100) === 100,
    'resolvePairAssetUsdPrice returns SOL/USD for SOL pairs'
  );
  // Cycle detection: A -> B -> A must resolve to null, not loop forever.
  const cyclicMap = new Map([
    ['A', { mint_address: 'A', ticker: 'A', sol_reserve: 55, token_reserve: 800000000, pair_mint: 'B' }],
    ['B', { mint_address: 'B', ticker: 'B', sol_reserve: 55, token_reserve: 800000000, pair_mint: 'A' }],
  ]);
  assert(
    pairs.resolveTokenUsdPrice('A', cyclicMap, 100) === null,
    'cyclic pair chain resolves to null (cycle detection)'
  );
  // Depth limit: a 7-hop chain exceeds MAX_PAIR_DEPTH (5) and is null.
  const deepMap = new Map([
    ['D0', { mint_address: 'D0', ticker: 'D0', sol_reserve: 55, token_reserve: 800000000, pair_mint: null }],
  ]);
  for (let i = 1; i <= 7; i++) {
    deepMap.set(`D${i}`, { mint_address: `D${i}`, ticker: `D${i}`, sol_reserve: 55, token_reserve: 800000000, pair_mint: `D${i - 1}` });
  }
  assert(
    pairs.resolveTokenUsdPrice('D7', deepMap, 100) === null,
    'chain deeper than MAX_PAIR_DEPTH resolves to null'
  );
  assert(
    Number.isFinite(pairs.resolveTokenUsdPrice('D5', deepMap, 100)),
    'chain at exactly MAX_PAIR_DEPTH still resolves'
  );
  // validatePairChoice.
  assert(pairs.validatePairChoice(null, 'NEW', pairMap).ok, 'SOL pair is always valid');
  assert(pairs.validatePairChoice('MINT_SOL', 'NEW', pairMap).ok, 'pair with an existing coin is valid');
  const selfPair = pairs.validatePairChoice('MINT_L1', 'MINT_L1', pairMap);
  assert(!selfPair.ok && /dirinya sendiri/.test(selfPair.reason), 'a coin cannot pair with itself');
  const unknownPair = pairs.validatePairChoice('MINT_NOPE', 'NEW', pairMap);
  assert(!unknownPair.ok && /tidak ditemukan/.test(unknownPair.reason), 'unknown pair coin is rejected');
  const cyclicChoice = pairs.validatePairChoice('B', 'A', cyclicMap);
  assert(!cyclicChoice.ok && /melingkar/.test(cyclicChoice.reason), 'a pair forming a cycle is rejected');
  const deepChoice = pairs.validatePairChoice('D7', 'NEW', deepMap);
  assert(!deepChoice.ok && /terlalu dalam/.test(deepChoice.reason), 'a pair chain that is too deep is rejected');
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

  // ---------- 2. Server: seed four coins ----------
  const db = new Database(path.join(__dirname, '..', 'data', 'solpump.db'));
  const mintUnfunded = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const mintPair = Keypair.generate().publicKey.toBase58();
  const mintOrphan = Keypair.generate().publicKey.toBase58();
  const mintGone = Keypair.generate().publicKey.toBase58(); // never registered
  const now = Date.now();
  const insertCoin = db.prepare(
    `INSERT INTO coins
       (mint_address, name, ticker, description, logo_url, creator_wallet, tx_signature,
        sol_reserve, token_reserve, trading_enabled, funding_tx_signature, pair_mint, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // Coin A: unfunded, trading disabled.
  insertCoin.run(
    mintUnfunded, 'Unfunded Cat', 'UCAT', 'Unfunded test coin', WALLET_A,
    'u'.repeat(88), 30, 800000000, 0, null, null, now
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
    'x'.repeat(88), finalSol, finalTok, 1, 'f'.repeat(88), null, now - 60000
  );
  // Coin C: paired with TCAT (creator WALLET_B, so WALLET_A's counts in
  // the profile/feed assertions stay at 2). Fresh curve, trading on.
  insertCoin.run(
    mintPair, 'Pair Dog', 'PDOG', 'Coin paired with TCAT (e2e)', WALLET_B,
    'p'.repeat(88), 55, 800000000, 1, 'q'.repeat(88), mint, now - 30000
  );
  // Coin D: paired with a mint that is NOT in the registry — the
  // unresolvable-pair fallback (e.g. after a database reset).
  insertCoin.run(
    mintOrphan, 'Orphan Fox', 'OFOX', 'Coin with a missing pair (e2e)', WALLET_B,
    'r'.repeat(88), 55, 800000000, 1, 's'.repeat(88), mintGone, now - 20000
  );
  // Coins E + F: dev-burn / buyback test coins. Their creator is a
  // throwaway wallet whose private key the test controls (WALLET_A/B
  // private keys are unknown), so valid creator signatures can be made.
  // Coin E has one seeded 2 SOL buy (0.02 SOL unclaimed creator fees);
  // its reserves are the post-trade values. Coin F has no trades at all
  // (0 fees) for the no-fees buyback guard.
  const devWallet = makeTestWallet();
  const otherWallet = makeTestWallet();
  const mintDev = Keypair.generate().publicKey.toBase58();
  const mintNoFees = Keypair.generate().publicKey.toBase58();
  const tokDev = (800000000 * 2) / (55 + 2);
  const devSol = 57;
  const devTok = 800000000 - tokDev;
  insertCoin.run(
    mintDev, 'Dev Burn Cat', 'DBCAT', 'Dev-burn / buyback test coin (e2e)', devWallet.address,
    'v'.repeat(88), devSol, devTok, 1, 'w'.repeat(88), null, now - 15000
  );
  insertCoin.run(
    mintNoFees, 'No Fees Fox', 'NFFOX', 'No-fees test coin (e2e)', devWallet.address,
    'y'.repeat(88), 55, 800000000, 1, 'z'.repeat(88), null, now - 10000
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
  // Coin E's single trade: a 2 SOL buy (0.02 SOL creator fees).
  const devFee = fee(2);
  insertTrade.run(mintDev, WALLET_B, 'buy', 2, tokDev, 2 / tokDev, devFee, 't'.repeat(88), 'T'.repeat(88), now - 5000);
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

    // ---------- 10. Pair picker options ----------
    console.log('pairs endpoint:');
    const pairsRes = await get('/api/pairs');
    assert(Array.isArray(pairsRes.pairs), 'GET /api/pairs returns a pairs array');
    const solPair = pairsRes.pairs.find((p) => p.type === 'SOL');
    assert(solPair && solPair.symbol === 'SOL', 'pairs list starts with SOL');
    const tcatPair = pairsRes.pairs.find((p) => p.mint === mint);
    assert(tcatPair && tcatPair.symbol === 'TCAT' && tcatPair.type === 'COIN', 'pairs list includes the listed TCAT coin');
    const pdogPair = pairsRes.pairs.find((p) => p.mint === mintPair);
    assert(pdogPair && pdogPair.symbol === 'PDOG', 'pairs list includes PDOG');

    // ---------- 11. Custom-pair pricing + fallbacks ----------
    console.log('custom-pair pricing:');
    const pairDetail = await get(`/api/coins/${mintPair}`);
    assert(pairDetail.coin.pairLabel === 'PDOG/TCAT', `pair coin label is PDOG/TCAT (got ${pairDetail.coin.pairLabel})`);
    assert(
      pairDetail.coin.pairAsset.type === 'COIN' && pairDetail.coin.pairAsset.symbol === 'TCAT' &&
        pairDetail.coin.pairAsset.available === true,
      'pair coin reports its TCAT pair asset as available'
    );
    const tcatPriceUsd = funded.priceUsd; // TCAT USD price from the feed
    if (Number.isFinite(tcatPriceUsd) && Number.isFinite(solUsd)) {
      const pdogPrice = 55 / 800000000; // PDOG price in TCAT
      assert(
        approx(pairDetail.stats.price, pdogPrice),
        'pair coin price is quoted in the pair asset'
      );
      assert(
        approx(pairDetail.coin.pairAssetUsd, tcatPriceUsd),
        'pairAssetUsd is the pair coin USD price'
      );
      assert(
        approx(pairDetail.stats.priceUsd, pdogPrice * tcatPriceUsd),
        'pair coin USD price = price in pair asset x pair coin USD price'
      );
      assert(
        approx(pairDetail.stats.marketCapUsd, pdogPrice * tcatPriceUsd * 1000000000),
        'pair coin market cap USD = USD price x 1B supply'
      );
    }
    // Unresolvable pair: the pair coin is missing from the registry, so
    // the price shows in the pair asset only (no USD, no crash) and
    // trading is disabled with a clear explanation.
    const orphanDetail = await get(`/api/coins/${mintOrphan}`);
    assert(
      orphanDetail.coin.pairAsset.available === false,
      'orphan coin reports its pair as unavailable'
    );
    assert(orphanDetail.coin.pairLabel === 'OFOX/?', `orphan pair label is OFOX/? (got ${orphanDetail.coin.pairLabel})`);
    assert(orphanDetail.stats.priceUsd === null, 'orphan coin has no USD price');
    assert(orphanDetail.stats.marketCapUsd === null, 'orphan coin has no USD market cap');
    assert(
      approx(orphanDetail.stats.marketCapSol, (55 / 800000000) * 1000000000),
      'orphan market cap is shown in the pair asset instead'
    );
    const orphanPrepare = await post(
      '/api/trades/prepare',
      { mintAddress: mintOrphan, wallet: WALLET_A, side: 'buy', solAmount: 1000 },
      400
    );
    assert(
      /tidak ditemukan di registry/.test(orphanPrepare.error),
      `prepare on a coin with a missing pair is rejected with an explanation: ${orphanPrepare.error}`
    );

    // Pair-aware prepare: the min buy is 1,000 pair tokens (not 0.001
    // SOL), and the pool-short check still runs for the new coin.
    const pairTooSmall = await post(
      '/api/trades/prepare',
      { mintAddress: mintPair, wallet: WALLET_A, side: 'buy', solAmount: 500 },
      400
    );
    assert(
      /Beli minimal 1.000 TCAT/.test(pairTooSmall.error),
      `pair-coin min buy is 1,000 pair tokens: ${pairTooSmall.error}`
    );
    const pairPoolShort = await post(
      '/api/trades/prepare',
      { mintAddress: mintPair, wallet: WALLET_A, side: 'buy', solAmount: 100000 },
      400
    );
    assert(
      /Pool kehabisan token/.test(pairPoolShort.error),
      `pair-coin buy rejected when the pool holds 0 of the new coin: ${pairPoolShort.error}`
    );
    const pairSellShort = await post(
      '/api/trades/prepare',
      { mintAddress: mintPair, wallet: WALLET_A, side: 'sell', tokenAmount: 100 },
      400
    );
    assert(
      /Saldo token tidak cukup/.test(pairSellShort.error),
      'pair-coin sell rejected when the user holds 0 of the coin'
    );

    // Register-time pair validation runs BEFORE the mint verification,
    // so these rejections need no RPC call.
    const selfPairReg = await post(
      '/api/coins/register',
      {
        mintAddress: mintPair,
        name: 'Self',
        ticker: 'SELF',
        creatorWallet: WALLET_A,
        txSignature: 'z'.repeat(88),
        pairMint: mintPair,
      },
      400
    );
    assert(/dirinya sendiri/.test(selfPairReg.error), 'register with a self-pair is 400');
    const unknownPairReg = await post(
      '/api/coins/register',
      {
        mintAddress: Keypair.generate().publicKey.toBase58(),
        name: 'Ghost',
        ticker: 'GHOST',
        creatorWallet: WALLET_A,
        txSignature: 'z'.repeat(88),
        pairMint: mintGone,
      },
      400
    );
    assert(/tidak ditemukan/.test(unknownPairReg.error), 'register with an unknown pair coin is 400');
    const badPairAddr = await post(
      '/api/coins/register',
      {
        mintAddress: Keypair.generate().publicKey.toBase58(),
        name: 'Bad',
        ticker: 'BAD',
        creatorWallet: WALLET_A,
        txSignature: 'z'.repeat(88),
        pairMint: 'not-an-address',
      },
      400
    );
    assert(/tidak valid/.test(badPairAddr.error), 'register with a malformed pair address is 400');

    // ---------- 12. Candles ----------
    console.log('candles:');
    const candles5m = await get(`/api/coins/${mint}/candles?timeframe=5m`);
    assert(candles5m.timeframe === '5m', 'candles endpoint echoes the timeframe');
    assert(
      candles5m.candles.length >= 1 && candles5m.candles.length <= 2,
      `5m candles: 1-2 buckets for 4 trades + launch (got ${candles5m.candles.length})`
    );
    const totalVol = candles5m.candles.reduce((s, c) => s + c.volume, 0);
    const totalCount = candles5m.candles.reduce((s, c) => s + c.count, 0);
    assert(
      approx(totalVol, 1.5 + 0.5 + solOut + sol3),
      'candle volume sums all trade SOL'
    );
    assert(totalCount === 5, 'candle counts sum to 5 points (launch + 4 trades)');
    assert(
      candles5m.candles.every((c) => c.high >= c.low && c.high >= c.open && c.high >= c.close &&
        c.low <= c.open && c.low <= c.close && c.open > 0),
      'every candle has valid OHLC (high >= open/close >= low, no zero candles)'
    );
    if (Number.isFinite(solUsd)) {
      assert(
        candles5m.candles.every((c) => approx(c.openUsd, c.open * solUsd) && approx(c.volumeUsd, c.volume * solUsd)),
        'candles carry USD fields = pair-asset fields x SOL/USD'
      );
    }
    const candles1m = await get(`/api/coins/${mint}/candles?timeframe=1m`);
    assert(candles1m.timeframe === '1m', '1m timeframe is honored');
    assert(
      candles1m.candles.length >= 1 && candles1m.candles.length <= 2,
      `1m candles: 1-2 buckets (got ${candles1m.candles.length})`
    );
    const candlesDefault = await get(`/api/coins/${mint}/candles`);
    assert(candlesDefault.timeframe === '5m', 'candles default to the 5m timeframe');
    const candlesBadTf = await get(`/api/coins/${mint}/candles?timeframe=2m`);
    assert(candlesBadTf.timeframe === '5m', 'an unknown timeframe falls back to 5m');
    const candlesUnknown = await fetch(`${BASE}/api/coins/${Keypair.generate().publicKey.toBase58()}/candles`);
    assert(candlesUnknown.status === 404, 'candles on an unknown coin are 404');
    const candlesEmpty = await get(`/api/coins/${mintPair}/candles?timeframe=1m`);
    assert(
      candlesEmpty.candles.length === 1 && candlesEmpty.candles[0].volume === 0,
      'a coin with no trades has only the launch candle (zero volume, no zero-price candle)'
    );

    // ---------- 13. Burns ----------
    console.log('burns:');
    const burnsEmpty = await get(`/api/coins/${mint}/burns`);
    assert(
      burnsEmpty.burns.length === 0 && burnsEmpty.totalBurned === 0 &&
        burnsEmpty.circulatingSupply === 1000000000,
      'burn history starts empty with 1B circulating'
    );
    assert(
      detail.burnStats && detail.burnStats.totalBurned === 0 &&
        detail.burnStats.circulatingSupply === 1000000000,
      'coin detail carries burnStats (0 burned, 1B circulating)'
    );
    assert(
      detail.stats.totalBurned === 0 && detail.stats.circulatingSupply === 1000000000,
      'coin stats carry totalBurned + circulatingSupply'
    );
    const burnZero = await post(
      `/api/coins/${mint}/burn`,
      { wallet: WALLET_A, amount: 0, txSignature: 'k'.repeat(88) },
      400
    );
    assert(/lebih dari 0/.test(burnZero.error), 'burn of 0 is 400');
    const burnTooBig = await post(
      `/api/coins/${mint}/burn`,
      { wallet: WALLET_A, amount: finalTok, txSignature: 'k'.repeat(88) },
      400
    );
    assert(/melebihi|kurang dari/.test(burnTooBig.error), `burn >= token reserve is 400: ${burnTooBig.error}`);
    const burnBadWallet = await post(
      `/api/coins/${mint}/burn`,
      { wallet: 'not-an-address', amount: 100, txSignature: 'k'.repeat(88) },
      400
    );
    assert(/tidak valid/.test(burnBadWallet.error), 'burn with an invalid wallet is 400');
    const burnUnknown = await post(
      `/api/coins/${Keypair.generate().publicKey.toBase58()}/burn`,
      { wallet: WALLET_A, amount: 100, txSignature: 'k'.repeat(88) },
      404
    );
    assert(/tidak ditemukan/.test(burnUnknown.error), 'burn on an unknown coin is 404');
    // Fake burn signature: the server verifies the burn on-chain (~10s).
    const fakeBurn = await post(
      `/api/coins/${mint}/burn`,
      { wallet: WALLET_A, amount: 100, txSignature: 'k'.repeat(88) },
      422
    );
    assert(/Verifikasi burn gagal/.test(fakeBurn.error), `fake burn rejected: ${fakeBurn.error}`);

    // ---------- 14. Transfers ----------
    console.log('transfers:');
    const transfersEmpty = await get(`/api/transfers?wallet=${WALLET_A}`);
    assert(
      Array.isArray(transfersEmpty.transfers) && transfersEmpty.transfers.length === 0,
      'transfer history starts empty'
    );
    assert(
      Array.isArray(pf.transfers) && pf.transfers.length === 0,
      'portfolio carries the (empty) transfer history'
    );
    const transferBadTo = await post(
      '/api/transfers',
      { mintAddress: mint, fromWallet: WALLET_A, toWallet: 'not-an-address', amount: 100, txSignature: 'm'.repeat(88) },
      400
    );
    assert(/tidak valid/.test(transferBadTo.error), 'transfer to an invalid address is 400');
    const transferSelf = await post(
      '/api/transfers',
      { mintAddress: mint, fromWallet: WALLET_A, toWallet: WALLET_A, amount: 100, txSignature: 'm'.repeat(88) },
      400
    );
    assert(/tidak boleh sama/.test(transferSelf.error), `self-transfer is 400: ${transferSelf.error}`);
    const transferZero = await post(
      '/api/transfers',
      { mintAddress: mint, fromWallet: WALLET_A, toWallet: WALLET_B, amount: 0, txSignature: 'm'.repeat(88) },
      400
    );
    assert(/lebih dari 0/.test(transferZero.error), 'transfer of 0 is 400');
    const transferUnknown = await post(
      '/api/transfers',
      { mintAddress: Keypair.generate().publicKey.toBase58(), fromWallet: WALLET_A, toWallet: WALLET_B, amount: 100, txSignature: 'm'.repeat(88) },
      404
    );
    assert(/tidak ditemukan/.test(transferUnknown.error), 'transfer of an unknown coin is 404');
    // Fake transfer signature: the server verifies the transfer on-chain.
    const fakeTransfer = await post(
      '/api/transfers',
      { mintAddress: mint, fromWallet: WALLET_A, toWallet: WALLET_B, amount: 100, txSignature: 'm'.repeat(88) },
      422
    );
    assert(
      /Verifikasi transfer/.test(fakeTransfer.error),
      `fake transfer rejected: ${fakeTransfer.error}`
    );

    // ---------- 15. One wallet, many coins ----------
    console.log('one wallet, many coins:');
    // (a) Schema: creator_wallet has NO unique constraint — the only
    // unique key on coins is the mint address (PRIMARY KEY).
    const coinsSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'coins'")
      .get().sql;
    assert(
      !/creator_wallet[^,]*UNIQUE/i.test(coinsSql),
      'coins.creator_wallet has no UNIQUE constraint in the schema'
    );
    const coinsIndexes = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'coins'")
      .all();
    assert(
      coinsIndexes.every((i) => i.sql === null || !/creator_wallet/i.test(i.sql)),
      'no index on coins.creator_wallet (only the PK autoindex)'
    );
    // (b) WALLET_A already owns two coins (TCAT + UCAT, seeded above):
    // a register attempt for a THIRD coin from the same wallet must not
    // be rejected on per-wallet grounds — it reaches the on-chain mint
    // verification (422 for the fake mint), not a 400/409 limit error.
    const thirdCoinMint = Keypair.generate().publicKey.toBase58();
    const thirdCoin = await post(
      '/api/coins/register',
      {
        mintAddress: thirdCoinMint,
        name: 'Third Cat',
        ticker: 'TCAT3',
        creatorWallet: WALLET_A,
        txSignature: 'y'.repeat(88),
      },
      422
    );
    assert(
      /Verifikasi mint gagal/.test(thirdCoin.error),
      `a third coin from the same wallet is not blocked by any per-wallet limit (reaches mint verification): ${thirdCoin.error}`
    );
    // (c) Both of WALLET_A's coins appear in the feed.
    const allFeed = await get('/api/coins');
    const aCoinsInFeed = allFeed.coins.filter((c) => c.creatorWallet === WALLET_A);
    assert(
      aCoinsInFeed.length === 2 &&
        aCoinsInFeed.some((c) => c.mintAddress === mint) &&
        aCoinsInFeed.some((c) => c.mintAddress === mintUnfunded),
      'feed shows both coins from the same creator wallet'
    );
    // (d) Both appear on the creator profile, each with its own stats
    // (TCAT traded, UCAT never traded — different txCount/volume).
    const profileA = await get(`/api/creators/${WALLET_A}`);
    assert(profileA.coins.length === 2, 'creator profile lists all 2 coins from the wallet');
    const pTcat = profileA.coins.find((c) => c.mintAddress === mint);
    const pUcat = profileA.coins.find((c) => c.mintAddress === mintUnfunded);
    assert(pTcat && pUcat, 'profile contains both the funded and the unfunded coin');
    assert(
      pTcat.txCount === 4 && pUcat.txCount === 0,
      `each profile coin carries its own stats (TCAT txCount=${pTcat.txCount}, UCAT txCount=${pUcat.txCount})`
    );
    assert(
      pTcat.volumeSol > 0 && pUcat.volumeSol === 0,
      'each profile coin carries its own volume'
    );
    assert(
      approx(pTcat.feesUnclaimedSol, totalFees) && pUcat.feesUnclaimedSol === 0,
      'each profile coin carries its own unclaimed creator fees'
    );

    // ---------- 16. Editable profiles ----------
    console.log('editable profiles:');
    const owner = makeTestWallet();
    const other = makeTestWallet();
    // A 1x1 transparent PNG (valid upload fixture).
    const tinyPng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const profileBody = (wallet, fields, signer) => {
      const message = profileMessage({
        wallet,
        username: fields.username === undefined ? '' : fields.username || '',
        border: fields.border === undefined ? 'none' : fields.border,
        avatarHash: fields.avatar ? sha256Hex(fields.avatar.dataBase64) : '',
        coverHash: fields.cover ? sha256Hex(fields.cover.dataBase64) : '',
      });
      return { ...fields, message, signature: signer.sign(message) };
    };

    const noProfile = await get(`/api/profiles/${owner.address}`);
    assert(noProfile.profile === null, 'a wallet with no profile returns profile=null');

    // No signature, no edit (401).
    const unsigned = await post(
      `/api/profiles/${owner.address}`,
      { username: 'smokecat', border: 'gold' },
      401
    );
    assert(/tanda tangan/i.test(unsigned.error), `unsigned edit is 401: ${unsigned.error}`);

    // Username validation (field rules are checked before the signature,
    // so these need no valid signature).
    const nameTooShort = await post(
      `/api/profiles/${owner.address}`,
      { username: 'ab', border: 'gold' },
      400
    );
    assert(/3–20/.test(nameTooShort.error), 'username under 3 chars is 400');
    const nameTooLong = await post(
      `/api/profiles/${owner.address}`,
      { username: 'a'.repeat(21), border: 'gold' },
      400
    );
    assert(/3–20/.test(nameTooLong.error), 'username over 20 chars is 400');
    const nameBadChars = await post(
      `/api/profiles/${owner.address}`,
      { username: 'bad name!', border: 'gold' },
      400
    );
    assert(/3–20/.test(nameBadChars.error), 'username with spaces/punctuation is 400');
    const nameBadBorder = await post(
      `/api/profiles/${owner.address}`,
      { username: 'smokecat', border: 'neon' },
      400
    );
    assert(/border/i.test(nameBadBorder.error), 'unknown border preset is 400');
    const nameBadImage = await post(
      `/api/profiles/${owner.address}`,
      {
        username: 'smokecat',
        border: 'gold',
        avatar: { dataBase64: Buffer.from('not an image').toString('base64'), mimeType: 'text/plain' },
      },
      400
    );
    assert(/PNG\/JPEG/.test(nameBadImage.error), 'non-image avatar upload is 400');

    // A signature from another wallet cannot edit this profile (the
    // wallet is part of the signed message).
    const wrongWallet = await post(
      `/api/profiles/${owner.address}`,
      profileBody(owner.address, { username: 'smokecat', border: 'gold' }, other),
      401
    );
    assert(/tidak valid/.test(wrongWallet.error), `non-owner edit is 401: ${wrongWallet.error}`);
    // A signature over a different message than the submitted fields.
    const wrongMessage = profileMessage({
      wallet: owner.address,
      username: 'different',
      border: 'gold',
      avatarHash: '',
      coverHash: '',
    });
    const wrongMsgRes = await post(
      `/api/profiles/${owner.address}`,
      {
        username: 'smokecat',
        border: 'gold',
        message: wrongMessage,
        signature: owner.sign(wrongMessage),
      },
      401
    );
    assert(/tidak sesuai/.test(wrongMsgRes.error), `signature over a different message is 401: ${wrongMsgRes.error}`);

    // Successful edit (username + border).
    const saved = await post(
      `/api/profiles/${owner.address}`,
      profileBody(owner.address, { username: 'smokecat', border: 'gold' }, owner)
    );
    assert(saved.profile.username === 'smokecat', 'saved profile returns the username');
    assert(saved.profile.border === 'gold', 'saved profile returns the border');
    assert(saved.profile.avatarUrl === null, 'no avatar yet');
    const gotProfile = await get(`/api/profiles/${owner.address}`);
    assert(
      gotProfile.profile.username === 'smokecat' && gotProfile.profile.border === 'gold',
      'GET returns the saved profile'
    );

    // Username uniqueness is case-insensitive.
    const taken = await post(
      `/api/profiles/${other.address}`,
      profileBody(other.address, { username: 'SmokeCat', border: 'blue' }, other),
      409
    );
    assert(/sudah dipakai/.test(taken.error), `case-insensitive duplicate username is 409: ${taken.error}`);
    // But the owner can re-save their own username (e.g. change border).
    const resaved = await post(
      `/api/profiles/${owner.address}`,
      profileBody(owner.address, { username: 'smokecat', border: 'blue' }, owner)
    );
    assert(
      resaved.profile.username === 'smokecat' && resaved.profile.border === 'blue',
      'owner can re-save their own username with a new border'
    );

    // Avatar upload (1x1 PNG) + clearing the username.
    const withAvatar = await post(
      `/api/profiles/${owner.address}`,
      profileBody(
        owner.address,
        {
          username: null,
          border: 'blue',
          avatar: { dataBase64: tinyPng, mimeType: 'image/png' },
        },
        owner
      )
    );
    assert(
      withAvatar.profile.username === null,
      'username null clears the username'
    );
    assert(
      typeof withAvatar.profile.avatarUrl === 'string' &&
        withAvatar.profile.avatarUrl.startsWith('/uploads/') &&
        withAvatar.profile.avatarUrl.endsWith('.png'),
      `avatar upload returns an uploads URL (${withAvatar.profile.avatarUrl})`
    );
    const avatarPath = path.join(__dirname, '..', 'data', 'uploads', `${owner.address}-avatar.png`);
    assert(
      fs.existsSync(avatarPath),
      'avatar file exists under data/uploads'
    );

    // Profiles surface on the read paths: seed profiles for the two
    // seeded wallets directly in the DB (their private keys are unknown,
    // so the signed write path above covers writes).
    db.prepare(
      `INSERT INTO profiles (wallet, username, avatar_url, border, cover_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(WALLET_A, 'testcat', '/uploads/test-avatar.png', 'purple', '/uploads/test-cover.png', now);
    db.prepare(
      `INSERT INTO profiles (wallet, username, avatar_url, border, cover_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(WALLET_B, 'traderbee', null, 'blue', null, now);
    const creatorWithProfile = await get(`/api/creators/${WALLET_A}`);
    assert(
      creatorWithProfile.profile.username === 'testcat' &&
        creatorWithProfile.profile.border === 'purple' &&
        creatorWithProfile.profile.coverUrl === '/uploads/test-cover.png',
      'creator endpoint carries the editable profile (username/border/cover)'
    );
    const feedWithProfiles = await get('/api/coins');
    const feedTcat = feedWithProfiles.coins.find((c) => c.mintAddress === mint);
    assert(
      feedTcat.creatorProfile && feedTcat.creatorProfile.username === 'testcat',
      'feed coin card carries creatorProfile with the username'
    );
    const detailWithProfiles = await get(`/api/coins/${mint}`);
    assert(
      detailWithProfiles.callouts.length === 1 &&
        detailWithProfiles.callouts[0].authorProfile &&
        detailWithProfiles.callouts[0].authorProfile.username === 'traderbee',
      'coin detail callout carries authorProfile with the username'
    );
    // The follower follows WALLET_B (from the callouts section).
    const followListsWithProfiles = await get(`/api/follows/${follower.address}`);
    assert(
      followListsWithProfiles.profiles &&
        followListsWithProfiles.profiles[WALLET_B] &&
        followListsWithProfiles.profiles[WALLET_B].username === 'traderbee',
      'follow lists carry the profiles map with usernames'
    );
    // Cleanup for this section (the outer finally handles coins/trades).
    db.prepare('DELETE FROM profiles WHERE wallet IN (?, ?, ?, ?)').run(
      owner.address, other.address, WALLET_A, WALLET_B
    );
    try {
      fs.unlinkSync(avatarPath);
    } catch {
      // already gone — fine
    }

    // ---------- 17. Dev burn ----------
    console.log('dev burn:');
    // Preview math against hand-computed values.
    const burnAmount = 1000000;
    const bp = await get(`/api/coins/${mintDev}/burn-preview?amount=${burnAmount}`);
    const priceNow = devSol / devTok;
    const priceAfter = devSol / (devTok - burnAmount);
    assert(approx(bp.current.price, priceNow), 'burn-preview current price = solReserve / tokenReserve');
    assert(approx(bp.projected.price, priceAfter), 'burn-preview projected price = solReserve / (tokenReserve - amount)');
    assert(bp.current.circulatingSupply === 1000000000, 'burn-preview current supply is 1B (nothing burned yet)');
    assert(
      bp.projected.circulatingSupply === 1000000000 - burnAmount,
      'burn-preview projected supply drops by the burn'
    );
    assert(
      approx(bp.current.marketCapSol, priceNow * 1000000000),
      'burn-preview current market cap = price x supply'
    );
    assert(
      approx(bp.projected.marketCapSol, priceAfter * (1000000000 - burnAmount)),
      'burn-preview projected market cap = new price x new supply'
    );
    assert(
      approx(bp.pctSupplyBurned, (burnAmount / 1000000000) * 100),
      'burn-preview % of supply burned'
    );
    assert(
      approx(bp.priceIncreasePct, ((priceAfter - priceNow) / priceNow) * 100),
      'burn-preview price increase %'
    );
    assert(bp.maxBurn === devTok, 'burn-preview maxBurn is the curve reserve');
    assert(bp.pairAsset.symbol === 'SOL', 'burn-preview pair asset is SOL');
    // USD fields: the test server runs with SOL_USD_PRICE=100.
    if (Number.isFinite(bp.assetUsd)) {
      assert(approx(bp.current.priceUsd, priceNow * bp.assetUsd), 'burn-preview current priceUsd');
      assert(
        approx(bp.projected.marketCapUsd, priceAfter * (1000000000 - burnAmount) * bp.assetUsd),
        'burn-preview projected marketCapUsd'
      );
    }
    // Preview validation.
    const bpZeroRes = await fetch(`${BASE}/api/coins/${mintDev}/burn-preview?amount=0`);
    assert(bpZeroRes.status === 400, 'burn-preview amount 0 is 400');
    const bpBigRes = await fetch(`${BASE}/api/coins/${mintDev}/burn-preview?amount=${devTok}`);
    assert(bpBigRes.status === 400, 'burn-preview amount >= reserve is 400');
    const bpUnknownRes = await fetch(
      `${BASE}/api/coins/${Keypair.generate().publicKey.toBase58()}/burn-preview?amount=100`
    );
    assert(bpUnknownRes.status === 404, 'burn-preview on an unknown coin is 404');

    // Creator-only: anyone else gets 403 (checked before the signature).
    const dbForbidden = await post(
      `/api/coins/${mintDev}/dev-burn`,
      { wallet: WALLET_A, amount: 100, source: 'pool' },
      403
    );
    assert(/Hanya kreator/.test(dbForbidden.error), `dev burn by a non-creator is 403: ${dbForbidden.error}`);
    // Validation.
    const dbBadSource = await post(
      `/api/coins/${mintDev}/dev-burn`,
      { wallet: devWallet.address, amount: 100, source: 'mystery' },
      400
    );
    assert(/source/.test(dbBadSource.error), 'dev burn with a bad source is 400');
    const dbZero = await post(
      `/api/coins/${mintDev}/dev-burn`,
      { wallet: devWallet.address, amount: 0, source: 'pool' },
      400
    );
    assert(/lebih dari 0/.test(dbZero.error), 'dev burn of 0 is 400');
    const dbTooBig = await post(
      `/api/coins/${mintDev}/dev-burn`,
      { wallet: devWallet.address, amount: devTok, source: 'holdings', txSignature: 'n'.repeat(88) },
      400
    );
    assert(/melebihi/.test(dbTooBig.error), `dev burn >= reserve is 400: ${dbTooBig.error}`);
    const dbUnknown = await post(
      `/api/coins/${Keypair.generate().publicKey.toBase58()}/dev-burn`,
      { wallet: devWallet.address, amount: 100, source: 'pool' },
      404
    );
    assert(/tidak ditemukan/.test(dbUnknown.error), 'dev burn on an unknown coin is 404');

    // Pool burns need the creator's signature over the canonical message.
    const poolMsg = devBurnMessage({
      wallet: devWallet.address,
      mint: mintDev,
      amount: '1000000',
      source: 'pool',
    });
    const dbUnsigned = await post(
      `/api/coins/${mintDev}/dev-burn`,
      { wallet: devWallet.address, amount: 1000000, source: 'pool' },
      401
    );
    assert(/tanda tangan|Pesan/.test(dbUnsigned.error), `unsigned pool burn is 401: ${dbUnsigned.error}`);
    const wrongPoolMsg = devBurnMessage({
      wallet: devWallet.address,
      mint: mintDev,
      amount: '2000000',
      source: 'pool',
    });
    const dbWrongMsg = await post(
      `/api/coins/${mintDev}/dev-burn`,
      {
        wallet: devWallet.address,
        amount: 1000000,
        source: 'pool',
        message: wrongPoolMsg,
        signature: devWallet.sign(wrongPoolMsg),
      },
      401
    );
    assert(/tidak sesuai/.test(dbWrongMsg.error), `pool burn signed for a different amount is 401: ${dbWrongMsg.error}`);
    const dbWrongSigner = await post(
      `/api/coins/${mintDev}/dev-burn`,
      {
        wallet: devWallet.address,
        amount: 1000000,
        source: 'pool',
        message: poolMsg,
        signature: otherWallet.sign(poolMsg),
      },
      401
    );
    assert(/tidak valid/.test(dbWrongSigner.error), `pool burn signed by another wallet is 401: ${dbWrongSigner.error}`);
    // Valid signature, but the pool holds 0 of this mint on-chain.
    const dbPoolShort = await post(
      `/api/coins/${mintDev}/dev-burn`,
      {
        wallet: devWallet.address,
        amount: 1000000,
        source: 'pool',
        message: poolMsg,
        signature: devWallet.sign(poolMsg),
      },
      400
    );
    assert(/Pool hanya memegang/.test(dbPoolShort.error), `pool burn with an empty pool is 400: ${dbPoolShort.error}`);
    // Holdings burn with a fake signature: rejected on-chain (~10s).
    const dbFake = await post(
      `/api/coins/${mintDev}/dev-burn`,
      { wallet: devWallet.address, amount: 100, source: 'holdings', txSignature: 'p'.repeat(88) },
      422
    );
    assert(/Verifikasi burn gagal/.test(dbFake.error), `fake holdings dev burn rejected: ${dbFake.error}`);

    // Burn sources serialize in the history (seeded directly — the
    // success paths need real on-chain burns).
    const insertBurn = db.prepare(
      `INSERT INTO burns (mint_address, wallet, amount, source, price_after, tx_signature, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    insertBurn.run(mintNoFees, WALLET_A, 1000, 'holder', 0.0000001, 'h'.repeat(88), now - 3000);
    insertBurn.run(mintNoFees, devWallet.address, 2000, 'dev', 0.0000002, 'i'.repeat(88), now - 2000);
    insertBurn.run(mintNoFees, pool.address, 3000, 'pool', 0.0000003, 'j'.repeat(88), now - 1000);
    const nfBurns = await get(`/api/coins/${mintNoFees}/burns`);
    assert(nfBurns.burns.length === 3, 'seeded burns appear in the history');
    assert(
      nfBurns.burns.map((b) => b.source).join(',') === 'pool,dev,holder',
      'burn history carries the source (pool/dev/holder, newest first)'
    );
    assert(
      nfBurns.totalBurned === 6000 && nfBurns.circulatingSupply === 1000000000 - 6000,
      'burn totals sum all sources'
    );

    // ---------- 18. Buyback ----------
    console.log('buyback:');
    // Preview math against the bonding module.
    const bbSpend = 0.01;
    const bbp = await get(`/api/coins/${mintDev}/buyback-preview?amount=${bbSpend}`);
    const bbTokens = bonding.quoteBuy({ sol_reserve: devSol, token_reserve: devTok }, bbSpend);
    const bbNewPrice = (devSol + bbSpend) / (devTok - bbTokens);
    assert(approx(bbp.tokenAmount, bbTokens), 'buyback-preview tokens out = curve quote');
    assert(approx(bbp.newPrice, bbNewPrice), 'buyback-preview new price after the buyback');
    assert(approx(bbp.unclaimedSol, devFee), 'buyback-preview unclaimed = seeded fees');
    assert(bbp.minBuy === 0.001, 'buyback-preview minBuy is 0.001 SOL');
    assert(bbp.pairAsset.symbol === 'SOL', 'buyback-preview pair asset is SOL');
    // 'all' previews the full unclaimed balance.
    const bbpAll = await get(`/api/coins/${mintDev}/buyback-preview?amount=all`);
    assert(
      bbpAll.isAll === true && approx(bbpAll.amount, devFee),
      "buyback-preview 'all' spends the full unclaimed balance"
    );
    assert(
      approx(bbpAll.tokenAmount, bonding.quoteBuy({ sol_reserve: devSol, token_reserve: devTok }, devFee)),
      "buyback-preview 'all' quotes the full balance"
    );
    // Preview validation.
    const bbpZeroRes = await fetch(`${BASE}/api/coins/${mintDev}/buyback-preview?amount=0`);
    assert(bbpZeroRes.status === 400, 'buyback-preview amount 0 is 400');
    const bbpBigRes = await fetch(`${BASE}/api/coins/${mintDev}/buyback-preview?amount=${devFee + 1}`);
    assert(bbpBigRes.status === 400, 'buyback-preview above unclaimed is 400');
    const bbpUnknownRes = await fetch(
      `${BASE}/api/coins/${Keypair.generate().publicKey.toBase58()}/buyback-preview?amount=0.01`
    );
    assert(bbpUnknownRes.status === 404, 'buyback-preview on an unknown coin is 404');

    // Creator-only.
    const bbForbidden = await post(
      `/api/coins/${mintDev}/buyback`,
      { wallet: WALLET_A, amount: 0.01 },
      403
    );
    assert(/Hanya kreator/.test(bbForbidden.error), `buyback by a non-creator is 403: ${bbForbidden.error}`);
    // Signature requirement.
    const bbMsg = buybackMessage({ wallet: devWallet.address, mint: mintDev, amount: '0.01' });
    const bbUnsigned = await post(
      `/api/coins/${mintDev}/buyback`,
      { wallet: devWallet.address, amount: 0.01 },
      401
    );
    assert(/tanda tangan|Pesan/.test(bbUnsigned.error), `unsigned buyback is 401: ${bbUnsigned.error}`);
    const bbWrongMsg = buybackMessage({ wallet: devWallet.address, mint: mintDev, amount: '0.02' });
    const bbWrongMsgRes = await post(
      `/api/coins/${mintDev}/buyback`,
      { wallet: devWallet.address, amount: 0.01, message: bbWrongMsg, signature: devWallet.sign(bbWrongMsg) },
      401
    );
    assert(/tidak sesuai/.test(bbWrongMsgRes.error), `buyback signed for a different amount is 401: ${bbWrongMsgRes.error}`);
    const bbWrongSigner = await post(
      `/api/coins/${mintDev}/buyback`,
      { wallet: devWallet.address, amount: 0.01, message: bbMsg, signature: otherWallet.sign(bbMsg) },
      401
    );
    assert(/tidak valid/.test(bbWrongSigner.error), `buyback signed by another wallet is 401: ${bbWrongSigner.error}`);
    // No fees at all (coin F).
    const bbAllMsg = buybackMessage({ wallet: devWallet.address, mint: mintNoFees, amount: 'all' });
    const bbNoFees = await post(
      `/api/coins/${mintNoFees}/buyback`,
      { wallet: devWallet.address, amount: 'all', message: bbAllMsg, signature: devWallet.sign(bbAllMsg) },
      400
    );
    assert(/Tidak ada fee/.test(bbNoFees.error), `buyback with zero unclaimed fees is 400: ${bbNoFees.error}`);
    // Below the minimum buy.
    const bbMinMsg = buybackMessage({ wallet: devWallet.address, mint: mintDev, amount: '0.0005' });
    const bbBelowMin = await post(
      `/api/coins/${mintDev}/buyback`,
      { wallet: devWallet.address, amount: 0.0005, message: bbMinMsg, signature: devWallet.sign(bbMinMsg) },
      400
    );
    assert(/minimal/.test(bbBelowMin.error), `buyback below the minimum is 400: ${bbBelowMin.error}`);
    // Above the unclaimed balance.
    const bbBigMsg = buybackMessage({ wallet: devWallet.address, mint: mintDev, amount: '0.05' });
    const bbTooBig = await post(
      `/api/coins/${mintDev}/buyback`,
      { wallet: devWallet.address, amount: 0.05, message: bbBigMsg, signature: devWallet.sign(bbBigMsg) },
      400
    );
    assert(/melebihi/.test(bbTooBig.error), `buyback above unclaimed is 400: ${bbTooBig.error}`);
    // Valid buyback, but the pool holds 0 of this mint on-chain.
    const bbPoolShort = await post(
      `/api/coins/${mintDev}/buyback`,
      { wallet: devWallet.address, amount: 0.01, message: bbMsg, signature: devWallet.sign(bbMsg) },
      400
    );
    assert(/kehabisan token/.test(bbPoolShort.error), `buyback with an empty pool is 400: ${bbPoolShort.error}`);
    // The fee-claim kind serializes on the detail endpoint (seeded
    // directly — the success path needs a funded pool).
    db.prepare(
      `INSERT INTO fee_claims (mint_address, creator_wallet, amount_sol, asset_symbol, kind, tx_signature, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(mintDev, devWallet.address, 0.005, 'SOL', 'buyback', 'o'.repeat(88), now - 1000);
    const devDetail = await get(`/api/coins/${mintDev}`);
    const seededClaim = devDetail.feeClaims.find((c) => c.txSignature === 'o'.repeat(88));
    assert(seededClaim && seededClaim.kind === 'buyback', 'detail feeClaims carry the buyback kind');
    assert(
      approx(devDetail.creatorFees.unclaimedSol, devFee - 0.005),
      'a buyback claim reduces the unclaimed balance'
    );

    console.log('\nALL E2E CHECKS PASSED');
  } finally {
    const allMints = [mint, mintUnfunded, mintPair, mintOrphan, mintDev, mintNoFees];
    const placeholders = allMints.map(() => '?').join(', ');
    db.prepare(`DELETE FROM trades WHERE mint_address IN (${placeholders})`).run(...allMints);
    db.prepare(`DELETE FROM fee_claims WHERE mint_address IN (${placeholders})`).run(...allMints);
    db.prepare(`DELETE FROM callouts WHERE mint_address IN (${placeholders})`).run(...allMints);
    db.prepare(`DELETE FROM burns WHERE mint_address IN (${placeholders})`).run(...allMints);
    db.prepare(`DELETE FROM transfers WHERE mint_address IN (${placeholders})`).run(...allMints);
    db.prepare(`DELETE FROM coins WHERE mint_address IN (${placeholders})`).run(...allMints);
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
