'use strict';
// Pair assets for solpump coins (custom pairs).
//
// Every coin trades against a PAIR ASSET: SOL by default, or any other coin
// already in the site registry (created by any trader). The pair is chosen
// at creation (coins.pair_mint is NULL for SOL pairs, otherwise the pair
// coin's mint address). Trading, curve math, creator fees and PnL work
// identically for both — they are just denominated in the pair asset
// (SOL, or SPL tokens of the pair coin). The pool holds the pair asset and
// pays it out on sells.
//
// USD pricing resolves by walking the pair chain toward SOL:
//   USD price of coin X = price of X in its pair asset x USD price of the
//   pair asset (per unit), where the pair asset's own USD price is resolved
//   the same way, until the chain reaches SOL (priced by the Jupiter /
//   CoinGecko feed in src/solprice.js). Resolution has cycle detection and
//   a max depth (5 hops); a chain that cannot resolve to SOL yields null,
//   and the UI then shows the price in the pair asset only — never a crash.
//
// A cycle cannot form through creation (a new coin's pair must already
// exist, so no pair chain can contain the new coin yet), but the resolver
// still guards against cycles defensively, and creation validates the
// chain does not loop back to the new mint.

const bonding = require('./bonding');

const MAX_PAIR_DEPTH = 5;

// The pair asset of a coin row, resolved against the registry (coinMap is
// a Map of mint address -> coin row). `available` is false when the pair
// coin is no longer in the registry (e.g. after a database reset) —
// trading for the dependent coin is then disabled, not crashed.
function pairAssetOf(coinRow, coinMap) {
  const pairMint = coinRow ? coinRow.pair_mint || null : null;
  if (!pairMint) {
    return { type: 'SOL', symbol: 'SOL', mint: null, name: 'Solana', available: true };
  }
  const pairRow = coinMap ? coinMap.get(pairMint) : undefined;
  if (!pairRow) {
    return {
      type: 'COIN',
      symbol: '?',
      mint: pairMint,
      name: null,
      available: false,
    };
  }
  return {
    type: 'COIN',
    symbol: pairRow.ticker,
    mint: pairMint,
    name: pairRow.name,
    logoUrl: pairRow.logo_url || null,
    available: true,
  };
}

function pairLabel(ticker, pairAsset) {
  return `${ticker}/${pairAsset.symbol}`;
}

// USD price of ONE TOKEN of a coin, resolved through its pair chain toward
// SOL. Returns null when the chain cannot resolve (missing pair coin,
// cycle, too deep, or no SOL/USD price). `cache` memoizes per request so
// resolving many coins sharing a pair stays linear.
function resolveTokenUsdPrice(mintAddress, coinMap, solUsd, cache = new Map()) {
  return resolveTokenUsdPriceInner(mintAddress, coinMap, solUsd, cache, 0, new Set());
}

function resolveTokenUsdPriceInner(mintAddress, coinMap, solUsd, cache, depth, visited) {
  if (cache.has(mintAddress)) return cache.get(mintAddress);
  // Cycle or depth guard: an unresolvable chain yields null, never a loop.
  if (visited.has(mintAddress) || depth > MAX_PAIR_DEPTH) {
    cache.set(mintAddress, null);
    return null;
  }
  const row = coinMap ? coinMap.get(mintAddress) : undefined;
  if (!row) {
    cache.set(mintAddress, null);
    return null;
  }
  const price = bonding.currentPrice(row); // in pair asset per token
  const pairMint = row.pair_mint || null;
  let usd = null;
  if (!pairMint) {
    // SOL pair: price (SOL per token) x SOL/USD.
    usd = Number.isFinite(solUsd) && solUsd > 0 ? price * solUsd : null;
  } else {
    // Coin pair: price (pair tokens per token) x USD price of one pair
    // token, resolved recursively (the pair coin's own USD price).
    visited.add(mintAddress);
    const pairTokenUsd = resolveTokenUsdPriceInner(
      pairMint,
      coinMap,
      solUsd,
      cache,
      depth + 1,
      visited
    );
    visited.delete(mintAddress);
    usd = pairTokenUsd === null ? null : price * pairTokenUsd;
  }
  cache.set(mintAddress, usd);
  return usd;
}

// USD price of ONE UNIT of a coin's pair asset (SOL/USD for SOL pairs, the
// pair coin's USD token price for coin pairs). This is the rate that
// converts pair-asset amounts (prices, volumes, fees, PnL) to USD. Null
// when it cannot be resolved.
function resolvePairAssetUsdPrice(coinRow, coinMap, solUsd, cache = new Map()) {
  const pairMint = coinRow ? coinRow.pair_mint || null : null;
  if (!pairMint) {
    return Number.isFinite(solUsd) && solUsd > 0 ? solUsd : null;
  }
  return resolveTokenUsdPrice(pairMint, coinMap, solUsd, cache);
}

// Validate a pair choice at coin creation. `pairMint` is null/undefined
// for SOL (always valid). Otherwise the pair must be a coin already in the
// registry, must not be the new coin itself, and its pair chain must not
// loop back to the new mint (defensive — a new mint cannot appear in any
// existing chain yet, but the check makes the invariant explicit).
function validatePairChoice(pairMint, newMintAddress, coinMap) {
  if (!pairMint) return { ok: true };
  if (pairMint === newMintAddress) {
    return { ok: false, reason: 'Coin tidak bisa dipasangkan dengan dirinya sendiri.' };
  }
  const pairRow = coinMap ? coinMap.get(pairMint) : undefined;
  if (!pairRow) {
    return { ok: false, reason: 'Coin pasangan tidak ditemukan di registry.' };
  }
  // Walk the pair's chain: it must not contain the new mint (cycle) and
  // must terminate at SOL within the depth limit.
  const seen = new Set([newMintAddress]);
  let current = pairRow;
  let depth = 0;
  while (current && current.pair_mint) {
    if (seen.has(current.pair_mint)) {
      return { ok: false, reason: 'Pasangan ini akan membentuk rantai pair yang melingkar.' };
    }
    seen.add(current.pair_mint);
    depth += 1;
    if (depth > MAX_PAIR_DEPTH) {
      return { ok: false, reason: 'Rantai pair pasangan ini terlalu dalam (maksimal 5 level).' };
    }
    current = coinMap.get(current.pair_mint);
    if (!current) {
      return { ok: false, reason: 'Rantai pair pasangan ini terputus (coin pasangan tidak ditemukan).' };
    }
  }
  return { ok: true };
}

module.exports = {
  MAX_PAIR_DEPTH,
  pairAssetOf,
  pairLabel,
  resolveTokenUsdPrice,
  resolvePairAssetUsdPrice,
  validatePairChoice,
};
