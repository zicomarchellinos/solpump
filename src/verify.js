'use strict';
// On-chain verification for solpump, all against Solana devnet:
//   verifyMint          — a fresh mint follows the recipe (1B supply,
//                         6 decimals, mint authority revoked) and the
//                         expected wallet holds the supply (creator holds
//                         1B when unfunded; the pool holds 800M when funded)
//   verifyFunding       — the pool's ATA for a mint holds exactly 800M tokens
//   verifyReRegister    — an existing mint can be restored to the feed
//                         after a database wipe: same mint profile, the
//                         pool still holds some of the token, and the
//                         signer is the mint's creator (earliest-tx fee
//                         payer, or a token-holding fallback when the
//                         mint's history cannot be read)
//   verifySolTransfer   — a transaction moved N lamports wallet -> pool
//   verifyTokenTransfer — a transaction moved N raw token units ATA -> ATA
//
// Every RPC read goes through withRetry(): the public devnet RPC rate-limits
// (429) and lags on very recent transactions, and a transient failure must
// not make a real mint or trade look fake. Transaction lookups are retried
// because a just-confirmed transaction can take a few seconds to appear in
// getParsedTransaction results.

const { PublicKey } = require('@solana/web3.js');
const { unpackMint, getAssociatedTokenAddress } = require('@solana/spl-token');
const { MINT_SUPPLY_RAW, FUNDING_TOKENS_RAW } = require('./bonding');
const { connection, withRetry, DEVNET_RPC } = require('./rpc');

const TX_RECENCY_SECONDS = 15 * 60; // user txs must be at most 15 min old

async function getAccountInfoRetry(pubkey, label) {
  return withRetry(
    async () => {
      const info = await connection.getAccountInfo(pubkey);
      if (!info) throw new Error('account not found yet');
      return info;
    },
    { attempts: 4, baseDelayMs: 1500, label }
  );
}

async function getParsedTransactionRetry(signature, label) {
  return withRetry(
    async () => {
      const tx = await connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) throw new Error('transaction not indexed yet');
      return tx;
    },
    { attempts: 5, baseDelayMs: 2000, label }
  );
}

