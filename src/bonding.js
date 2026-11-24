'use strict';
// Bonding-curve math for solpump's real devnet trading.
// Constant-product curve (x * y = k), no fee. Nothing here touches the
// chain: minting happens client-side via Phantom, and trades are settled
// through the server pool wallet (see src/pool.js); the curve only prices
// how much of the other asset each leg delivers.
//
// Virtual reserves at launch: 55 SOL against 800,000,000 tokens (80% of the
// 1,000,000,000-token supply sits on the curve). The curve is "complete"
// when 85 SOL has been raised into the reserve.
//
// The 55 SOL reserve is tuned so a fresh coin starts near a $5,000 USD
// market cap, pump.fun style: starting market cap = 55 SOL x (1B / 800M) =
// 68.75 SOL, which at the SOL/USD price of ~$72.85 (2026-11-17, Jupiter /
// CoinGecko) is ~$5,008. This is approximate by nature — SOL/USD moves, so
// the starting cap drifts with the price. If SOL moves a lot, re-tune
// VIRTUAL_SOL = 5000 / (1.25 x SOL/USD) and round to a clean number.

const VIRTUAL_SOL = 55;
const VIRTUAL_TOKENS = 800_000_000;
const TOTAL_SUPPLY = 1_000_000_000;
const GRADUATION_SOL = 85;
const DECIMALS = 6;
const MINT_SUPPLY_RAW = 1_000_000_000_000_000n; // 1B tokens * 10^6
const FUNDING_TOKENS = 800_000_000; // tokens the creator moves to the pool
const FUNDING_TOKENS_RAW = 800_000_000_000_000n; // 800M tokens * 10^6

// Creator fee: a per-coin tax on every trade's pair-asset volume,
// set by the creator at creation (0–10%, default 1% = 100 bps) and
// never changeable afterwards (changing tax after launch would rug
// traders). The fee accrues to the coin's creator, claimable later from
// the pool wallet. On a buy the buyer pays the full SOL amount (the fee
// is part of what they pay); on a sell the fee is deducted from what the
// seller receives (seller gets solAmount - fee). CREATOR_FEE_BPS is the
// DEFAULT rate for coins created before per-coin tax existed.
const CREATOR_FEE_BPS = 100; // basis points: 100 = 1%
const MAX_FEE_BPS = 1000; // 10% — the maximum tax a creator may set

function creatorFeeSol(solAmount, feeBps = CREATOR_FEE_BPS) {
  return (solAmount * feeBps) / 10000;
}

const INITIAL_PRICE = VIRTUAL_SOL / VIRTUAL_TOKENS; // SOL per token

function currentPrice(coin) {
  return coin.sol_reserve / coin.token_reserve;
}

// Circulating supply: the 1B total supply minus everything holders have
// burned (burns are permanent — burned tokens leave the supply forever).
// Market cap is priced on the CIRCULATING supply, not the original 1B:
// a coin with 100M burned has 900M tokens left, so its market cap is
// price x 900M. With zero burns this is exactly the old 1B formula.
function circulatingSupply(totalBurned = 0) {
  return Math.max(0, TOTAL_SUPPLY - (Number(totalBurned) || 0));
}

function marketCapSol(coin, totalBurned = 0) {
  return currentPrice(coin) * circulatingSupply(totalBurned);
}

// Market cap in USD: price (pair asset) x USD price of one unit of the
// pair asset x circulating supply. Returns null when no price is available
// (the caller then falls back to the pair asset).
function marketCapUsd(coin, assetUsd, totalBurned = 0) {
  if (!Number.isFinite(assetUsd) || assetUsd <= 0) return null;
  return marketCapSol(coin, totalBurned) * assetUsd;
}

// Burn price effect: burning tokens removes them from the curve's token
// reserve, so price = sol_reserve / token_reserve goes UP — that is the
// whole point of the burn mechanism. Returns null when the burn would
// empty the reserve (the reserve must stay positive).
function priceAfterBurn(coin, burnAmount) {
  const remaining = coin.token_reserve - burnAmount;
  if (!(burnAmount > 0) || remaining <= 0) return null;
  return coin.sol_reserve / remaining;
}

function burnPriceEffect(coin, burnAmount) {
  const newPrice = priceAfterBurn(coin, burnAmount);
  if (newPrice === null) return null;
  const price = currentPrice(coin);
  return { newPrice, pctChange: ((newPrice - price) / price) * 100 };
}

