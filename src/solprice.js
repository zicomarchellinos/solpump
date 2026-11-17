'use strict';
// SOL/USD price for the USD market-cap display (pump.fun style).
// Fetched server-side from public price APIs that need no API key:
// Jupiter's lite price API first, CoinGecko's simple price as a fallback.
// The price is cached server-side for 60 seconds so pages never hammer the
// APIs, and concurrent requests share one in-flight fetch. If every source
// is unreachable, the last cached price is returned (marked stale); if no
// price has ever been fetched, the price is null and the UI falls back to
// showing market cap in SOL — never a crash, never NaN.
//
// SOL_USD_PRICE env var overrides the live price (tests + emergency escape
// hatch if the APIs are blocked; never set in production).

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5000;

let cached = null; // { price, source, fetchedAt }
let inFlight = null;

function envOverride() {
  const v = Number(process.env.SOL_USD_PRICE);
  return Number.isFinite(v) && v > 0 ? v : null;
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromJupiter() {
  const data = await fetchJson(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
  const price = Number(data?.[SOL_MINT]?.usdPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error('no SOL price in Jupiter response');
  return price;
}

async function fetchFromCoinGecko() {
  const data = await fetchJson(
    'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
  );
  const price = Number(data?.solana?.usd);
  if (!Number.isFinite(price) || price <= 0) throw new Error('no SOL price in CoinGecko response');
  return price;
}

async function fetchFresh() {
  const sources = [
    ['jupiter', fetchFromJupiter],
    ['coingecko', fetchFromCoinGecko],
  ];
  let lastErr;
  for (const [name, fn] of sources) {
    try {
      const price = await fn();
      cached = { price, source: name, fetchedAt: Date.now() };
      return cached;
    } catch (err) {
      lastErr = err;
      console.warn(`[solprice] ${name} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

// Returns { price, source, fetchedAt, stale }.
// `price` is null only when no price has ever been fetched successfully
// (and no SOL_USD_PRICE override is set).
async function getSolUsdPrice() {
  const override = envOverride();
  if (override !== null) {
    return { price: override, source: 'env', fetchedAt: Date.now(), stale: false };
  }
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { ...cached, stale: false };
  }
  if (!inFlight) {
    inFlight = fetchFresh()
      .then((fresh) => ({ ...fresh, stale: false }))
      .catch((err) => {
        // All sources failed: keep serving the last cached price, if any.
        if (cached) {
          console.warn(`[solprice] all sources failed, serving cached price: ${err.message}`);
          return { ...cached, stale: true };
        }
        return { price: null, source: null, fetchedAt: null, stale: false };
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

// Test hooks: inject or clear the cached price without touching the network.
// `fetchedAt` can be set in the past to simulate a stale cache.
function setCachedPriceForTest(price, fetchedAt = Date.now()) {
  cached = { price, source: 'test', fetchedAt };
}
function clearCacheForTest() {
  cached = null;
}

module.exports = {
  getSolUsdPrice,
  setCachedPriceForTest,
  clearCacheForTest,
  CACHE_TTL_MS,
  SOL_MINT,
};
