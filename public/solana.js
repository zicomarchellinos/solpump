'use strict';
// Client-side Solana devnet integration for solpump.
// Uses the global `solanaWeb3` and `splToken` objects (IIFE bundle served
// locally from /vendor-solana.js).
//
// Mint recipe (proven against devnet via simulateTransaction):
//   1. create mint account (rent-exempt, 82 bytes, Token program)
//   2. initialize mint: 6 decimals, mint authority = creator wallet
//   3. create the creator's associated token account (ATA)
//   4. mint 1,000,000,000 tokens to the creator's ATA
//   5. revoke the mint authority (set to null)
// The transaction is partially signed with the new mint keypair, then signed
// by Phantom (window.solana / window.phantom.solana) and broadcast by us.
//
// Trading is REAL devnet trading through the server pool wallet (see
// /api/pool): buys are SOL transfers to the pool, sells are SPL transfers
// to the pool, and the pool completes the other leg. Every user-signed
// transaction is simulated against devnet BEFORE Phantom is asked to sign,
// and every failure surfaces its real error message.

const DEVNET_RPC = 'https://api.devnet.solana.com';
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const TOKEN_SUPPLY = 1_000_000_000;
const FUNDING_TOKENS = 800_000_000;
const TOKEN_DECIMALS = 6;

let cachedPoolAddress = null;
let cachedGenesisOk = null;

function getConnection() {
  return new solanaWeb3.Connection(DEVNET_RPC, 'confirmed');
}

// Phantom detection. Phantom v22+ injects window.phantom.solana; older
// versions inject window.solana. Check the newer namespace first.
function getPhantom() {
  if (typeof window === 'undefined') return null;
  const modern = window.phantom && window.phantom.solana;
  if (modern && modern.isPhantom) return modern;
  const legacy = window.solana;
  if (legacy && legacy.isPhantom) return legacy;
  return null;
}

// The extension can inject after our scripts run; poll briefly for it.
async function waitForPhantom(timeoutMs = 3000) {
  const found = getPhantom();
  if (found) return found;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
    const p = getPhantom();
    if (p) return p;
  }
  return null;
}

// Verify our RPC endpoint really is devnet (genesis hash check). Note: a
// website CANNOT read or change the network selected inside Phantom —
// Phantom exposes no cluster API — so the UI must also tell the user to
// switch Phantom to Devnet explicitly. This check guards our own endpoint.
async function verifyDevnetRpc() {
  if (cachedGenesisOk !== null) return cachedGenesisOk;
  const connection = getConnection();
  const hash = await connection.getGenesisHash();
  cachedGenesisOk = hash === DEVNET_GENESIS_HASH;
  return cachedGenesisOk;
}

async function getPoolAddress() {
  if (cachedPoolAddress) return cachedPoolAddress;
  const res = await fetch('/api/pool');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.address) throw new Error('Gagal membaca alamat pool wallet.');
  cachedPoolAddress = data.address;
  return cachedPoolAddress;
}

async function getDevnetBalanceSol(pubkey) {
  const connection = getConnection();
  const lamports = await connection.getBalance(new solanaWeb3.PublicKey(pubkey));
  return lamports / solanaWeb3.LAMPORTS_PER_SOL;
}

// Exact cost of a mint in SOL: rent for the mint account (82 bytes) + rent
// for the creator's ATA (165 bytes) + a fee buffer for the signatures.
async function getMintCostSol() {
  const connection = getConnection();
  const mintRent = await connection.getMinimumBalanceForRentExemption(
    splToken.MintLayout.span
  );
  const ataRent = await connection.getMinimumBalanceForRentExemption(
    splToken.AccountLayout.span
  );
  const feeBuffer = 0.001 * solanaWeb3.LAMPORTS_PER_SOL; // ~0.001 SOL for fees
  const totalLamports = mintRent + ataRent + feeBuffer;
  return {
    totalSol: totalLamports / solanaWeb3.LAMPORTS_PER_SOL,
    mintRentSol: mintRent / solanaWeb3.LAMPORTS_PER_SOL,
    ataRentSol: ataRent / solanaWeb3.LAMPORTS_PER_SOL,
  };
}