// Mint/add supply price effect: adding tokens to the curve's token reserve
// increases the reserve, so price = sol_reserve / token_reserve goes DOWN.
// This is the opposite of burning. Returns null when amount is invalid.
function priceAfterAddSupply(coin, addAmount) {
  if (!(addAmount > 0)) return null;
  const newReserve = coin.token_reserve + addAmount;
  return coin.sol_reserve / newReserve;
}

function addSupplyPriceEffect(coin, addAmount) {
  const newPrice = priceAfterAddSupply(coin, addAmount);
  if (newPrice === null) return null;
  const price = currentPrice(coin);
  return { newPrice, pctChange: ((newPrice - price) / price) * 100 };
}

// Candlestick aggregation (OHLC per time bucket) from chart points
// (launch point + trades + burns, chronological). `points` carry t (ms),
// price, and amount (pair-asset volume of that event; 0 for the launch
// point and for burns, which move the price without trading volume).
// Empty buckets produce NO candle — never a zero candle — so sparse trade
// data renders as gaps, not flat lines at zero.
function buildCandles(points, timeframeMs) {
  const buckets = new Map(); // bucketStartMs -> candle
  for (const p of points) {
    const start = Math.floor(p.t / timeframeMs) * timeframeMs;
    let c = buckets.get(start);
    if (!c) {
      c = { t: start, open: p.price, high: p.price, low: p.price, close: p.price, volume: 0, count: 0 };
      buckets.set(start, c);
    }
    if (p.price > c.high) c.high = p.price;
    if (p.price < c.low) c.low = p.price;
    c.close = p.price;
    c.volume += Number(p.amount) || 0;
    c.count += 1;
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

// Compact USD formatting, pump.fun style: $5K, $500K, $5M, $50M, $500M,
// $5B. One decimal when it adds information ($5.2K, $12.4M), none for
// round values ($5K). Values under $1K render as plain dollars ($999).
// Rounding that crosses a scale boundary bumps up ($999,999 -> $1M, not
// $1000K). Returns null for a non-finite or negative input.
function fmtMarketCapUsd(usd) {
  if (usd === null || usd === undefined) return null; // Number(null) is 0
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0) return null;
  const oneDecimal = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  const scales = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (let i = 0; i < scales.length; i++) {
    const [div, suffix] = scales[i];
    if (n < div) continue;
    let v = Math.round((n / div) * 10) / 10;
    if (v >= 1000 && i > 0) {
      const [upDiv, upSuffix] = scales[i - 1];
      v = Math.round((n / upDiv) * 10) / 10;
      return `$${oneDecimal(v)}${upSuffix}`;
    }
    return `$${oneDecimal(v)}${suffix}`;
  }
  return `$${oneDecimal(Math.round(n * 10) / 10)}`;
}

// Progress toward graduation: 0% at launch, 100% once 85 SOL is raised.
function curveProgressPct(coin) {
  const raised = coin.sol_reserve - VIRTUAL_SOL;
  return Math.max(0, Math.min(100, (raised / GRADUATION_SOL) * 100));
}

// Constant-product quotes (exact, no fee).
function quoteBuy(coin, solIn) {
  return (coin.token_reserve * solIn) / (coin.sol_reserve + solIn);
}

// Two-hop routed buy quote (SOL -> pair coin -> target coin). The buyer
// pays SOL; the pool routes it through the pair coin's curve (leg 1) and
// the resulting pair tokens through the target coin's curve (leg 2).
// Returns the pair tokens produced by leg 1 and the target tokens
// produced by leg 2. Fees do NOT reduce the routed amounts — exactly as
// on a direct buy, the buyer pays the full amount (fee included) and each
// leg's creator fee accrues from its leg volume. Pure math, no DB.
function quoteRoutedBuy(pairRow, targetRow, solIn) {
  const pairOut = quoteBuy(pairRow, solIn);
  const tokenOut = quoteBuy(targetRow, pairOut);
  return { pairOut, tokenOut };
}

function quoteSell(coin, tokenIn) {
  return (coin.sol_reserve * tokenIn) / (coin.token_reserve + tokenIn);
}

// Inverse quotes: how much SOL to buy an exact token amount, and how many
// tokens to sell to receive an exact SOL amount.
function quoteBuySolForTokens(coin, tokenOut) {
  if (tokenOut >= coin.token_reserve) return Infinity;
  return (coin.sol_reserve * tokenOut) / (coin.token_reserve - tokenOut);
}

function quoteSellTokensForSol(coin, solOut) {
  if (solOut >= coin.sol_reserve) return Infinity;
  return (coin.token_reserve * solOut) / (coin.sol_reserve - solOut);
}

// The pool's actual pair-asset holdings attributable to one registered
// coin. Derivation: the pool receives the full buy amount (the 1% creator
// fee is part of what the buyer pays) and pays out sells net of fee, so
//   poolAsset = (sol_reserve - VIRTUAL_SOL) + unclaimedFees - buyFees
// Buy fees sit inside BOTH the reserve and the unclaimed balance —
// subtracting them once removes the double count; sell fees only sit in
// the unclaimed balance. Claims, buybacks, burns and funding all keep
// this relation exact. Used by re-register curve reconstruction
// (src/routes.js) to attribute the pool's shared asset balance across
// coins after a database wipe.
function poolAttribution({ solReserve, unclaimedFees, buyFees }) {
  return (solReserve - VIRTUAL_SOL) + (unclaimedFees || 0) - (buyFees || 0);
}

// Market stats derived from the trade history. `trades` must be in
// chronological order (oldest first). Pass the USD price of one unit of
// the pair asset (SOL/USD for SOL pairs, the pair coin's USD token price
// for coin pairs — see src/pairs.js) to include the USD fields
// (priceUsd, marketCapUsd, highUsd, lowUsd); they stay null when no price
// is given. `totalBurned` feeds the circulating-supply market cap.
// NOTE: volumeSol / totalFeesSol are denominated in the PAIR ASSET
// (SOL for SOL pairs, pair tokens for coin pairs) — the field names are
// historical, the values follow the pair.
function computeStats(coin, trades, assetUsd = null, totalBurned = 0) {
  const price = currentPrice(coin);
  const changePct = ((price - INITIAL_PRICE) / INITIAL_PRICE) * 100;
  let high = INITIAL_PRICE;
  let low = INITIAL_PRICE;
  let volumeSol = 0;
  let totalFeesSol = 0;
  const traders = new Set();
  for (const t of trades) {
    if (t.price > high) high = t.price;
    if (t.price < low) low = t.price;
    volumeSol += t.sol_amount;
    totalFeesSol += t.fee_sol || 0;
    traders.add(t.wallet);
  }
  const toUsd = (sol) => (Number.isFinite(assetUsd) && assetUsd > 0 ? sol * assetUsd : null);
  return {
    price,
    priceUsd: toUsd(price),
    marketCapSol: marketCapSol(coin, totalBurned),
    marketCapUsd: marketCapUsd(coin, assetUsd, totalBurned),
    changePct,
    high,
    highUsd: toUsd(high),
    low,
    lowUsd: toUsd(low),
    volumeSol,
    totalFeesSol,
    txCount: trades.length,
    uniqueTraders: traders.size,
    progressPct: curveProgressPct(coin),
    totalBurned: Number(totalBurned) || 0,
    circulatingSupply: circulatingSupply(totalBurned),
  };
}

// Chart points: one point per trade plus a launch point at the initial price.
// `trades` must be in chronological order (oldest first). Pass the USD
// price of one unit of the pair asset to include priceUsd per point (for
// the tooltip); it stays null when no price is given. Burns are merged in
// as price points (side 'burn', zero volume — a burn moves the price
// without trading volume) so the chart reflects the post-burn price; each
// burn carries its recorded price_after. Points also carry `amount`
// (pair-asset volume of the event) for the candlestick aggregation.
function chartPoints(coin, trades, assetUsd = null, burns = []) {
  const toUsd = (sol) => (Number.isFinite(assetUsd) && assetUsd > 0 ? sol * assetUsd : null);
  const points = [
    { t: coin.created_at, price: INITIAL_PRICE, priceUsd: toUsd(INITIAL_PRICE), side: null, amount: 0 },
  ];
  for (const t of trades) {
    points.push({ t: t.created_at, price: t.price, priceUsd: toUsd(t.price), side: t.side, amount: t.sol_amount });
  }
  for (const b of burns) {
    points.push({ t: b.created_at, price: b.price_after, priceUsd: toUsd(b.price_after), side: 'burn', amount: 0 });
  }
  points.sort((a, b) => a.t - b.t || (a.side === null ? -1 : 1));
  return points;
}

// Profit/loss for one wallet on one coin, average-cost method.
// `trades` must be in chronological order (oldest first).
// Returns holdings, average buy price, cost basis, current value,
// realized + unrealized PnL, total PnL and ROI vs total bought.
// Fee handling: on a buy the trader paid the full sol_amount (the 1%
// creator fee is part of what they paid, so the cost basis is the full
// amount); on a sell the trader actually received sol_amount - fee_sol,
// so realized PnL and totalSellSol use the NET proceeds.
// Amounts are denominated in the PAIR ASSET (SOL for SOL pairs, pair
// tokens for coin pairs) — the field names are historical. Pass the USD
// price of one unit of the pair asset to also get the USD figures
// (avgBuyPriceUsd, costBasisUsd, currentValueUsd, realized/unrealized/
// total PnL in USD) — the pair-asset figures converted at the current
// rate. The USD fields are null when no price is given.
function computePnl(trades, price, assetUsd = null) {
  let holdings = 0;
  let cost = 0; // cost basis of the current holdings
  let realized = 0;
  let totalBuySol = 0;
  let totalSellSol = 0;
  let totalFeesPaidSol = 0;
  for (const t of trades) {
    const fee = t.fee_sol || 0;
    totalFeesPaidSol += fee;
    if (t.side === 'buy') {
      holdings += t.token_amount;
      cost += t.sol_amount;
      totalBuySol += t.sol_amount;
    } else {
      const netProceeds = t.sol_amount - fee;
      const avgCost = holdings > 0 ? cost / holdings : 0;
      realized += netProceeds - avgCost * t.token_amount;
      cost -= avgCost * t.token_amount;
      holdings -= t.token_amount;
      totalSellSol += netProceeds;
    }
  }
  // Guard against float dust on fully-sold positions.
  if (Math.abs(holdings) < 1e-9) {
    holdings = 0;
    cost = 0;
  }
  const avgBuyPrice = holdings > 0 ? cost / holdings : 0;
  const currentValue = holdings * price;
  const unrealized = currentValue - cost;
  const totalPnl = realized + unrealized;
  const roiPct = totalBuySol > 0 ? (totalPnl / totalBuySol) * 100 : 0;
  const toUsd = (sol) => (Number.isFinite(assetUsd) && assetUsd > 0 ? sol * assetUsd : null);
  return {
    holdings,
    avgBuyPrice,
    avgBuyPriceUsd: toUsd(avgBuyPrice),
    costBasisSol: cost,
    costBasisUsd: toUsd(cost),
    currentValueSol: currentValue,
    currentValueUsd: toUsd(currentValue),
    realizedPnlSol: realized,
    realizedPnlUsd: toUsd(realized),
    unrealizedPnlSol: unrealized,
    unrealizedPnlUsd: toUsd(unrealized),
    totalPnlSol: totalPnl,
    totalPnlUsd: toUsd(totalPnl),
    roiPct,
    isProfit: totalPnl >= 0,
    totalBuySol,
    totalSellSol,
    totalFeesPaidSol,
    totalTrades: trades.length,
  };
}

module.exports = {
  VIRTUAL_SOL,
  VIRTUAL_TOKENS,
  TOTAL_SUPPLY,
  GRADUATION_SOL,
  DECIMALS,
  MINT_SUPPLY_RAW,
  FUNDING_TOKENS,
  FUNDING_TOKENS_RAW,
  CREATOR_FEE_BPS,
  MAX_FEE_BPS,
  creatorFeeSol,
  poolAttribution,
  INITIAL_PRICE,
  currentPrice,
  circulatingSupply,
  marketCapSol,
  marketCapUsd,
  fmtMarketCapUsd,
  priceAfterBurn,
  burnPriceEffect,
  priceAfterAddSupply,
  addSupplyPriceEffect,
  buildCandles,
  curveProgressPct,
  quoteBuy,
  quoteRoutedBuy,
  quoteSell,
  quoteBuySolForTokens,
  quoteSellTokensForSol,
  computeStats,
  chartPoints,
  computePnl,
};
