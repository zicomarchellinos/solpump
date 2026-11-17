'use strict';
// Tests the EXACT client code in public/solana.js (loaded in a VM sandbox
// with the real @solana/web3.js + @solana/spl-token libs) against live devnet:
//   1. Phantom detection: window.solana vs window.phantom.solana variants,
//      late injection via waitForPhantom
//   2. Devnet genesis-hash check against the live RPC endpoint
//   3. Mint cost computation (rent + fee buffer)
//   4. buildMintTransaction + simulateTransaction with the exact client
//      code path (needs a funded fee payer for simulation — found via an
//      airdrop attempt, then a recent devnet block, like simulate-mint.js)
//   5. Funding / buy / sell transaction construction (instruction contents)
//   6. Burn / transfer / pair-buy transaction construction (instruction
//      contents): BurnChecked with the exact amount, TransferChecked to a
//      recipient ATA (created when missing), and pair-asset TransferChecked
//      from the buyer's pair ATA to the pool's pair ATA
//   7. friendlyError message mapping
// Nothing here signs or sends a real transaction. The Phantom signature
// step itself cannot be exercised here (no wallet extension).
// Run with:
//   node test/mint-flow.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const solanaWeb3 = require('@solana/web3.js');
const splToken = require('@solana/spl-token');

const { Keypair, PublicKey, LAMPORTS_PER_SOL } = solanaWeb3;

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok - ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Load the real client file into a VM sandbox with browser-like globals.
function loadClient() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'solana.js'), 'utf8');
  const sandbox = {
    window: {},
    solanaWeb3,
    splToken,
    fetch,
    console,
    setTimeout,
    Date,
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'public/solana.js' });
  return sandbox;
}

async function findFundedPayer() {
  const connection = new solanaWeb3.Connection(solanaWeb3.clusterApiUrl('devnet'), 'confirmed');
  // Try 1: fresh keypair + RPC airdrop (the devnet RPC faucet is often closed).
  const fresh = Keypair.generate();
  try {
    const sig = await connection.requestAirdrop(fresh.publicKey, 1 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, 'confirmed');
    const bal = await connection.getBalance(fresh.publicKey);
    if (bal > 0.01 * LAMPORTS_PER_SOL) {
      console.log(`  (simulation payer: airdrop ${bal / LAMPORTS_PER_SOL} SOL)`);
      return fresh.publicKey.toBase58();
    }
  } catch (err) {
    console.log(`  (airdrop unavailable: ${err.message})`);
  }
  // Try 2: a funded non-program account from a recent devnet block.
  // Simulation never signs or sends anything, so any funded address works
  // as the simulated fee payer.
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
      .catch(() => null);
    if (!block) continue;
    for (const tx of (block.transactions || []).slice(0, 2)) {
      const keys = tx.transaction?.accountKeys || tx.transaction?.message?.accountKeys;
      if (!keys || !keys.length) continue;
      const first = keys[0];
      // pubkey may be a string or a PublicKey object — normalize to base58.
      const payerAddr = (
        typeof first === 'string' ? first : first.pubkey || first.toBase58?.()
      )?.toString();
      if (!payerAddr) continue;
      await sleep(1200);
      const info = await connection.getAccountInfo(new PublicKey(payerAddr)).catch(() => null);
      if (!info || info.executable) continue;
      if (info.lamports > 0.01 * LAMPORTS_PER_SOL) {
        console.log(`  (simulation payer: recent fee payer ${payerAddr})`);
        return payerAddr;
      }
    }
  }
  throw new Error('No funded devnet payer available for simulation.');
}

