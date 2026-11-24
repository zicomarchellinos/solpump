'use strict';
// Server-side pool wallet for solpump's REAL devnet trading.
//
// Model: no custom on-chain program. The server owns one pool keypair that
// holds the trading liquidity for every coin:
//   - creators fund the pool with 800M tokens of each coin at launch
//   - buys: user sends SOL to the pool, pool sends tokens to the buyer
//   - sells: user sends tokens to the pool, pool sends SOL to the seller
// This is CUSTODIAL: users trust the server to complete the second leg of
// every trade. It is devnet-only (SOL here is free testnet tokens with no
// monetary value) and the UI discloses the pool address + this model.
//
// The pool keypair is loaded from the POOL_SECRET_KEY env var when set
// (JSON array of 64 numbers, Solana CLI id.json format, or a base64 string).
// Otherwise it is generated once, persisted in the server DB (meta table),
// and printed to the server log on first generation so the operator can save
// it. WARNING: on Render's free tier the disk is ephemeral — if the service
// restarts without POOL_SECRET_KEY set, a NEW pool wallet is generated and
// the old pool's tokens/SOL become inaccessible. Set POOL_SECRET_KEY in the
// Render dashboard for any deployment that should survive restarts.

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createBurnCheckedInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getAccount,
} = require('@solana/spl-token');
const db = require('./db');
const { connection, withRetry, sleep } = require('./rpc');

const TOKEN_DECIMALS = 6;
const FEE_BUFFER_LAMPORTS = 10000; // 0.00001 SOL headroom for the pool's own tx fees

function parseSecretKey(raw) {
  const text = String(raw).trim();
  let bytes;
  if (text.startsWith('[')) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr) || arr.length !== 64) throw new Error('POOL_SECRET_KEY must be 64 numbers');
    bytes = Uint8Array.from(arr);
  } else {
    bytes = Uint8Array.from(Buffer.from(text, 'base64'));
  }
  if (bytes.length !== 64) throw new Error('POOL_SECRET_KEY must decode to 64 bytes');
  return Keypair.fromSecretKey(bytes);
}

function loadPoolKeypair() {
  if (process.env.POOL_SECRET_KEY) {
    const kp = parseSecretKey(process.env.POOL_SECRET_KEY);
    console.log(`[pool] using POOL_SECRET_KEY env var, address ${kp.publicKey.toBase58()}`);
    return kp;
  }
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('pool_secret');
  if (row) {
    const kp = parseSecretKey(row.value);
    console.log(`[pool] loaded pool wallet from DB, address ${kp.publicKey.toBase58()}`);
    return kp;
  }
  const kp = Keypair.generate();
  const b64 = Buffer.from(kp.secretKey).toString('base64');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('pool_secret', b64);
  console.warn('[pool] ============================================================');
  console.warn('[pool] GENERATED A NEW POOL WALLET (first run, no POOL_SECRET_KEY).');
  console.warn(`[pool] Address: ${kp.publicKey.toBase58()}`);
  console.warn(`[pool] Secret (base64) — SAVE THIS, then set it as POOL_SECRET_KEY`);
  console.warn(`[pool] in the Render dashboard so trading survives restarts:`);
  console.warn(`[pool] ${b64}`);
  console.warn('[pool] Devnet only — this key holds testnet tokens with no value.');
  console.warn('[pool] ============================================================');
  return kp;
}

const poolKeypair = loadPoolKeypair();
const poolPubkey = poolKeypair.publicKey;

function getPoolAddress() {
  return poolPubkey.toBase58();
}

async function getPoolSolBalance() {
  return withRetry(() => connection.getBalance(poolPubkey), { label: 'getPoolSolBalance' });
}

// SOL balance (lamports) of any wallet — used by the trade pre-check so a
// buy is rejected before signing when the buyer cannot pay for their leg.
async function getSolBalanceOf(walletAddress) {
  return withRetry(
    () => connection.getBalance(new PublicKey(walletAddress)),
    { label: 'getSolBalanceOf' }
  );
}

async function getPoolAta(mintAddress) {
  return getAssociatedTokenAddress(new PublicKey(mintAddress), poolPubkey);
}

// Whole-token balance of the pool's ATA for a mint (0 when the ATA is absent).
async function getPoolTokenBalance(mintAddress) {
  const ata = await getPoolAta(mintAddress);
  const info = await withRetry(() => connection.getAccountInfo(ata), { label: 'getPoolTokenBalance' });
  if (!info) return 0;
  const acc = await getAccount(connection, ata);
  return Number(acc.amount) / 10 ** TOKEN_DECIMALS;
}