// Live on-chain SPL balance (whole tokens) of a wallet's ATA for a mint.
// Returns 0 when the wallet has no token account for this mint.
async function getTokenBalance(mintAddress, walletAddress) {
  const connection = getConnection();
  const ata = await splToken.getAssociatedTokenAddress(
    new solanaWeb3.PublicKey(mintAddress),
    new solanaWeb3.PublicKey(walletAddress)
  );
  const info = await connection.getAccountInfo(ata);
  if (!info) return 0;
  const parsed = await connection.getParsedAccountInfo(ata);
  const amount =
    parsed && parsed.value && parsed.value.data && parsed.value.data.parsed
      ? parsed.value.data.parsed.info.tokenAmount.uiAmount
      : 0;
  return Number(amount) || 0;
}

// All SPL balances of a wallet in one RPC call: { mintAddress: tokens }.
async function getAllTokenBalances(walletAddress) {
  const connection = getConnection();
  const accounts = await connection.getParsedTokenAccountsByOwner(
    new solanaWeb3.PublicKey(walletAddress),
    { programId: splToken.TOKEN_PROGRAM_ID }
  );
  const out = {};
  for (const a of accounts.value) {
    const info = a.account.data.parsed.info;
    out[info.mint] = Number(info.tokenAmount.uiAmount) || 0;
  }
  return out;
}

// Simulate the exact transaction against devnet BEFORE asking for a
// signature. Returns { ok: true } or { ok: false, error } with the real
// simulation error + program logs.
async function simulateTransaction(tx) {
  const connection = getConnection();
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    const logs = (sim.value.logs || []).join('\n');
    const errText =
      typeof sim.value.err === 'string' ? sim.value.err : JSON.stringify(sim.value.err);
    return { ok: false, error: `Simulasi gagal: ${errText}${logs ? `\n${logs}` : ''}` };
  }
  return { ok: true };
}

// Fetch a fresh blockhash onto a transaction. Must be called AFTER
// simulation and immediately BEFORE signing: a blockhash only stays valid
// for ~60-90s, and a stale one makes the send fail with "Blockhash not
// found". Returns { blockhash, lastValidBlockHeight } for confirmation.
async function refreshBlockhash(tx) {
  const connection = getConnection();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  return { blockhash, lastValidBlockHeight };
}

// Send a fully signed transaction and confirm it. If confirmation times
// out, check the signature status once more before declaring failure —
// a timed-out confirmation does NOT mean the transaction failed.
async function sendAndConfirm(signedTx, { blockhash, lastValidBlockHeight }) {
  const connection = getConnection();
  const signature = await connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: false,
  });
  try {
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  } catch (confirmErr) {
    const status = await connection
      .getSignatureStatus(signature, { searchTransactionHistory: true })
      .catch(() => null);
    const s = status && status.value;
    if (s && !s.err && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
      return signature;
    }
    throw new Error(
      `Transaksi tidak terkonfirmasi tepat waktu (${confirmErr.message}). Cek statusnya di Solana Explorer: ${signature}`
    );
  }
  return signature;
}

// Sign with Phantom and broadcast. `extraSigners` (e.g. the mint keypair)
// sign first — Phantom cannot sign for them.
async function signAndSend(phantom, tx, extraSigners = []) {
  const { blockhash, lastValidBlockHeight } = await refreshBlockhash(tx);
  for (const kp of extraSigners) tx.partialSign(kp);
  const signed = await phantom.signTransaction(tx);
  return sendAndConfirm(signed, { blockhash, lastValidBlockHeight });
}

