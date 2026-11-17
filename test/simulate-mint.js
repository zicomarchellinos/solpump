'use strict';
// Proves the exact client mint recipe against live devnet WITHOUT spending
// anything: builds the same transaction solana.js builds and runs it through
// devnet simulateTransaction (sigVerify off), then checks the simulated
// post-state of the mint account and the creator's token account.
//
// The simulated fee payer needs devnet SOL for rent + fees. This script
// first tries a devnet RPC airdrop; if the RPC faucet refuses, it falls back
// to checking a known wallet's devnet balance. Run with:
//   node test/simulate-mint.js
//
// Nothing here signs or sends a real transaction.

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  MintLayout,
  AuthorityType,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddress,
  unpackMint,
  unpackAccount,
} = require('@solana/spl-token');

const DEVNET_RPC = process.env.SOLANA_DEVNET_RPC || clusterApiUrl('devnet');
const SUPPLY = 1_000_000_000n * 10n ** 6n; // 1B tokens, 6 decimals

async function main() {
  const connection = new Connection(DEVNET_RPC, 'confirmed');
  const payer = Keypair.generate();
  console.log('payer (simulated):', payer.publicKey.toBase58());

  // Fund the simulated payer via the devnet RPC airdrop (may be rate-limited).
  let balance = 0;
  try {
    const sig = await connection.requestAirdrop(payer.publicKey, 1 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, 'confirmed');
    balance = await connection.getBalance(payer.publicKey);
    console.log(`airdrop OK, balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  } catch (err) {
    console.log(`airdrop unavailable (${err.message}), checking fallback wallets…`);
    // Fallback 1: the user's known agent wallet (simulation only — nothing
    // is signed or sent, so using its address as fee payer is safe).
    const fallback = new PublicKey('HyevJPsT3Yf5MTWMph4LaArUqtKS27ScfHF5Cqim6eek');
    const fbBalance = await connection.getBalance(fallback);
    console.log(`fallback wallet devnet balance: ${fbBalance / LAMPORTS_PER_SOL} SOL`);
    if (fbBalance > 0.01 * LAMPORTS_PER_SOL) {
      return simulateWithPayer(connection, fallback, true);
    }
    // Fallback 2: take a fee payer from a recent devnet block. Simulation
    // never signs or sends anything, so any funded non-program address
    // works as the simulated fee payer. (Program accounts cannot be fee
    // payers — the runtime rejects them at sanitize time.) Calls are
    // paced: the public devnet RPC rate-limits (429) on bursts.
    console.log('looking for a funded fee payer in recent devnet blocks…');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const slot = await connection.getSlot('confirmed');
    for (let s = slot; s > slot - 3; s--) {
      await sleep(1200);
      const block = await connection
        .getBlock(s, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 1,
          transactionDetails: 'accounts',
          rewards: false,
        })
        .catch((e) => {
          console.log(`  getBlock(${s}) failed: ${e.message}`);
          return null;
        });
      if (!block) continue;
      for (const tx of (block.transactions || []).slice(0, 2)) {
        // With transactionDetails 'accounts', keys sit directly on
        // tx.transaction.accountKeys as { pubkey, signer, writable }.
        const keys = tx.transaction?.accountKeys || tx.transaction?.message?.accountKeys;
        if (!keys || !keys.length) continue;
        const first = keys[0];
        const payerAddr =
          typeof first === 'string' ? first : first.pubkey || first.toBase58?.();
        if (!payerAddr) continue;
        await sleep(1200);
        const payerKey = new PublicKey(payerAddr);
        const info = await connection.getAccountInfo(payerKey).catch(() => null);
        if (!info || info.executable) continue; // skip program accounts
        if (info.lamports > 0.01 * LAMPORTS_PER_SOL) {
          console.log(`using recent fee payer ${payerAddr} (${info.lamports / LAMPORTS_PER_SOL} SOL)`);
          return simulateWithPayer(connection, payerKey, true);
        }
      }
    }
    throw new Error('No funded devnet payer available for simulation.');
  }
  if (balance < 0.01 * LAMPORTS_PER_SOL) throw new Error('Airdrop gave too little SOL.');
  return simulateWithPayer(connection, payer.publicKey, false, payer);
}

async function simulateWithPayer(connection, payerPubkey, payerIsExternal, payerKeypair) {
  const mint = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(MintLayout.span);
  const ata = await getAssociatedTokenAddress(mint.publicKey, payerPubkey);

  const tx = new Transaction();
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: payerPubkey,
      newAccountPubkey: mint.publicKey,
      lamports,
      space: MintLayout.span,
      programId: TOKEN_PROGRAM_ID,
    })
  );
  tx.add(createInitializeMintInstruction(mint.publicKey, 6, payerPubkey, null));
  tx.add(createAssociatedTokenAccountInstruction(payerPubkey, ata, payerPubkey, mint.publicKey));
  tx.add(createMintToInstruction(mint.publicKey, ata, payerPubkey, SUPPLY));
  tx.add(
    createSetAuthorityInstruction(mint.publicKey, payerPubkey, AuthorityType.MintTokens, null)
  );
  tx.feePayer = payerPubkey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  if (payerKeypair) tx.partialSign(payerKeypair);
  tx.partialSign(mint);
  if (!payerKeypair) {
    // The simulated payer can't sign for us; fill its slot with a dummy
    // signature AFTER partialSign (compiling the message resets the
    // signature array). Simulation runs with sigVerify off, so the dummy
    // is never checked. (In the real client flow Phantom signs as the
    // fee payer.)
    tx.addSignature(payerPubkey, Buffer.alloc(64));
  }

  // simulateTransaction(tx, signers, includeAccounts): pass NO signers —
  // passing signers makes web3.js re-sign (wiping the dummy fee-payer
  // signature) and sets sigVerify=true. Without signers the RPC skips
  // signature verification and simulates our pre-signed transaction as-is.
  const sim = await connection.simulateTransaction(tx, undefined, [mint.publicKey, ata]);
  console.log('simulate err:', sim.value.err);
  if (sim.value.err) {
    console.log('logs:', (sim.value.logs || []).join('\n'));
    process.exit(1);
  }

  // Decode the simulated post-state of the mint account and the ATA.
  const [mintAcc, ataAcc] = sim.value.accounts;
  const mintInfo = unpackMint(mint.publicKey, {
    data: Buffer.from(mintAcc.data[0], 'base64'),
    owner: new PublicKey(mintAcc.owner),
    lamports: mintAcc.lamports,
    executable: false,
    rentEpoch: 0,
  });
  const ataInfo = unpackAccount(ata, {
    data: Buffer.from(ataAcc.data[0], 'base64'),
    owner: new PublicKey(ataAcc.owner),
    lamports: ataAcc.lamports,
    executable: false,
    rentEpoch: 0,
  });
  console.log('mint supply:', mintInfo.supply.toString(), '| decimals:', mintInfo.decimals);
  console.log('mint authority:', mintInfo.mintAuthority);
  console.log('creator ATA balance:', ataInfo.amount.toString());
  console.log('mint address (simulated):', mint.publicKey.toBase58());

  const ok =
    mintInfo.supply === SUPPLY &&
    mintInfo.decimals === 6 &&
    mintInfo.mintAuthority === null &&
    ataInfo.amount === SUPPLY;
  console.log(ok ? 'SIMULATION OK: recipe proven on devnet.' : 'SIMULATION MISMATCH.');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('simulate-mint failed:', err.message);
  process.exit(1);
});