async function getTokenBalanceOf(mintAddress, walletAddress) {
  const ata = await getAssociatedTokenAddress(
    new PublicKey(mintAddress),
    new PublicKey(walletAddress)
  );
  const info = await withRetry(() => connection.getAccountInfo(ata), { label: 'getTokenBalanceOf' });
  if (!info) return 0;
  const acc = await getAccount(connection, ata);
  return Number(acc.amount) / 10 ** TOKEN_DECIMALS;
}

// Send a pool-signed transaction with fresh blockhashes and retries.
// Returns the confirmed signature, or throws after all attempts.
async function sendPoolTransaction(buildTx, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const tx = await buildTx();
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.feePayer = poolPubkey;
      tx.recentBlockhash = blockhash;
      tx.sign(poolKeypair);
      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
      });
      try {
        await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'confirmed'
        );
      } catch (confirmErr) {
        // Confirmation can time out even when the tx landed; check once.
        const status = await connection
          .getSignatureStatus(signature, { searchTransactionHistory: true })
          .catch(() => null);
        const s = status && status.value;
        if (s && !s.err && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
          console.log(`[pool] ${label} confirmed on re-check: ${signature}`);
          return signature;
        }
        throw confirmErr;
      }
      return signature;
    } catch (err) {
      lastErr = err;
      console.warn(`[pool] ${label} attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

// Send lamports of SOL from the pool to a wallet. Returns the signature.
async function sendSol(destinationAddress, lamports) {
  const dest = new PublicKey(destinationAddress);
  return sendPoolTransaction(async () => {
    const tx = new Transaction();
    tx.add(
      SystemProgram.transfer({
        fromPubkey: poolPubkey,
        toPubkey: dest,
        lamports,
      })
    );
    return tx;
  }, `sendSol ${lamports} lamports -> ${destinationAddress}`);
}

// Send raw token units (BigInt) from the pool's ATA to a wallet's ATA.
// Creates the destination ATA first (pool pays the rent) when it is missing.
// Returns the signature.
async function sendTokens(mintAddress, destinationAddress, amountRaw) {
  const mint = new PublicKey(mintAddress);
  const dest = new PublicKey(destinationAddress);
  const poolAta = await getPoolAta(mintAddress);
  const destAta = await getAssociatedTokenAddress(mint, dest);
  return sendPoolTransaction(async () => {
    const tx = new Transaction();
    const destInfo = await connection.getAccountInfo(destAta);
    if (!destInfo) {
      tx.add(createAssociatedTokenAccountInstruction(poolPubkey, destAta, dest, mint));
    }
    tx.add(
      createTransferCheckedInstruction(poolAta, mint, destAta, poolPubkey, amountRaw, TOKEN_DECIMALS)
    );
    return tx;
  }, `sendTokens ${amountRaw.toString()} of ${mintAddress} -> ${destinationAddress}`);
}

// Burn raw token units (BigInt) from the pool's own ATA for a mint — the
// pool wallet is the burn authority and signs the transaction itself.
// Used by creator-only dev burns from the pool reserve: burning shrinks
// the mint's on-chain supply AND the curve's token reserve by the same
// amount, so the price rises. Returns the confirmed signature.
async function burnTokens(mintAddress, amountRaw) {
  const mint = new PublicKey(mintAddress);
  const poolAta = await getPoolAta(mintAddress);
  return sendPoolTransaction(async () => {
    const tx = new Transaction();
    tx.add(
      createBurnCheckedInstruction(poolAta, mint, poolPubkey, amountRaw, TOKEN_DECIMALS)
    );
    return tx;
  }, `burnTokens ${amountRaw.toString()} of ${mintAddress} (pool reserve)`);
}

// Mint/add supply: mint new tokens to the pool's ATA for a coin,
// increasing the pool's on-chain token balance AND the curve's
// token_reserve by the same amount. This LOWERS the price
// (price = sol_reserve / token_reserve). Returns the confirmed signature.
async function addSupplyTokens(mintAddress, amountRaw) {
  const mint = new PublicKey(mintAddress);
  const poolAta = await getPoolAta(mintAddress);
  return sendPoolTransaction(async () => {
    const tx = new Transaction();
    tx.add(
      createMintToInstruction(mint, poolAta, poolPubkey, amountRaw)
    );
    return tx;
  }, `addSupplyTokens ${amountRaw.toString()} of ${mintAddress} (pool reserve)`);
}

module.exports = {
  getPoolAddress,
  getPoolSolBalance,
  getSolBalanceOf,
  getPoolAta,
  getPoolTokenBalance,
  getTokenBalanceOf,
  sendSol,
  sendTokens,
  burnTokens,
  addSupplyTokens,
  TOKEN_DECIMALS,
  FEE_BUFFER_LAMPORTS,
  LAMPORTS_PER_SOL,
  TOKEN_PROGRAM_ID,
};
