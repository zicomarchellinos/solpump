'use strict';
// UI smoke test: loads the real frontend in jsdom against a running server,
// walks the feed -> coin detail -> creator profile -> portfolio -> create
// views and asserts the key elements render. Requires the server running
// (default http://localhost:3100). Seeds one test coin + trades + a callout
// directly in the local DB, then removes all test data. Also unit-checks
// the price formatter: plain decimals everywhere, never scientific
// notation. Run with:
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
       (mint_address, wallet, side, sol_amount, token_amount, price, fee_sol,
        user_tx_signature, pool_tx_signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertTrade.run(mint, WALLET_A, 'buy', 1.5, tok1, 1.5 / tok1, 0.015, 'a'.repeat(88), 'A'.repeat(88), now - 30000);
  insertTrade.run(mint, WALLET_A, 'buy', 0.5, tok2, 0.5 / tok2, 0.005, 'b'.repeat(88), 'B'.repeat(88), now - 10000);
  // One callout by the verified buyer (entry = avg buy price of both buys).
  db.prepare(
    `INSERT INTO callouts (mint_address, wallet, text, entry_price, holdings_at_post, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(mint, WALLET_A, 'SMOKE masih awal, gas!', 2.0 / (tok1 + tok2), tok1 + tok2, now - 5000);
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
    assert(document.body.textContent.includes('Market cap'), 'coin card shows market cap');
    assert(document.querySelector('.coin-card .addr-link'), 'coin card links the creator profile');
    // Price formatting: plain decimals, never scientific notation — unit
    // checks against the page's own fmtPrice, plus a sweep over tiny prices.
    assert(window.fmtPrice(4.1e-8) === '0,000000041', `fmtPrice(4.1e-8) = ${window.fmtPrice(4.1e-8)}`);
    assert(window.fmtPrice(3.75e-8) === '0,0000000375', `fmtPrice(3.75e-8) = ${window.fmtPrice(3.75e-8)}`);
    assert(window.fmtPrice(0.000123456) === '0,000123', `fmtPrice(0.000123456) = ${window.fmtPrice(0.000123456)}`);
    assert(window.fmtPrice(1.5) === '1,5', `fmtPrice(1.5) = ${window.fmtPrice(1.5)}`);
    assert(window.fmtPrice(0) === '0', 'fmtPrice(0) = 0');
    for (const p of [1e-9, 9.99e-9, 1.23456789e-8, 5e-7, 9.9999e-5, 0.001, 12.345]) {
      const out = window.fmtPrice(p);
      assert(!/[eE][-+]?\d/.test(out) && !out.includes('×10'), `fmtPrice(${p}) has no scientific notation: ${out}`);
    }
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
    // Market cap appears in the chart header too (next to the price).
    const chartCard = document.querySelector('#chartWrap').closest('.card');
    assert(chartCard.textContent.includes('Market Cap'), 'chart header shows market cap next to the price');
    assert(document.body.textContent.includes('Terverifikasi on-chain'), 'detail shows verified badge');
    assert(document.body.textContent.includes('explorer.solana.com') || document.querySelector('a[href*="explorer.solana.com"]'), 'detail links to Solana Explorer');
    assert(document.querySelector('.trade-box'), 'buy/sell panel renders');
    assert(document.body.textContent.includes('DEVNET ASLI'), 'trade panel labeled DEVNET ASLI');
    assert(document.body.textContent.includes('dompet pool'), 'trade panel discloses the pool wallet');
    assert(document.body.textContent.includes('creator fee'), 'trade panel discloses the 1% creator fee');
    assert(document.querySelector('#feeCard'), 'creator fee card renders');
    assert(document.body.textContent.includes('Fee Kreator'), 'fee card shows creator fee totals');
    await waitFor(
      () => document.querySelectorAll('#tradesTable tbody tr').length === 2,
      15000,
      '2 trade rows in the table'
    );
    assert(
      document.body.textContent.includes('Riwayat Transaksi'),
      'detail shows transaction history'
    );
    assert(
      document.querySelector('#tradesTable').textContent.includes('Fee Kreator'),
      'trade table has a fee column'
    );
    // Chart range buttons and trade filter tabs exist.
    assert(document.querySelector('[data-range="10"]'), 'chart range filter renders');
    assert(document.querySelector('[data-tab="Punyaku"]'), 'trade filter tabs render');
    // Trade table shows both real transaction signatures with Explorer links.
    assert(
      document.querySelectorAll('#tradesTable a[href*="explorer.solana.com/tx/"]').length >= 4,
      'trade table links user + pool tx signatures to Explorer'
    );
    // Callouts: the seeded callout renders with its verified-buyer marker.
    assert(document.querySelector('#calloutsCard'), 'callouts section renders');
    assert(
      document.body.textContent.includes('Pembeli terverifikasi'),
      'callout shows the verified-buyer marker'
    );
    assert(
      document.body.textContent.includes('SMOKE masih awal, gas!'),
      'callout text renders'
    );
    // No scientific notation anywhere on the rendered detail page.
    const bodyText = document.body.textContent;
    assert(!bodyText.includes('×10'), 'detail page has no ×10^ scientific notation');
    assert(!/\de[-+]\d/.test(bodyText), 'detail page has no e-notation prices');

    // Portfolio (no wallet connected): connect prompt renders.
    window.location.hash = '#/portfolio';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitFor(
      () => document.body.textContent.includes('Hubungkan dompet dulu'),
      15000,
      'portfolio connect prompt'
    );
    assert(true, 'portfolio shows connect prompt without a wallet');

    // Creator profile: coins, fees, followers, callouts.
    window.location.hash = `#/creator/${WALLET_A}`;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitFor(
      () => document.body.textContent.includes('Coin yang Dibuat'),
      15000,
      'creator profile'
    );
    assert(document.body.textContent.includes('Smoke Cat'), 'creator profile lists their coin');
    assert(document.body.textContent.includes('Pengikut'), 'creator profile shows followers');
    assert(document.body.textContent.includes('Mengikuti'), 'creator profile shows following');
    assert(document.body.textContent.includes('Fee Kreator'), 'creator profile shows fee totals');
    assert(
      document.body.textContent.includes('SMOKE masih awal, gas!'),
      'creator profile lists their callout'
    );

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
    assert(document.querySelector('#devnetConfirm'), 'create form has the Devnet confirmation checkbox');
    assert(
      document.body.textContent.includes('Phantom harus di jaringan Devnet'),
      'create form reminds that Phantom must be on Devnet'
    );

    console.log('\nALL UI SMOKE CHECKS PASSED');
  } finally {
    if (dom) dom.window.close();
    db.prepare('DELETE FROM trades WHERE mint_address = ?').run(mint);
    db.prepare('DELETE FROM callouts WHERE mint_address = ?').run(mint);
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
