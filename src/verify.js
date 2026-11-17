'use strict';
// On-chain verification of a freshly minted devnet SPL token, before the
// coin is allowed into the solpump feed. A coin is accepted only when the
// devnet mint account itself proves the recipe was followed:
//   - supply is exactly 1,000,000,000 tokens (6 decimals)
//   - decimals is 6
//   - mint authority is revoked (null)
//   - the creator's token account for this mint holds the full 1B supply
// The mint transaction signature is checked when the RPC can serve it, but a
// missing/unavailable signature lookup does not reject the coin — the mint
// account and the creator's balance are the real proof, and devnet RPC
// lookups for very recent transactions can lag.

const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');
const { unpackMint } = require('@solana/spl-token');
const { MINT_SUPPLY_RAW } = require('./bonding');

const DEVNET_RPC = process.env.SOLANA_DEVNET_RPC || clusterApiUrl('devnet');
const connection = new Connection(DEVNET_RPC, 'confirmed');

async function verifyMint({ mintAddress, creatorWallet, txSignature }) {
  let mintPubkey;
  let creatorPubkey;
  try {
    mintPubkey = new PublicKey(mintAddress);
    creatorPubkey = new PublicKey(creatorWallet);
  } catch {
    return { ok: false, reason: 'Alamat mint atau dompet tidak valid.' };
  }

  // 1. Read the mint account from devnet.
  let accountInfo;
  try {
    accountInfo = await connection.getAccountInfo(mintPubkey);
  } catch (err) {
    return { ok: false, reason: `Gagal membaca mint dari devnet: ${err.message}` };
  }
  if (!accountInfo) {
    return { ok: false, reason: 'Akun mint tidak ditemukan di devnet.' };
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

  // 2. The creator must hold the full supply in their token account.
  let tokenAccounts;
  try {
    tokenAccounts = await connection.getParsedTokenAccountsByOwner(creatorPubkey, {
      mint: mintPubkey,
    });
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

  // 3. Best-effort check that the mint transaction exists on devnet.
  if (txSignature) {
    try {
      const tx = await connection.getTransaction(txSignature, { commitment: 'confirmed' });
      if (tx) {
        if (tx.meta && tx.meta.err) {
          return { ok: false, reason: 'Transaksi mint gagal di jaringan.' };
        }
      } else {
        console.warn(`verifyMint: tx ${txSignature} belum terbaca di devnet, lanjut (mint terverifikasi).`);
      }
    } catch (err) {
      console.warn(`verifyMint: cek transaksi gagal (${err.message}), lanjut (mint terverifikasi).`);
    }
  }

  return { ok: true, supply: mint.supply.toString(), decimals: mint.decimals };
}

module.exports = { verifyMint, DEVNET_RPC };
