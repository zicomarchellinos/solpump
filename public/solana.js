'use strict';
// Client-side Solana devnet integration for solpump.
// Uses the global `solanaWeb3` and `splToken` objects (IIFE bundles served
// locally from /vendor, with a CDN fallback in app.js).
//
// Mint recipe (proven against devnet via simulateTransaction):
//   1. create mint account (rent-exempt, 82 bytes, Token program)
//   2. initialize mint: 6 decimals, mint authority = creator wallet
//   3. create the creator's associated token account (ATA)
//   4. mint 1,000,000,000 tokens to the creator's ATA
//   5. revoke the mint authority (set to null)
// The transaction is partially signed with the new mint keypair, then signed
// by Phantom (window.solana) and broadcast by us.

const DEVNET_RPC = 'https://api.devnet.solana.com';
const TOKEN_SUPPLY = 1_000_000_000;
const TOKEN_DECIMALS = 6;

function getConnection() {
  return new solanaWeb3.Connection(DEVNET_RPC, 'confirmed');
}

function getPhantom() {
  if (typeof window !== 'undefined' && window.solana && window.solana.isPhantom) {
    return window.solana;
  }
  return null;
}

async function getDevnetBalanceSol(pubkey) {
  const connection = getConnection();
  const lamports = await connection.getBalance(new solanaWeb3.PublicKey(pubkey));
  return lamports / solanaWeb3.LAMPORTS_PER_SOL;
}

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

// Signs with Phantom and broadcasts. The mint keypair signs first (Phantom
// cannot sign for it), then Phantom signs as fee payer / authority.
async function signAndSendMint(phantom, transaction, mintKeypair) {
  const connection = getConnection();
  transaction.partialSign(mintKeypair);
  const signed = await phantom.signTransaction(transaction);
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(signature, 'confirmed');
  return signature;
}