function parsePubkey(value) {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

// Read a mint account from devnet and check it follows the solpump mint
// profile: 1B supply, 6 decimals, mint authority revoked. Shared by
// verifyMint (fresh registration) and verifyReRegister (restoring a wiped
// coin). Returns { ok, mint, supply, decimals } or { ok: false, reason }.
async function readMintProfile(mintAddress) {
  const mintPubkey = parsePubkey(mintAddress);
  if (!mintPubkey) {
    return { ok: false, reason: 'Alamat mint tidak valid.' };
  }
  let accountInfo;
  try {
    accountInfo = await getAccountInfoRetry(mintPubkey, 'readMintProfile mint account');
  } catch (err) {
    return { ok: false, reason: `Gagal membaca mint dari devnet: ${err.message}` };
  }
  let mint;
  try {
    mint = unpackMint(mintPubkey, accountInfo);
  } catch {
    return { ok: false, reason: 'Akun tersebut bukan mint SPL yang valid.' };
  }
  if (mint.supply !== MINT_SUPPLY_RAW) {
    return {
      ok: false,
      reason: `Suplai mint ${mint.supply.toString()} tidak sama dengan 1.000.000.000 token.`,
    };
  }
  if (mint.decimals !== 6) {
    return { ok: false, reason: `Desimal mint ${mint.decimals}, harus 6.` };
  }
  if (mint.mintAuthority !== null) {
    return { ok: false, reason: 'Otoritas mint belum dicabut.' };
  }
  return { ok: true, mint, supply: mint.supply.toString(), decimals: mint.decimals };
}

async function verifyMint({ mintAddress, creatorWallet, txSignature, expectFunded }) {
  const mintPubkey = parsePubkey(mintAddress);
  const creatorPubkey = parsePubkey(creatorWallet);
  if (!mintPubkey || !creatorPubkey) {
    return { ok: false, reason: 'Alamat mint atau dompet tidak valid.' };
  }

  // 1. Read the mint account from devnet (retried: RPC lag/rate limits)
  //    and check the solpump mint profile.
  const profile = await readMintProfile(mintAddress);
  if (!profile.ok) return profile;
  const { mint } = profile;

  // 2. Who holds the supply depends on whether the pool was funded.
  //    Unfunded: the creator holds all 1B. Funded: the pool holds 800M
  //    (the creator keeps 200M), checked by verifyFunding below.
  if (!expectFunded) {
    let tokenAccounts;
    try {
      tokenAccounts = await withRetry(
        () => connection.getParsedTokenAccountsByOwner(creatorPubkey, { mint: mintPubkey }),
        { label: 'verifyMint creator token accounts' }
      );
    } catch (err) {
      return { ok: false, reason: `Gagal membaca akun token kreator: ${err.message}` };
    }
    const holdsSupply = tokenAccounts.value.some(
      (a) => a.account.data.parsed.info.tokenAmount.amount === MINT_SUPPLY_RAW.toString()
    );
    if (!holdsSupply) {
      return {
        ok: false,
        reason: 'Dompet kreator tidak memegang 1.000.000.000 token mint ini.',
      };
    }
  }

  // 3. Best-effort check that the mint transaction exists on devnet.
  if (txSignature) {
    try {
      const tx = await getParsedTransactionRetry(txSignature, 'verifyMint mint tx');
      if (tx.meta && tx.meta.err) {
        return { ok: false, reason: 'Transaksi mint gagal di jaringan.' };
      }
    } catch (err) {
      console.warn(
        `verifyMint: tx ${txSignature} belum terbaca di devnet (${err.message}), lanjut (mint terverifikasi).`
      );
    }
  }

  return { ok: true, supply: mint.supply.toString(), decimals: mint.decimals };
}

// The pool's ATA for this mint must hold exactly 800M tokens (raw units).
async function verifyFunding({ mintAddress, poolWallet }) {
  const mintPubkey = parsePubkey(mintAddress);
  const poolPubkey = parsePubkey(poolWallet);
  if (!mintPubkey || !poolPubkey) {
    return { ok: false, reason: 'Alamat mint atau pool tidak valid.' };
  }
  const poolAta = await getAssociatedTokenAddress(mintPubkey, poolPubkey);
  let info;
  try {
    info = await getAccountInfoRetry(poolAta, 'verifyFunding pool ATA');
  } catch {
    return { ok: false, reason: 'Pool belum menerima 800.000.000 token coin ini.' };
  }
  let parsed;
  try {
    parsed = await withRetry(
      () => connection.getParsedAccountInfo(poolAta),
      { label: 'verifyFunding pool ATA parsed' }
    );
  } catch (err) {
    return { ok: false, reason: `Gagal membaca saldo pool: ${err.message}` };
  }
  const amount =
    parsed && parsed.value && parsed.value.data && parsed.value.data.parsed
      ? parsed.value.data.parsed.info.tokenAmount.amount
      : null;
  if (amount === null) {
    return { ok: false, reason: 'Akun token pool tidak bisa dibaca.' };
  }
  if (BigInt(amount) !== FUNDING_TOKENS_RAW) {
    return {
      ok: false,
      reason: `Pool memegang ${(Number(amount) / 1e6).toLocaleString('id-ID')} token, harus 800.000.000.`,
    };
  }
  return { ok: true, poolAta: poolAta.toBase58(), amount };
}

// ---- Re-register verification ----
// How far back the creatorship check walks the mint's history:
// getSignaturesForAddress returns newest-first, capped at 1000 per call.
// A solpump mint's creation tx is its very first transaction, so walking
// back in pages of 1000 (max 5 pages) reaches it for any realistic mint.
const MINT_HISTORY_PAGE_LIMIT = 1000;
const MINT_HISTORY_MAX_PAGES = 5;

// The mint's full signature list (newest first), paginated back to its
// first transaction. Throws when the RPC fails after retries.
async function fetchMintHistory(mintPubkey) {
  const all = [];
  let before;
  for (let page = 0; page < MINT_HISTORY_MAX_PAGES; page++) {
    const opts = { limit: MINT_HISTORY_PAGE_LIMIT };
    if (before) opts.before = before;
    const list = await withRetry(
      () => connection.getSignaturesForAddress(mintPubkey, opts),
      { label: 'mint history signatures' }
    );
    if (!list || list.length === 0) break;
    all.push(...list);
    if (list.length < MINT_HISTORY_PAGE_LIMIT) break; // reached the oldest
    before = list[list.length - 1].signature;
  }
  return all;
}

// The mint's creator: the fee payer (accountKeys[0]) of the mint's
// earliest successful transaction. solpump's mint builder sets the
// creator as fee payer, so the creation tx's payer IS the creator.
// Returns { ok, creatorWallet, txSignature } or { ok: false, reason }.
async function findMintCreator(mintAddress) {
  const mintPubkey = parsePubkey(mintAddress);
  if (!mintPubkey) return { ok: false, reason: 'Alamat mint tidak valid.' };
  let history;
  try {
    history = await fetchMintHistory(mintPubkey);
  } catch (err) {
    return { ok: false, reason: `Gagal membaca riwayat mint: ${err.message}` };
  }
  if (!history.length) {
    return { ok: false, reason: 'Riwayat mint kosong.' };
  }
  // Earliest first; try up to 3 — a failed transaction can precede the
  // successful creation (e.g. a dropped attempt).
  const earliest = history.slice(-3).reverse();
  for (const entry of earliest) {
    let tx;
    try {
      tx = await getParsedTransactionRetry(entry.signature, 'findMintCreator earliest tx');
    } catch {
      continue;
    }
    if (tx.meta && tx.meta.err) continue;
    const keys =
      tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys;
    if (!keys || !keys[0]) continue;
    // Parsed accountKeys are { pubkey, signer, writable }; be liberal
    // about the shape (older responses may carry bare PublicKeys).
    const payerKey = keys[0].pubkey || keys[0];
    const payer = typeof payerKey === 'string'
      ? payerKey
      : payerKey && payerKey.toBase58
        ? payerKey.toBase58()
        : null;
    if (!payer) continue;
    return { ok: true, creatorWallet: payer, txSignature: entry.signature };
  }
  return { ok: false, reason: 'Transaksi pembuatan mint tidak bisa dibaca.' };
}

// Fallback creatorship proof: does the wallet hold any tokens of the mint?
// Only used when the mint's history cannot be read at all.
async function walletHoldsMint(mintAddress, walletAddress) {
  const mintPubkey = parsePubkey(mintAddress);
  const walletPubkey = parsePubkey(walletAddress);
  if (!mintPubkey || !walletPubkey) return false;
  try {
    const accounts = await withRetry(
      () => connection.getParsedTokenAccountsByOwner(walletPubkey, { mint: mintPubkey }),
      { label: 're-register holder fallback' }
    );
    return (accounts.value || []).some((a) => {
      const info = a.account && a.account.data && a.account.data.parsed
        ? a.account.data.parsed.info
        : null;
      return info && BigInt(info.tokenAmount.amount || '0') > 0n;
    });
  } catch {
    return false;
  }
}

// Verify an existing mint for re-registration after a database wipe:
//   1. the mint follows the solpump profile (1B / 6 decimals / authority
//      revoked) — a random mint cannot be registered;
//   2. the pool still holds some of the token — proves this mint was a
//      solpump coin funded into the pool (and gives the reconstructed
//      token reserve);
//   3. the signer is the mint's creator — primary proof is the mint's
//      earliest transaction (fee payer); when the history is unavailable
//      (RPC pruning/gaps) the fallback requires the signer to hold tokens
//      of the mint. The fallback is weaker (any holder could claim a
//      coin whose history is gone), so it only triggers when the history
//      genuinely cannot be read, and the proof used is reported back
//      (creatorProof: 'mint-history' | 'token-holding').
// Returns { ok, creatorProof, txSignature, poolTokens, supply, decimals }
// or { ok: false, reason }.
async function verifyReRegister({ mintAddress, creatorWallet, poolWallet }) {
  const profile = await readMintProfile(mintAddress);
  if (!profile.ok) return profile;

  const mintPubkey = parsePubkey(mintAddress);
  const poolPubkey = parsePubkey(poolWallet);
  if (!poolPubkey) {
    return { ok: false, reason: 'Alamat pool tidak valid.' };
  }
  const poolAta = await getAssociatedTokenAddress(mintPubkey, poolPubkey);
  let poolBalanceRaw = 0n;
  try {
    const parsed = await withRetry(
      () => connection.getParsedAccountInfo(poolAta),
      { label: 'verifyReRegister pool ATA' }
    );
    const amount =
      parsed && parsed.value && parsed.value.data && parsed.value.data.parsed
        ? parsed.value.data.parsed.info.tokenAmount.amount
        : null;
    if (amount !== null) poolBalanceRaw = BigInt(amount);
  } catch (err) {
    return { ok: false, reason: `Gagal membaca saldo pool: ${err.message}` };
  }
  if (poolBalanceRaw <= 0n) {
    return {
      ok: false,
      reason: 'Pool tidak memegang token coin ini — coin ini belum pernah didanai ke pool, atau pool sudah kosong.',
    };
  }
  const poolTokens = Number(poolBalanceRaw) / 1e6;

  const creator = await findMintCreator(mintAddress);
  if (creator.ok) {
    if (creator.creatorWallet !== creatorWallet) {
      return {
        ok: false,
        reason: 'Dompet ini bukan kreator coin ini (pembuat mint adalah dompet lain).',
      };
    }
    return {
      ok: true,
      creatorProof: 'mint-history',
      txSignature: creator.txSignature,
      poolTokens,
      supply: profile.supply,
      decimals: profile.decimals,
    };
  }
  console.warn(
    `verifyReRegister: mint-history proof unavailable for ${mintAddress} (${creator.reason}) — trying token-holding fallback`
  );
  const holds = await walletHoldsMint(mintAddress, creatorWallet);
  if (!holds) {
    return {
      ok: false,
      reason: 'Dompet ini bukan kreator coin ini: riwayat mint tidak bisa dibaca dan dompet tidak memegang token coin ini.',
    };
  }
  return {
    ok: true,
    creatorProof: 'token-holding',
    txSignature: null,
    poolTokens,
    supply: profile.supply,
    decimals: profile.decimals,
  };
}

// A parsed transaction moved exactly `lamports` from `fromWallet` to
// `toWallet` via a SystemProgram transfer, succeeded, and is recent.
async function verifySolTransfer({ signature, fromWallet, toWallet, lamports }) {
  let tx;
  try {
    tx = await getParsedTransactionRetry(signature, 'verifySolTransfer');
  } catch (err) {
    return { ok: false, reason: `Transaksi tidak ditemukan di devnet: ${err.message}` };
  }
  if (tx.meta && tx.meta.err) {
    return { ok: false, reason: 'Transaksi gagal di jaringan.' };
  }
  if (tx.blockTime && Date.now() / 1000 - tx.blockTime > TX_RECENCY_SECONDS) {
    return { ok: false, reason: 'Transaksi terlalu lama (maksimal 15 menit).' };
  }
  const instructions = tx.transaction.message.instructions || [];
  const match = instructions.find(
    (ix) =>
      ix.program === 'system' &&
      ix.parsed &&
      ix.parsed.type === 'transfer' &&
      ix.parsed.info.source === fromWallet &&
      ix.parsed.info.destination === toWallet &&
      Number(ix.parsed.info.lamports) === lamports
  );
  if (!match) {
    return {
      ok: false,
      reason: `Transaksi tidak berisi transfer ${lamports / 1e9} SOL dari dompetmu ke pool.`,
    };
  }
  return { ok: true };
}

// A parsed transaction moved exactly `amountRaw` token units from `fromAta`
// to `toAta` (transfer or transferChecked), succeeded, and is recent.
async function verifyTokenTransfer({ signature, fromAta, toAta, amountRaw }) {
  let tx;
  try {
    tx = await getParsedTransactionRetry(signature, 'verifyTokenTransfer');
  } catch (err) {
    return { ok: false, reason: `Transaksi tidak ditemukan di devnet: ${err.message}` };
  }
  if (tx.meta && tx.meta.err) {
    return { ok: false, reason: 'Transaksi gagal di jaringan.' };
  }
  if (tx.blockTime && Date.now() / 1000 - tx.blockTime > TX_RECENCY_SECONDS) {
    return { ok: false, reason: 'Transaksi terlalu lama (maksimal 15 menit).' };
  }
  const instructions = tx.transaction.message.instructions || [];
  const match = instructions.find((ix) => {
    if (ix.program !== 'spl-token' || !ix.parsed) return false;
    const info = ix.parsed.info || {};
    const amount =
      ix.parsed.type === 'transferChecked'
        ? info.tokenAmount && info.tokenAmount.amount
        : ix.parsed.type === 'transfer'
          ? info.amount
          : null;
    return (
      amount !== null &&
      info.source === fromAta &&
      info.destination === toAta &&
      BigInt(amount) === amountRaw
    );
  });
  if (!match) {
    return {
      ok: false,
      reason: 'Transaksi tidak berisi transfer token yang sesuai.',
    };
  }
  return { ok: true };
}

// A parsed transaction burned exactly `amountRaw` token units of `mint`
// from the wallet's own token account (burn or burnChecked), signed by the
// wallet (the burn authority), succeeded, and is recent.
async function verifyBurn({ signature, mintAddress, wallet, amountRaw }) {
  let tx;
  try {
    tx = await getParsedTransactionRetry(signature, 'verifyBurn');
  } catch (err) {
    return { ok: false, reason: `Transaksi tidak ditemukan di devnet: ${err.message}` };
  }
  if (tx.meta && tx.meta.err) {
    return { ok: false, reason: 'Transaksi gagal di jaringan.' };
  }
  if (tx.blockTime && Date.now() / 1000 - tx.blockTime > TX_RECENCY_SECONDS) {
    return { ok: false, reason: 'Transaksi terlalu lama (maksimal 15 menit).' };
  }
  const mintPubkey = parsePubkey(mintAddress);
  const walletPubkey = parsePubkey(wallet);
  if (!mintPubkey || !walletPubkey) {
    return { ok: false, reason: 'Alamat mint atau dompet tidak valid.' };
  }
  const userAta = (await getAssociatedTokenAddress(mintPubkey, walletPubkey)).toBase58();
  const instructions = tx.transaction.message.instructions || [];
  const match = instructions.find((ix) => {
    if (ix.program !== 'spl-token' || !ix.parsed) return false;
    const info = ix.parsed.info || {};
    const amount =
      ix.parsed.type === 'burnChecked'
        ? info.tokenAmount && info.tokenAmount.amount
        : ix.parsed.type === 'burn'
          ? info.amount
          : null;
    return (
      amount !== null &&
      info.account === userAta &&
      info.mint === mintAddress &&
      info.authority === wallet &&
      BigInt(amount) === amountRaw
    );
  });
  if (!match) {
    return {
      ok: false,
      reason: 'Transaksi tidak berisi burn token yang sesuai dari dompetmu.',
    };
  }
  return { ok: true };
}

module.exports = {
  verifyMint,
  verifyFunding,
  verifyReRegister,
  findMintCreator,
  readMintProfile,
  verifySolTransfer,
  verifyTokenTransfer,
  verifyBurn,
  DEVNET_RPC,
};