// Plain-text hint appended to the errors that usually mean Phantom is on
// the wrong network: a website cannot read or switch Phantom's network, so
// when Phantom is on Mainnet its own simulation fails and its balance reads
// as ~0 even though the site's devnet check passed. Keep it plain text
// (no links/markup) — toasts render it with textContent.
const DEVNET_NETWORK_HINT =
  ' Periksa juga jaringan Phantom: harus di Devnet (Phantom → Pengaturan → Developer Settings → Testnet Mode → pilih Devnet). Kalau Phantom di Mainnet, transaksi devnet selalu gagal meski saldo devnet-mu cukup.';

// Friendly Indonesian messages for the errors users actually hit.
function friendlyError(err) {
  const msg = (err && err.message) || String(err);
  if (/user rejected/i.test(msg)) return 'Kamu membatalkan tanda tangan di Phantom.';
  if (/insufficient funds|insufficient lamports/i.test(msg)) {
    return (
      'Saldo SOL devnet tidak cukup untuk transaksi ini. Ambil SOL gratis di faucet.solana.com.' +
      DEVNET_NETWORK_HINT
    );
  }
  if (/failed to simulate|simulation failed|simulasi gagal/i.test(msg)) {
    return (
      'Phantom tidak bisa mensimulasikan transaksi ini. Biasanya karena Phantom di jaringan yang salah (Mainnet, bukan Devnet) atau dompet aktif di Phantom tidak punya SOL devnet.' +
      DEVNET_NETWORK_HINT
    );
  }
  if (/blockhash not found/i.test(msg)) {
    return (
      'Transaksi kedaluwarsa sebelum ditandatangani (blockhash tidak ditemukan). Coba lagi — transaksi baru akan dibuat.' +
      DEVNET_NETWORK_HINT
    );
  }
  if (/429|rate limit/i.test(msg)) {
    return 'RPC devnet sedang sibuk (rate limit). Tunggu sebentar lalu coba lagi.';
  }
  if (/failed to fetch|network error|network request failed/i.test(msg)) {
    return 'Gagal terhubung ke RPC devnet. Periksa koneksimu lalu coba lagi.';
  }
  return msg;
}

// Sign a short UTF-8 message with Phantom (for wallet-proved actions such
// as follow/unfollow — no transaction, no fee). Returns the signature as
// base64. The server rebuilds the expected message and verifies the
// signature against the wallet address.
async function signFollowMessage(phantom, message) {
  const encoded = new TextEncoder().encode(message);
  const signed = await phantom.signMessage(encoded, 'utf8');
  // Phantom returns { signature: Uint8Array, publicKey }. Convert to base64
  // without btoa (binary-safe for arbitrary bytes).
  const bytes = signed.signature;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ---------- Mint ----------

// Builds the full mint transaction for `payerPubkey` (base58).
// Returns { transaction, mintKeypair, mintAddress }.
async function buildMintTransaction(payerPubkey) {
  const connection = getConnection();
  const payer = new solanaWeb3.PublicKey(payerPubkey);
  const mint = solanaWeb3.Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(
    splToken.MintLayout.span
  );
  const ata = await splToken.getAssociatedTokenAddress(mint.publicKey, payer);

  const tx = new solanaWeb3.Transaction();
  tx.add(
    solanaWeb3.SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint.publicKey,
      lamports,
      space: splToken.MintLayout.span,
      programId: splToken.TOKEN_PROGRAM_ID,
    })
  );
  tx.add(
    splToken.createInitializeMintInstruction(
      mint.publicKey,
      TOKEN_DECIMALS,
      payer,
      null // no freeze authority
    )
  );
  tx.add(
    splToken.createAssociatedTokenAccountInstruction(payer, ata, payer, mint.publicKey)
  );
  tx.add(
    splToken.createMintToInstruction(
      mint.publicKey,
      ata,
      payer,
      BigInt(TOKEN_SUPPLY) * 10n ** BigInt(TOKEN_DECIMALS)
    )
  );
  tx.add(
    splToken.createSetAuthorityInstruction(
      mint.publicKey,
      payer,
      splToken.AuthorityType.MintTokens,
      null // revoke mint authority
    )
  );

  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return { transaction: tx, mintKeypair: mint, mintAddress: mint.publicKey.toBase58() };
}

