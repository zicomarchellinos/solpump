'use strict';
// Bonding-curve math for solpump's real devnet trading.
// Constant-product curve (x * y = k), no fee. Nothing here touches the
// chain: minting happens client-side via Phantom, and trades are settled
// through the server pool wallet (see src/pool.js); the curve only prices
// how much of the other asset each leg delivers.
//
// Virtual reserves at launch: 30 SOL against 800,000,000 tokens (80% of the
// 1,000,000,000-token supply sits on the curve). The curve is "complete"
// when 85 SOL has been raised into the reserve.

const VIRTUAL_SOL = 30;
const VIRTUAL_TOKENS = 800_000_000;
const TOTAL_SUPPLY = 1_000_000_000;
const GRADUATION_SOL = 85;
const DECIMALS = 6;
const MINT_SUPPLY_RAW = 1_000_000_000_000_000n; // 1B tokens * 10^6
const FUNDING_TOKENS = 800_000_000; // tokens the creator moves to the pool
const FUNDING_TOKENS_RAW = 800_000_000_000_000n; // 800M tokens * 10^6

// Creator fee: 1% of every trade's SOL volume accrues to the coin's
// creator, claimable later from the pool wallet. Single constant so the
// rate can be changed in one place. On a buy the buyer pays the full SOL
// amount (the fee is part of what they pay); on a sell the fee is deducted
// from what the seller receives (seller gets solAmount - fee).
const CREATOR_FEE_BPS = 100; // basis points: 100 = 1%

function creatorFeeSol(solAmount) {
  return (solAmount * CREATOR_FEE_BPS) / 10000;
}

const INITIAL_PRICE = VIRTUAL_SOL / VIRTUAL_TOKENS; // SOL per token

function currentPrice(coin) {
  return coin.sol_reserve / coin.token_reserve;
}

function marketCapSol(coin) {
  return currentPrice(coin) * TOTAL_SUPPLY;
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

// Market stats derived from the trade history. `trades` must be in
// chronological order (oldest first).
function computeStats(coin, trades) {
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
  return {
    price,
    marketCapSol: marketCapSol(coin),
    changePct,
    high,
    low,
    volumeSol,
    totalFeesSol,
    txCount: trades.length,
    uniqueTraders: traders.size,
    progressPct: curveProgressPct(coin),
  };
}

// Chart points: one point per trade plus a launch point at the initial price.
// `trades` must be in chronological order (oldest first).
function chartPoints(coin, trades) {
  const points = [{ t: coin.created_at, price: INITIAL_PRICE, side: null }];
  for (const t of trades) {
    points.push({ t: t.created_at, price: t.price, side: t.side });
  }
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
function computePnl(trades, price) {
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
  return {
    holdings,
    avgBuyPrice,
    costBasisSol: cost,
    currentValueSol: currentValue,
    realizedPnlSol: realized,
    unrealizedPnlSol: unrealized,
    totalPnlSol: totalPnl,
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
  creatorFeeSol,
  INITIAL_PRICE,
  currentPrice,
  marketCapSol,
  curveProgressPct,
  quoteBuy,
  quoteSell,
  quoteBuySolForTokens,
  quoteSellTokensForSol,
  computeStats,
  chartPoints,
  computePnl,
};
