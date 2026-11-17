'use strict';
// Creator-funded rewards for trader callouts.
//
// A coin's creator deposits SOL into a per-coin reward pool (real devnet
// SOL sent to the pool wallet, verified on-chain, tracked per coin in the
// DB). A callout author can then claim a reward when their callout's LIVE
// PnL (entry price vs the current price) crosses a tier:
//
//   +10%  ->  0.01  SOL
//   +25%  ->  0.025 SOL
//   +50%  ->  0.05  SOL
//
// Each tier is claimable ONCE per callout (a UNIQUE(callout_id, tier)
// constraint enforces it). Claims are paid by a real SOL transfer from
// the pool wallet, so the pool's actual SOL covers them: the reward pool
// is a separate per-coin SOL ledger, independent of the coin's pair
// (SOL-paired or coin-paired coins both pay rewards in SOL).
//
// Accounting: the reward pool balance is SUM(funds) - SUM(claims) for the
// coin. The pool wallet holds the reward SOL alongside trading SOL (one
// wallet, one balance); the ledgers are DB-side. Re-register curve
// reconstruction subtracts other coins' reward pools from the pool's SOL
// balance so reward SOL is never double-counted as trading reserves
// (see src/routes.js reconstructAssetReserve).

const REWARD_TIERS = [
  { pct: 10, amountSol: 0.01 },
  { pct: 25, amountSol: 0.025 },
  { pct: 50, amountSol: 0.05 },
];

const MIN_REWARD_FUND_SOL = 0.01; // one tier-1 reward; smaller deposits are dust
const MAX_REWARD_FUND_SOL = 1000; // sanity cap, same as MAX_TRADE_SOL

function tierByPct(pct) {
  return REWARD_TIERS.find((t) => t.pct === pct) || null;
}

// Reward status for one callout at the current live PnL: every tier with
// its amount, whether the PnL has reached it, and whether it was already
// claimed. `claimedPcts` is the set of tier percents already claimed for
// this callout.
// Floating-point slack for tier comparisons: a callout at exactly +50%
// live PnL can compute as 49.99999999999999 (double rounding), which
// would wrongly lock the +50% tier. 1e-9 is far below any real PnL gap.
const TIER_EPSILON = 1e-9;

function rewardStatusForCallout(pnlPct, claimedPcts = new Set()) {
  const pct = Number(pnlPct) || 0;
  return REWARD_TIERS.map((t) => ({
    pct: t.pct,
    amountSol: t.amountSol,
    eligible: pct + TIER_EPSILON >= t.pct,
    claimed: claimedPcts.has(t.pct),
  }));
}

// The highest tier the PnL has reached (or null when below the first tier).
function highestReachedTier(pnlPct) {
  const pct = Number(pnlPct) || 0;
  let best = null;
  for (const t of REWARD_TIERS) {
    if (pct + TIER_EPSILON >= t.pct) best = t;
  }
  return best;
}

module.exports = {
  REWARD_TIERS,
  MIN_REWARD_FUND_SOL,
  MAX_REWARD_FUND_SOL,
  tierByPct,
  rewardStatusForCallout,
  highestReachedTier,
};