// Signs with Phantom and broadcasts the mint. The mint keypair signs first
// (Phantom cannot sign for it), then Phantom signs as fee payer / authority.
// The blockhash is refreshed immediately before signing so a slow Phantom
// approval cannot expire it.
async function signAndSendMint(phantom, transaction, mintKeypair) {
  return signAndSend(phantom, transaction, [mintKeypair]);
}

// ---------- Pool funding ----------
// Transfer 800M tokens from the creator's ATA to the pool wallet's ATA.
// Creates the pool ATA first (creator pays the rent) when it does not exist.
async function buildFundingTransaction(payerPubkey, mintAddress, poolAddress) {
  const connection = getConnection();
  const payer = new solanaWeb3.PublicKey(payerPubkey);
  const mint = new solanaWeb3.PublicKey(mintAddress);
  const pool = new solanaWeb3.PublicKey(poolAddress);
  const creatorAta = await splToken.getAssociatedTokenAddress(mint, payer);
  const poolAta = await splToken.getAssociatedTokenAddress(mint, pool);

  const tx = new solanaWeb3.Transaction();
  const poolAtaInfo = await connection.getAccountInfo(poolAta);
  if (!poolAtaInfo) {
    tx.add(splToken.createAssociatedTokenAccountInstruction(payer, poolAta, pool, mint));
  }
  tx.add(
    splToken.createTransferCheckedInstruction(
      creatorAta,
      mint,
      poolAta,
      payer,
      BigInt(FUNDING_TOKENS) * 10n ** BigInt(TOKEN_DECIMALS),
      TOKEN_DECIMALS
    )
  );
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return { transaction: tx, poolAta: poolAta.toBase58() };
}

// ---------- Trading ----------
// Buy: transfer SOL (user -> pool). Also creates the buyer's ATA for this
// mint (user pays the rent) when it does not exist yet, so the pool can
// deliver the tokens.
async function buildBuyTransaction(payerPubkey, mintAddress, poolAddress, solAmount) {
  const connection = getConnection();
  const payer = new solanaWeb3.PublicKey(payerPubkey);
  const mint = new solanaWeb3.PublicKey(mintAddress);
  const pool = new solanaWeb3.PublicKey(poolAddress);
  const buyerAta = await splToken.getAssociatedTokenAddress(mint, payer);

  const tx = new solanaWeb3.Transaction();
  const ataInfo = await connection.getAccountInfo(buyerAta);
  if (!ataInfo) {
    tx.add(splToken.createAssociatedTokenAccountInstruction(payer, buyerAta, payer, mint));
  }
  tx.add(
    solanaWeb3.SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: pool,
      lamports: Math.round(solAmount * solanaWeb3.LAMPORTS_PER_SOL),
    })
  );
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return { transaction: tx };
}

// Sell: transfer tokens (user ATA -> pool ATA).
async function buildSellTransaction(payerPubkey, mintAddress, poolAddress, tokenAmount) {
  const connection = getConnection();
  const payer = new solanaWeb3.PublicKey(payerPubkey);
  const mint = new solanaWeb3.PublicKey(mintAddress);
  const pool = new solanaWeb3.PublicKey(poolAddress);
  const userAta = await splToken.getAssociatedTokenAddress(mint, payer);
  const poolAta = await splToken.getAssociatedTokenAddress(mint, pool);

  const tx = new solanaWeb3.Transaction();
  tx.add(
    splToken.createTransferCheckedInstruction(
      userAta,
      mint,
      poolAta,
      payer,
      BigInt(Math.round(tokenAmount * 10 ** TOKEN_DECIMALS)),
      TOKEN_DECIMALS
    )
  );
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return { transaction: tx };
}
