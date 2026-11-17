'use strict';
// On-chain verification for solpump, all against Solana devnet:
//   verifyMint          — a fresh mint follows the recipe (1B supply,
//                         6 decimals, mint authority revoked) and the
//                         expected wallet holds the supply (creator holds
//                         1B when unfunded; the pool holds 800M when funded)
//   verifyFunding       — the pool's ATA for a mint holds exactly 800M tokens
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

async function verifyMint({ mintAddress, creatorWallet, txSignature, expectFunded }) {
  const mintPubkey = parsePubkey(mintAddress);
  const creatorPubkey = parsePubkey(creatorWallet);
  if (!mintPubkey || !creatorPubkey) {
    return { ok: false, reason: 'Alamat mint atau dompet tidak valid.' };
  }

  // 1. Read the mint account from devnet (retried: RPC lag/rate limits).
  let accountInfo;
  try {
    accountInfo = await getAccountInfoRetry(mintPubkey, 'verifyMint mint account');
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
      reason: 'Transaksi tidak berisi transfer token yang sesuai ke pool.',
    };
  }
  return { ok: true };
}

module.exports = {
  verifyMint,
  verifyFunding,
  verifySolTransfer,
  verifyTokenTransfer,
  DEVNET_RPC,
};