async function main() {
  const client = loadClient();
  const {
    getPhantom,
    waitForPhantom,
    verifyDevnetRpc,
    getMintCostSol,
    getDevnetBalanceSol,
    buildMintTransaction,
    buildFundingTransaction,
    buildBuyTransaction,
    buildSellTransaction,
    buildBurnTransaction,
    buildTransferTransaction,
    buildPairBuyTransaction,
    simulateTransaction,
    friendlyError,
  } = client;

  // ---------- 1. Phantom detection variants ----------
  console.log('Phantom detection:');
  client.window.solana = undefined;
  client.window.phantom = undefined;
  assert(getPhantom() === null, 'no wallet -> null');

  const legacy = { isPhantom: true, name: 'legacy' };
  client.window.solana = legacy;
  assert(getPhantom() === legacy, 'window.solana (legacy) detected');

  const modern = { isPhantom: true, name: 'modern' };
  client.window.phantom = { solana: modern };
  assert(getPhantom() === modern, 'window.phantom.solana preferred when both exist');

  delete client.window.solana;
  assert(getPhantom() === modern, 'window.phantom.solana alone detected (Phantom v22+)');

  client.window.solana = { isPhantom: false };
  client.window.phantom = undefined;
  assert(getPhantom() === null, 'non-Phantom window.solana ignored');

  // Late injection: waitForPhantom picks up a wallet injected mid-wait.
  client.window.solana = undefined;
  setTimeout(() => {
    client.window.solana = legacy;
  }, 300);
  const late = await waitForPhantom(3000);
  assert(late === legacy, 'waitForPhantom finds a late-injected wallet');
  client.window.solana = undefined;
  const absent = await waitForPhantom(500);
  assert(absent === null, 'waitForPhantom returns null when nothing injects');

  // ---------- 2. Devnet genesis check + mint cost (live RPC) ----------
  console.log('devnet RPC checks:');
  const genesisOk = await verifyDevnetRpc();
  assert(genesisOk === true, 'RPC genesis hash matches devnet (EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG)');

  const cost = await getMintCostSol();
  assert(cost.totalSol > 0 && cost.totalSol < 0.02, `mint cost computed: ${cost.totalSol} SOL`);
  assert(
    Math.abs(cost.totalSol - (cost.mintRentSol + cost.ataRentSol + 0.001)) < 1e-12,
    'mint cost = mint rent + ATA rent + 0.001 fee buffer'
  );

  const payer = await findFundedPayer();
  const bal = await getDevnetBalanceSol(payer);
  assert(bal > 0.01, `simulation payer balance ${bal} SOL covers the mint cost`);

  // ---------- 3. Mint tx: build + simulate with the exact client code ----------
  console.log('mint transaction (exact client code):');
  const built = await buildMintTransaction(payer);
  assert(built.transaction.instructions.length === 5, 'mint tx has 5 instructions');
  assert(
    built.transaction.feePayer.toBase58() === payer,
    'mint tx fee payer is the connected wallet'
  );
  assert(built.transaction.recentBlockhash, 'mint tx has a recent blockhash');
  const [ix0, ix1, ix2, ix3, ix4] = built.transaction.instructions;
  assert(ix0.programId.equals(solanaWeb3.SystemProgram.programId), 'ix0: create mint account (System)');
  assert(ix1.programId.equals(splToken.TOKEN_PROGRAM_ID), 'ix1: initialize mint (Token)');
  assert(ix2.programId.equals(splToken.ASSOCIATED_TOKEN_PROGRAM_ID), 'ix2: create creator ATA');
  assert(ix3.programId.equals(splToken.TOKEN_PROGRAM_ID), 'ix3: mint to creator ATA');
  assert(ix4.programId.equals(splToken.TOKEN_PROGRAM_ID), 'ix4: revoke mint authority');
  const mintToAmount = ix3.data.readBigUInt64LE(1);
  assert(mintToAmount === 1000000000000000n, `mintTo mints exactly 1B tokens (raw ${mintToAmount})`);
  const sim = await simulateTransaction(built.transaction);
  assert(sim.ok, `mint tx simulates cleanly on devnet${sim.ok ? '' : `: ${sim.error}`}`);

  // ---------- 4. Funding / buy / sell tx construction ----------
  console.log('funding + trading transactions:');
  const pool = Keypair.generate().publicKey.toBase58();
  const funding = await buildFundingTransaction(payer, built.mintAddress, pool);
  const fundIx = funding.transaction.instructions;
  assert(fundIx.length === 2, 'funding tx creates the pool ATA + transfers (2 ix)');
  const transferIx = fundIx[fundIx.length - 1];
  assert(transferIx.programId.equals(splToken.TOKEN_PROGRAM_ID), 'funding transfer is a Token instruction');
  assert(transferIx.data[0] === 12, 'funding transfer is TransferChecked');
  const fundAmount = transferIx.data.readBigUInt64LE(1);
  assert(fundAmount === 800000000000000n, `funding moves exactly 800M tokens (raw ${fundAmount})`);
  assert(transferIx.data[9] === 6, 'funding transfer uses 6 decimals');
  assert(funding.transaction.feePayer.toBase58() === payer, 'funding tx fee payer is the creator');

  const buy = await buildBuyTransaction(payer, built.mintAddress, pool, 0.5);
  const buyIx = buy.transaction.instructions;
  const solIx = buyIx[buyIx.length - 1];
  assert(solIx.programId.equals(solanaWeb3.SystemProgram.programId), 'buy tx ends with a SOL transfer');
  assert(solIx.data.readUInt32LE(0) === 2, 'buy transfer instruction index is 2 (Transfer)');
  const lamports = solIx.data.readBigUInt64LE(4);
  assert(lamports === 500000000n, `buy transfers exactly 0.5 SOL (${lamports} lamports)`);
  assert(buyIx.length === 2, 'buy tx creates the buyer ATA first (2 ix)');
  assert(buy.transaction.feePayer.toBase58() === payer, 'buy tx fee payer is the buyer');

  const sell = await buildSellTransaction(payer, built.mintAddress, pool, 1234567);
  const sellIx = sell.transaction.instructions;
  assert(sellIx.length === 1, 'sell tx is a single transfer');
  assert(sellIx[0].data[0] === 12, 'sell is TransferChecked');
  const sellAmount = sellIx[0].data.readBigUInt64LE(1);
  assert(sellAmount === 1234567000000n, `sell transfers exactly 1,234,567 tokens (raw ${sellAmount})`);
  assert(sell.transaction.feePayer.toBase58() === payer, 'sell tx fee payer is the seller');

  // ---------- 4b. Burn / transfer / pair-buy tx construction ----------
  console.log('burn + transfer + pair-buy transactions:');
  const burn = await buildBurnTransaction(payer, built.mintAddress, 2500000);
  const burnIx = burn.transaction.instructions;
  assert(burnIx.length === 1, 'burn tx is a single instruction');
  assert(burnIx[0].programId.equals(splToken.TOKEN_PROGRAM_ID), 'burn is a Token instruction');
  assert(burnIx[0].data[0] === 15, 'burn is BurnChecked (discriminator 15)');
  const burnAmount = burnIx[0].data.readBigUInt64LE(1);
  assert(burnAmount === 2500000000000n, `burn burns exactly 2,500,000 tokens (raw ${burnAmount})`);
  assert(burnIx[0].data[9] === 6, 'burn uses 6 decimals');
  const userAta = await splToken.getAssociatedTokenAddress(
    new PublicKey(built.mintAddress),
    new PublicKey(payer)
  );
  assert(
    burnIx[0].keys[0].pubkey.equals(userAta),
    'burn source is the user ATA for that mint'
  );
  assert(burn.transaction.feePayer.toBase58() === payer, 'burn tx fee payer is the holder');

  const recipient = Keypair.generate().publicKey.toBase58();
  const transfer = await buildTransferTransaction(payer, built.mintAddress, recipient, 777);
  const transferIxList = transfer.transaction.instructions;
  assert(transferIxList.length === 2, 'transfer tx creates the recipient ATA + transfers (2 ix)');
  assert(
    transferIxList[0].programId.equals(splToken.ASSOCIATED_TOKEN_PROGRAM_ID),
    'transfer ix0 creates the recipient ATA'
  );
  const transferSendIx = transferIxList[1];
  assert(transferSendIx.data[0] === 12, 'transfer is TransferChecked');
  const transferAmount = transferSendIx.data.readBigUInt64LE(1);
  assert(transferAmount === 777000000n, `transfer moves exactly 777 tokens (raw ${transferAmount})`);
  const recipientAta = await splToken.getAssociatedTokenAddress(
    new PublicKey(built.mintAddress),
    new PublicKey(recipient)
  );
  assert(
    transferSendIx.keys[0].pubkey.equals(userAta) &&
      transferSendIx.keys[2].pubkey.equals(recipientAta),
    'transfer goes from the sender ATA to the recipient ATA'
  );
  assert(transfer.transaction.feePayer.toBase58() === payer, 'transfer tx fee payer is the sender');

  const pairMint = Keypair.generate().publicKey.toBase58();
  const pairBuy = await buildPairBuyTransaction(payer, built.mintAddress, pairMint, pool, 100000);
  const pairBuyIx = pairBuy.transaction.instructions;
  // Both ATAs are missing on-chain (fresh mints), so both are created.
  assert(pairBuyIx.length === 3, 'pair buy tx creates both ATAs + transfers (3 ix)');
  assert(
    pairBuyIx[0].programId.equals(splToken.ASSOCIATED_TOKEN_PROGRAM_ID) &&
      pairBuyIx[1].programId.equals(splToken.ASSOCIATED_TOKEN_PROGRAM_ID),
    'pair buy ix0/ix1 create the buyer ATA and the pool pair ATA'
  );
  const pairTransferIx = pairBuyIx[2];
  assert(pairTransferIx.data[0] === 12, 'pair buy transfer is TransferChecked');
  const pairAmount = pairTransferIx.data.readBigUInt64LE(1);
  assert(pairAmount === 100000000000n, `pair buy pays exactly 100,000 pair tokens (raw ${pairAmount})`);
  assert(pairTransferIx.data[9] === 6, 'pair buy transfer uses 6 decimals');
  const userPairAta = await splToken.getAssociatedTokenAddress(
    new PublicKey(pairMint),
    new PublicKey(payer)
  );
  const poolPairAta = await splToken.getAssociatedTokenAddress(
    new PublicKey(pairMint),
    new PublicKey(pool)
  );
  assert(
    pairTransferIx.keys[0].pubkey.equals(userPairAta) &&
      pairTransferIx.keys[2].pubkey.equals(poolPairAta),
    'pair buy pays pair tokens from the buyer pair ATA to the pool pair ATA'
  );
  assert(pairBuy.transaction.feePayer.toBase58() === payer, 'pair buy tx fee payer is the buyer');

  // ---------- 5. friendlyError ----------
  console.log('friendlyError:');
  assert(
    friendlyError(new Error('User rejected the request')) === 'Kamu membatalkan tanda tangan di Phantom.',
    'rejection mapped to Indonesian'
  );
  assert(
    /faucet\.solana\.com/.test(friendlyError(new Error('insufficient lamports'))),
    'insufficient funds points to the faucet'
  );
  assert(
    /kedaluwarsa/.test(friendlyError(new Error('Blockhash not found'))),
    'expired blockhash explained'
  );
  assert(
    friendlyError(new Error('something weird')) === 'something weird',
    'unknown errors pass through unchanged'
  );
  // The errors that usually mean Phantom is on the wrong network (Mainnet
  // instead of Devnet) must point the user at the network fix.
  assert(
    /Devnet/.test(friendlyError(new Error('Failed to simulate the results of this request.'))),
    'simulation failure hints at the Devnet network check'
  );
  assert(
    /Devnet/.test(friendlyError(new Error('insufficient lamports'))),
    'insufficient funds also hints at the Devnet network check'
  );
  assert(
    /Devnet/.test(friendlyError(new Error('Blockhash not found'))),
    'blockhash failure also hints at the Devnet network check'
  );

  console.log('\nALL MINT-FLOW CHECKS PASSED');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
