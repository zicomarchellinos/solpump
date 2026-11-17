'use strict';
// UI smoke test: loads the real frontend in jsdom against a running server,
// walks the feed -> coin detail -> portfolio -> create views and asserts the
// key elements render. Requires the server running
// (default http://localhost:3100). Seeds one test coin + trades directly in
// the local DB, then removes all test data. Run with:
//   node test/ui-smoke.js [baseUrl]

const path = require('path');
const Database = require('better-sqlite3');
const { Keypair } = require('@solana/web3.js');
const { JSDOM } = require('jsdom');

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:3100';
const WALLET_A = 'HyevJPsT3Yf5MTWMph4LaArUqtKS27ScfHF5Cqim6eek';

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok - ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 15000, label = 'condition') {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
    await sleep(200);
  }
}

async function main() {
  const db = new Database(path.join(__dirname, '..', 'data', 'solpump.db'));
  const mint = Keypair.generate().publicKey.toBase58();
  const now = Date.now();
  // Coin with reserves moved by two recorded trades (buy 1.5 SOL, buy 0.5 SOL).
  // trading_enabled=1 so the real trade panel renders.
  const tok1 = (800000000 * 1.5) / 31.5;
  const tok2 = ((800000000 - tok1) * 0.5) / 32;
  db.prepare(
    `INSERT INTO coins
       (mint_address, name, ticker, description, logo_url, creator_wallet, tx_signature,
        sol_reserve, token_reserve, trading_enabled, funding_tx_signature, created_at)
     VALUES (?, 'Smoke Cat', 'SMOKE', 'UI smoke test coin', NULL, ?, ?, 32, ?, 1, ?, ?)`
  ).run(mint, WALLET_A, 'z'.repeat(88), 800000000 - tok1 - tok2, 'f'.repeat(88), now - 60000);
  const insertTrade = db.prepare(
    `INSERT INTO trades
       (mint_address, wallet, side, sol_amount, token_amount, price,
        user_tx_signature, pool_tx_signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertTrade.run(mint, WALLET_A, 'buy', 1.5, tok1, 1.5 / tok1, 'a'.repeat(88), 'A'.repeat(88), now - 30000);
  insertTrade.run(mint, WALLET_A, 'buy', 0.5, tok2, 0.5 / tok2, 'b'.repeat(88), 'B'.repeat(88), now - 10000);
  console.log('seeded smoke coin', mint);

  let dom;
  try {
    dom = await JSDOM.fromURL(`${BASE}/`, {
      resources: 'usable',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      // jsdom has no window.fetch; give the page Node's fetch so the app
      // can call the API on the running server. Node's fetch needs
      // absolute URLs, so resolve the app's relative API paths against
      // the page URL first.
      beforeParse(window) {
        const nodeFetch = fetch;
        window.fetch = (input, init) => {
          const url =
            typeof input === 'string' && input.startsWith('/')
              ? new URL(input, window.location.href).toString()
              : input;
          return nodeFetch(url, init);
        };
      },
    });
    const { window } = dom;
    const { document } = window;
    window.addEventListener('error', (e) => {
      throw new Error(`page error: ${e.message}`);
    });

    // Feed: coin card renders with the seeded coin.
    await waitFor(
      () => document.querySelector('.coin-card'),
      15000,
      'coin card in feed'
    );
    assert(
      document.body.textContent.includes('Smoke Cat'),
      'feed shows the seeded coin'
    );
    assert(document.querySelector('#searchInput'), 'feed search input renders');
    assert(document.querySelector('#sortSelect'), 'feed sort select renders');
    // Footer shows the pool wallet address (loaded from /api/pool).
    const poolAddr = await waitFor(() => {
      const el = document.querySelector('#poolAddress a');
      return el ? el.textContent : null;
    }, 15000, 'pool address in footer');
    assert(poolAddr.includes('…'), `footer shows pool address (${poolAddr.trim()})`);
    assert(document.body.textContent.includes('dompet pool kustodian'), 'footer discloses the custodial pool wallet');

    // Coin detail: chart, stats, trade panel, PnL prompt, trades table.
    window.location.hash = `#/coin/${mint}`;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitFor(() => document.querySelector('#chartSvg'), 15000, 'price chart SVG');
    assert(document.body.textContent.includes('Grafik Harga'), 'detail shows price chart heading');
    assert(document.body.textContent.includes('Market Cap'), 'detail shows market cap stat');
    assert(document.body.textContent.includes('Terverifikasi on-chain'), 'detail shows verified badge');
    assert(document.body.textContent.includes('explorer.solana.com') || document.querySelector('a[href*="explorer.solana.com"]'), 'detail links to Solana Explorer');
    assert(document.querySelector('.trade-box'), 'buy/sell panel renders');
    assert(document.body.textContent.includes('DEVNET ASLI'), 'trade panel labeled DEVNET ASLI');
    assert(document.body.textContent.includes('dompet pool'), 'trade panel discloses the pool wallet');
    await waitFor(
      () => document.querySelectorAll('#tradesTable tbody tr').length === 2,
      15000,
      '2 trade rows in the table'
    );
    assert(
      document.body.textContent.includes('Riwayat Transaksi'),
      'detail shows transaction history'
    );
    // Chart range buttons and trade filter tabs exist.
    assert(document.querySelector('[data-range="10"]'), 'chart range filter renders');
    assert(document.querySelector('[data-tab="Punyaku"]'), 'trade filter tabs render');
    // Trade table shows both real transaction signatures with Explorer links.
    assert(
      document.querySelectorAll('#tradesTable a[href*="explorer.solana.com/tx/"]').length >= 4,
      'trade table links user + pool tx signatures to Explorer'
    );

    // Portfolio (no wallet connected): connect prompt renders.
    window.location.hash = '#/portfolio';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitFor(
      () => document.body.textContent.includes('Hubungkan dompet dulu'),
      15000,
      'portfolio connect prompt'
    );
    assert(true, 'portfolio shows connect prompt without a wallet');

    // Create view: form renders with Phantom guidance (no extension here).
    window.location.hash = '#/create';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitFor(() => document.querySelector('#coinName'), 15000, 'create form');
    assert(document.querySelector('#coinTicker'), 'create form has ticker input');
    assert(document.querySelector('#mintBtn'), 'create form has mint button');
    assert(
      document.body.textContent.includes('Phantom tidak terdeteksi'),
      'create view shows Phantom guidance without the extension'
    );

    console.log('\nALL UI SMOKE CHECKS PASSED');
  } finally {
    if (dom) dom.window.close();
    db.prepare('DELETE FROM trades WHERE mint_address = ?').run(mint);
    db.prepare('DELETE FROM coins WHERE mint_address = ?').run(mint);
    const left = db.prepare('SELECT COUNT(*) AS n FROM coins').get().n;
    console.log(`test data cleaned; coins remaining in DB: ${left}`);
    db.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
