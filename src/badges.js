'use strict';
// Verified creators + community badges — automatic, computed from DB
// data (no manual step for the verified checkmark), plus manual admin
// grants for community badges (badge_grants table, see ADMIN_WALLETS in
// src/routes.js). Granted badges display exactly like earned ones.
//
// Verified creator (checkmark): a creator earns it when one of their
// coins GRADUATES (curve progress 100% — 85 SOL raised into the reserve)
// OR reaches a $100K market cap. The check is re-computed per request
// from the live reserves, so a creator becomes verified the moment a coin
// crosses either bar (and stays verified — the badge is never revoked
// once earned... in fact it IS recomputed live, so a coin that falls back
// below $100K un-verifies its creator until it crosses again; graduation
// is permanent because reserves only grow past 85 once trades push them
// there — sells can pull the reserve back down, so even graduation is a
// live condition, not a stored flag. The UI states the rule, not a
// promise of permanence.)
//
// Community badges (shown on the profile page and next to usernames in
// callouts/chat), each with a key, an icon, and i18n keys for its name
// and description (the server returns keys; the client translates):
//   Creator      — created at least 1 coin
//   Early Bird   — among the first 10 buyers of any coin
//   Top Trader   — top 3 by trading volume on any coin
//   Callout Star — claimed at least 1 callout reward
//   Whale        — holds >= 1% of the circulating supply of any coin
//                  (holdings from recorded trades, average-cost PnL —
//                  the same holdings the portfolio page shows; on-chain
//                  balances are not consulted here)

const db = require('./db');
const bonding = require('./bonding');
const pairs = require('./pairs');

const VERIFIED_MARKET_CAP_USD = 100000;

const BADGE_DEFS = [
  { key: 'creator', icon: '🚀', nameKey: 'badgeCreator', descKey: 'badgeCreatorDesc' },
  { key: 'earlyBird', icon: '🐦', nameKey: 'badgeEarlyBird', descKey: 'badgeEarlyBirdDesc' },
  { key: 'topTrader', icon: '📈', nameKey: 'badgeTopTrader', descKey: 'badgeTopTraderDesc' },
  { key: 'calloutStar', icon: '⭐', nameKey: 'badgeCalloutStar', descKey: 'badgeCalloutStarDesc' },
  { key: 'whale', icon: '🐋', nameKey: 'badgeWhale', descKey: 'badgeWhaleDesc' },
];

const EARLY_BIRD_COUNT = 10; // first N distinct buyers of a coin
const TOP_TRADER_COUNT = 3; // top N by volume on a coin
const WHALE_FRACTION = 0.01; // >= 1% of the circulating supply

// Wallets whose creator badge (verified checkmark) is currently earned:
// any of their coins graduated or reached $100K market cap. `coinMap` is
// mint -> coin row, `burnedMap` is mint -> total burned, `solUsd` the
// current SOL/USD rate (null = no USD price, market-cap leg skipped).
function computeVerifiedSet({ coinMap, burnedMap, solUsd }) {
  const verified = new Set();
  const usdCache = new Map();
  for (const row of coinMap.values()) {
    if (bonding.curveProgressPct(row) >= 100) {
      verified.add(row.creator_wallet);
      continue;
    }
    const assetUsd = pairs.resolvePairAssetUsdPrice(row, coinMap, solUsd, usdCache);
    const mcUsd = bonding.marketCapUsd(row, assetUsd, burnedMap.get(row.mint_address) || 0);
    if (mcUsd !== null && mcUsd >= VERIFIED_MARKET_CAP_USD) {
      verified.add(row.creator_wallet);
    }
  }
  return verified;
}

// Community badges earned by one wallet, in display order. Targeted
// queries only (no full-table scans): the wallet's traded coins bound the
// work, and each check is one or two indexed queries per coin.
function computeBadgesForWallet(wallet) {
  const earned = new Set();

  const created = db
    .prepare('SELECT 1 FROM coins WHERE creator_wallet = ? LIMIT 1')
    .get(wallet);
  if (created) earned.add('creator');

  const claimedReward = db
    .prepare('SELECT 1 FROM reward_claims WHERE wallet = ? LIMIT 1')
    .get(wallet);
  if (claimedReward) earned.add('calloutStar');

  const tradedMints = db
    .prepare('SELECT DISTINCT mint_address AS mint FROM trades WHERE wallet = ?')
    .all(wallet)
    .map((r) => r.mint);
  for (const mint of tradedMints) {
    // Early Bird: among the first 10 distinct buyers (by first buy).
    if (!earned.has('earlyBird')) {
      const buyers = db
        .prepare(
          `SELECT wallet FROM trades
            WHERE mint_address = ? AND side = 'buy'
            ORDER BY created_at ASC, id ASC`
        )
        .all(mint);
      const first = [];
      const seen = new Set();
      for (const b of buyers) {
        if (seen.has(b.wallet)) continue;
        seen.add(b.wallet);
        first.push(b.wallet);
        if (first.length >= EARLY_BIRD_COUNT) break;
      }
      if (first.includes(wallet)) earned.add('earlyBird');
    }
    // Top Trader: top 3 by total traded volume on this coin.
    if (!earned.has('topTrader')) {
      const top = db
        .prepare(
          `SELECT wallet, SUM(sol_amount) AS v FROM trades
            WHERE mint_address = ?
            GROUP BY wallet ORDER BY v DESC LIMIT ?`
        )
        .all(mint, TOP_TRADER_COUNT);
      if (top.some((t) => t.wallet === wallet)) earned.add('topTrader');
    }
    // Whale: trade-based holdings >= 1% of the circulating supply.
    if (!earned.has('whale')) {
      const coinRow = db
        .prepare('SELECT * FROM coins WHERE mint_address = ?')
        .get(mint);
      if (coinRow) {
        const myTrades = db
          .prepare(
            `SELECT * FROM trades WHERE mint_address = ? AND wallet = ?
             ORDER BY created_at ASC, id ASC`
          )
          .all(mint, wallet);
        const holdings = bonding.computePnl(myTrades, bonding.currentPrice(coinRow)).holdings;
        const burned =
          db
            .prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM burns WHERE mint_address = ?')
            .get(mint).s || 0;
        const circulating = bonding.circulatingSupply(burned);
        if (holdings > 0 && circulating > 0 && holdings >= WHALE_FRACTION * circulating) {
          earned.add('whale');
        }
      }
    }
    if (earned.size === BADGE_DEFS.length) break;
  }

  // Manual admin grants (badge_grants table) display exactly like earned
  // badges — merged here, de-duplicated by the Set. Revoking a grant
  // removes the row, so the badge disappears unless it was also earned.
  const granted = db
    .prepare('SELECT badge FROM badge_grants WHERE wallet = ?')
    .all(wallet);
  for (const g of granted) earned.add(g.badge);

  return BADGE_DEFS.filter((d) => earned.has(d.key)).map((d) => ({ ...d }));
}

module.exports = {
  VERIFIED_MARKET_CAP_USD,
  BADGE_DEFS,
  EARLY_BIRD_COUNT,
  TOP_TRADER_COUNT,
  WHALE_FRACTION,
  computeVerifiedSet,
  computeBadgesForWallet,
};
