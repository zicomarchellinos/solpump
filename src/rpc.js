'use strict';
// Shared devnet RPC connection + retry helper for the server.
// The public devnet RPC rate-limits (429) and lags behind on very recent
// transactions, so every read that gates a user-visible action goes through
// withRetry() instead of failing on the first transient error.

const { Connection, clusterApiUrl } = require('@solana/web3.js');

const DEVNET_RPC = process.env.SOLANA_DEVNET_RPC || clusterApiUrl('devnet');
const connection = new Connection(DEVNET_RPC, 'confirmed');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { attempts = 3, baseDelayMs = 1000, label = 'RPC' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        console.warn(`[rpc] ${label} attempt ${i + 1}/${attempts} failed: ${err.message} — retrying`);
        await sleep(baseDelayMs * (i + 1));
      }
    }
  }
  throw lastErr;
}

module.exports = { connection, DEVNET_RPC, withRetry, sleep };
