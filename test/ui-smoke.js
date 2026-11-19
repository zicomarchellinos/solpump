'use strict';
// UI smoke test: loads the real frontend in jsdom against a running server,
// walks the feed -> coin detail -> creator profile -> portfolio -> create
// views and asserts the key elements render. Requires the server running
// (default http://localhost:3100) with SOL_USD_PRICE=100 and ADMIN_WALLETS
// including the deterministic test admin (see test/e2e.js header). Seeds
// one test coin + trades + a callout directly in the local DB, plus a
// graduated coin (verified creator), an 18+ Meme coin, a coin paired with
// the smoke coin, a deep-chain coin, a reward fund, a transfer (receipt),
// and a contact — then removes all test data. Also unit-checks the price
// formatters: plain decimals everywhere, never scientific notation — SOL
// prices, USD prices ($0.000005), USD money ($12.35) and the $K/$M/$B
// market-cap suffixes. Run with:
//   node test/ui-smoke.js [baseUrl]

const path = require('path');
const { webcrypto } = require('crypto');
const Database = require('better-sqlite3');
const { Keypair } = require('@solana/web3.js');
const { JSDOM } = require('jsdom');
const { profileMessage: serverProfileMessage, sha256Hex: serverSha256Hex } = require('../src/signverify');

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:3100';
const WALLET_A = 'HyevJPsT3Yf5MTWMph4LaArUqtKS27ScfHF5Cqim6eek';
// Deterministic test admin wallet (seed 'solpump-test-admin-v1' — the
// same keypair test/e2e.js signs admin requests with). The test server
// must run with ADMIN_WALLETS including this address.
const TEST_ADMIN_ADDRESS = 'Hnp1qA4W7sgNsBPuHQRyeG5Gff6CAAguH3rQXJRYJGU';

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
  // Coin with reserves moved by two recorded trades (buy 1.5 SOL, buy 0.5 SOL)
  // from the 55 SOL launch reserve. trading_enabled=1 so the real trade
  // panel renders.
  const tok1 = (800000000 * 1.5) / 56.5;
  const tok2 = ((800000000 - tok1) * 0.5) / 57;
  const finalTok = 800000000 - tok1 - tok2;
  const smokePrice = 57 / finalTok;
  db.prepare(
    `INSERT INTO coins
       (mint_address, name, ticker, description, logo_url, creator_wallet, tx_signature,
        sol_reserve, token_reserve, trading_enabled, funding_tx_signature, created_at)
     VALUES (?, 'Smoke Cat', 'SMOKE', 'UI smoke test coin', NULL, ?, ?, 57, ?, 1, ?, ?)`
  ).run(mint, WALLET_A, 'z'.repeat(88), finalTok, 'f'.repeat(88), now - 60000);
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
  // Editable profile for the creator: username + gold border + photo +
  // cover (the image files need not exist — the test asserts the rendered
  // img src attributes, not that the images load).
  db.prepare(
    `INSERT INTO profiles (wallet, username, avatar_url, border, cover_url, updated_at)
     VALUES (?, 'smokecat', '/uploads/smoke-avatar.png', 'gold', '/uploads/smoke-cover.png', ?)`
  ).run(WALLET_A, now);
  // Extra coins for the 14-job push, all created BEFORE the smoke coin
  // (now - 120000) so SMOKE stays the newest card in the feed and keeps
  // its place in the trending strip. All by WALLET_A (the creator
  // profile assertions are contains-checks, not counts).
  const mintAdult = Keypair.generate().publicKey.toBase58();
  const mintPair = Keypair.generate().publicKey.toBase58();
  const mintDeep = Keypair.generate().publicKey.toBase58();
  const mintGrad = Keypair.generate().publicKey.toBase58();
  const insertExtraCoin = db.prepare(
    `INSERT INTO coins
       (mint_address, name, ticker, description, logo_url, creator_wallet, tx_signature,
        sol_reserve, token_reserve, trading_enabled, funding_tx_signature, pair_mint, category, is_adult, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
  );
  // 18+ Meme coin, fresh curve (market cap below SMOKE's).
  insertExtraCoin.run(
    mintAdult, 'Adult Owl', 'AOWL', '18+ Meme test coin', WALLET_A,
    'g'.repeat(88), 55, 800000000, 'h'.repeat(88), null, 'Meme', 1, now - 120000
  );
  // Coin paired with SMOKE (routed SOL buys) + a deep-chain coin paired
  // with it (SOL option disabled).
  insertExtraCoin.run(
    mintPair, 'Pair Dog', 'PDOG', 'Coin paired with SMOKE', WALLET_A,
    'i'.repeat(88), 55, 800000000, 'j'.repeat(88), mint, 'Lainnya', 0, now - 120000
  );
  insertExtraCoin.run(
    mintDeep, 'Deep Chain Cat', 'DCCAT', 'Coin paired with PDOG', WALLET_A,
    'k'.repeat(88), 55, 800000000, 'l'.repeat(88), mintPair, 'Lainnya', 0, now - 120000
  );
  // Graduated coin (140 SOL raised) — makes WALLET_A a verified creator.
  insertExtraCoin.run(
    mintGrad, 'Graduated Goat', 'GGOAT', 'Graduated test coin', WALLET_A,
    'm'.repeat(88), 140, (800000000 * 55) / 140, 'n'.repeat(88), null, 'Lainnya', 0, now - 120000
  );
  // A second callout on SMOKE at +50% live PnL (entry = current price
  // / 1.5) so all three reward tiers are eligible.
  db.prepare(
    `INSERT INTO callouts (mint_address, wallet, text, entry_price, holdings_at_post, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(mint, WALLET_A, 'SMOKE sudah naik 50%, klaim reward!', smokePrice / 1.5, tok1 + tok2, now - 4000);
  // A reward fund on SMOKE (0.5 SOL) for the reward card.
  db.prepare(
    `INSERT INTO reward_funds (mint_address, funder_wallet, amount_sol, tx_signature, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(mint, WALLET_A, 0.5, 'p'.repeat(88), now - 3000);
  // A transfer on SMOKE (1M tokens, $12.50 snapshot) for the receipt page
  // + the portfolio receipt link.
  const transferId = db
    .prepare(
      `INSERT INTO transfers (mint_address, from_wallet, to_wallet, amount, tx_signature, usd_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(mint, WALLET_A, 'J6uK6XxHL2T2bg8CefLKYTSCwpMeBmTG7Pa9K8NYWSvb', 1000000, 's'.repeat(88), 12.5, now - 2000)
    .lastInsertRowid;
  // A contact for the transfer-form picker + portfolio contacts section.
  db.prepare(
    `INSERT INTO contacts (owner_wallet, name, contact_wallet, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(WALLET_A, 'Budi', 'J6uK6XxHL2T2bg8CefLKYTSCwpMeBmTG7Pa9K8NYWSvb', now - 1000, now - 1000);
  console.log('seeded smoke coin', mint);

  let dom;
  let dom2;
  let dom3;
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
        // jsdom exposes no SubtleCrypto: inject Node's WebCrypto so the
        // page's sha256Hex runs against a real implementation (which, like
        // browsers, only recognizes the standard 'SHA-256' name).
        Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      },
    });
    const { window } = dom;
    const { document } = window;
    window.addEventListener('error', (e) => {
      throw new Error(`page error: ${e.message}`);
    });

    // Pump.fun-style app shell: sidebar with brand + nav, top header.
    assert(document.querySelector('.sidebar'), 'sidebar renders');
    assert(document.querySelector('.sidebar .brand').textContent.includes('solpump'), 'sidebar shows the solpump brand');
    assert(document.querySelectorAll('.nav a').length === 3, 'sidebar nav has Beranda / Buat Coin / Portofolio');
    assert(document.querySelector('.topbar'), 'top header renders');
    assert(document.body.textContent.includes('DEVNET'), 'DEVNET pill is visible');

    // Feed: coin card renders with the seeded coin.
    await waitFor(
      () => document.querySelector('.coin-card'),
      15000,
      'coin card in feed'
    );
    // Trending strip (pump.fun style): the seeded coin appears as a chip.
    await waitFor(
      () => document.querySelector('.trend-chip'),
      15000,
      'trending strip chip'
    );
    assert(
      document.querySelector('.trend-strip').textContent.includes('SMOKE'),
      'trending strip shows the seeded coin'
    );
    assert(
      document.querySelector('.trend-chip .hot'),
      'top trending chip carries a HOT badge'
    );
    // Expected USD strings for the smoke coin, from the live SOL/USD rate
    // (the test server is started with SOL_USD_PRICE=100; if a server ever
    // has no price, the UI falls back to SOL and the fallback branch below
    // is checked instead). Computed here — after the wait above — because
    // the page's scripts may not have run yet when fromURL resolves.
    const solPriceRes = await fetch(`${BASE}/api/sol-price`).then((r) => r.json());
    const solUsd = solPriceRes.solUsd;
    const expPrice = Number.isFinite(solUsd) ? window.fmtPriceUsd(smokePrice * solUsd) : null;
    const expMc = Number.isFinite(solUsd)
      ? window.fmtMarketCapUsd(smokePrice * 1000000000 * solUsd)
      : null;
    assert(
      document.body.textContent.includes('Smoke Cat'),
      'feed shows the seeded coin'
    );
    assert(document.querySelector('#searchInput'), 'feed search input renders');
    assert(document.querySelector('.launchpad-heading h1'), 'feed renders the launchpad heading');
    assert(document.querySelectorAll('[data-sort]').length === 5, 'feed sort pills render (Baru / Market Cap / Volume / Harga / Perubahan)');
    assert(document.querySelector('[data-sort="newest"].active'), 'newest sort pill is active by default');
    assert(document.body.textContent.includes('Market cap'), 'coin card shows market cap');
    assert(document.querySelector('.coin-card .addr-link'), 'coin card links the creator profile');
    assert(document.querySelector('.coin-card .progress'), 'coin card shows the bonding-curve progress bar');
    assert(document.querySelector('.coin-card .coin-desc'), 'coin card shows the description');
    const cardText = document.querySelector('.coin-card').textContent;
    assert(cardText.includes('SMOKE/SOL'), 'coin card shows the TICKER/SOL pair label');
    assert(
      cardText.includes('smokecat'),
      'coin card shows the creator username instead of the bare address'
    );
    assert(cardText.includes('mnt lalu'), 'coin card shows the time since creation');
    if (expPrice) {
      assert(cardText.includes(expPrice), `coin card shows the USD price (${expPrice})`);
      assert(cardText.includes(expMc), `coin card shows the USD market cap (${expMc})`);
    } else {
      assert(cardText.includes('SOL'), 'coin card falls back to SOL without a price');
    }
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
    // USD price formatter: plain decimals, $ prefix, never scientific.
    assert(window.fmtPriceUsd(5e-6) === '$0.000005', `fmtPriceUsd(5e-6) = ${window.fmtPriceUsd(5e-6)}`);
    assert(window.fmtPriceUsd(2.987e-6) === '$0.000002987', `fmtPriceUsd(2.987e-6) = ${window.fmtPriceUsd(2.987e-6)}`);
    assert(window.fmtPriceUsd(0.5) === '$0.5', `fmtPriceUsd(0.5) = ${window.fmtPriceUsd(0.5)}`);
    assert(window.fmtPriceUsd(0) === '$0', 'fmtPriceUsd(0) = $0');
    for (const p of [1e-9, 9.99e-9, 1.23456789e-8, 5e-7, 9.9999e-5, 0.001, 12.345]) {
      const out = window.fmtPriceUsd(p);
      assert(!/[eE][-+]?\d/.test(out) && !out.includes('×10'), `fmtPriceUsd(${p}) has no scientific notation: ${out}`);
    }
    // USD money formatter (PnL, values): 2 decimals from $1 up.
    assert(window.fmtUsd(12.345) === '$12.35', `fmtUsd(12.345) = ${window.fmtUsd(12.345)}`);
    assert(window.fmtUsd(0.0004) === '$0.0004', `fmtUsd(0.0004) = ${window.fmtUsd(0.0004)}`);
    assert(window.fmtUsd(-5) === '−$5.00', `fmtUsd(-5) = ${window.fmtUsd(-5)}`);
    assert(window.fmtSignedUsd(2.5) === '+$2.50', `fmtSignedUsd(2.5) = ${window.fmtSignedUsd(2.5)}`);
    assert(window.fmtSignedUsd(-0.0004) === '−$0.0004', `fmtSignedUsd(-0.0004) = ${window.fmtSignedUsd(-0.0004)}`);
    // Market-cap suffix formatter (frontend copy mirrors the server).
    const mcCases = [
      [4999, '$5K'],
      [5200, '$5.2K'],
      [500000, '$500K'],
      [5000000, '$5M'],
      [12400000, '$12.4M'],
      [50000000, '$50M'],
      [500000000, '$500M'],
      [5000000000, '$5B'],
      [999999, '$1M'],
    ];
    for (const [value, expected] of mcCases) {
      assert(window.fmtMarketCapUsd(value) === expected, `fmtMarketCapUsd(${value}) = ${expected}`);
    }
    // Profile-save signing path: the page's sha256Hex must call
    // crypto.subtle.digest with the WebCrypto-standard name 'SHA-256' —
    // the bare 'sha256' throws "Unrecognized name" in browsers, which is
    // exactly the error users hit when saving their profile. Its output
    // and the canonical profile message must also match the server's, or
    // the server's signature verification would reject every save.
    assert(
      (await window.sha256Hex('abc')) ===
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      'client sha256Hex(abc) matches the known SHA-256 digest'
    );
    const samplePayload = Buffer.from('smoke-image-bytes').toString('base64');
    assert(
      (await window.sha256Hex(samplePayload)) === serverSha256Hex(samplePayload),
      'client sha256Hex matches the server hash for a base64 image payload'
    );
    const profileFields = {
      wallet: WALLET_A,
      username: 'smokecat',
      border: 'gold',
      avatarHash: 'aa11',
      coverHash: 'bb22',
    };
    assert(
      window.profileMessage(profileFields) === serverProfileMessage(profileFields),
      'client profileMessage matches the server canonical message'
    );
    // Footer shows the pool wallet address (loaded from /api/pool).
    const poolAddr = await waitFor(() => {
      const el = document.querySelector('#poolAddress a');
      return el ? el.textContent : null;
    }, 15000, 'pool address in footer');
    assert(poolAddr.includes('…'), `footer shows pool address (${poolAddr.trim()})`);
    assert(document.body.textContent.includes('dompet pool kustodian'), 'footer discloses the custodial pool wallet');

    // Language switcher: default is Indonesian; switching changes the
    // visible strings in all three languages and persists in localStorage.
    const navLabels = () =>
      [...document.querySelectorAll('.nav a .nav-label')].map((el) => el.textContent.trim());
    assert(
      JSON.stringify(navLabels()) === JSON.stringify(['Beranda', 'Buat Coin', 'Portofolio Saya']),
      `default language is Indonesian (nav: ${navLabels().join(' / ')})`
    );
    assert(document.querySelector('#langBox'), 'language switcher renders in the topbar');
    assert(
      document.querySelectorAll('#langBox .lang-btn').length === 3,
      'language switcher has ID / EN / 中文 buttons'
    );
    assert(
      document.querySelector('#langBox .lang-btn.active').dataset.lang === 'id',
      'ID is the active language by default'
    );
    document.querySelector('#langBox .lang-btn[data-lang="en"]').click();
    await waitFor(
      () => navLabels()[0] === 'Home',
      15000,
      'nav labels switch to English'
    );
    assert(
      JSON.stringify(navLabels()) === JSON.stringify(['Home', 'Create Coin', 'My Portfolio']),
      `English nav labels render (${navLabels().join(' / ')})`
    );
    assert(
      window.localStorage.getItem('solpump-lang') === 'en',
      'language choice persists in localStorage (en)'
    );
    assert(
      document.querySelector('#langBox .lang-btn.active').dataset.lang === 'en',
      'EN is the active language after switching'
    );
    document.querySelector('#langBox .lang-btn[data-lang="zh"]').click();
    await waitFor(
      () => navLabels()[0] === '首页',
      15000,
      'nav labels switch to Chinese'
    );
    assert(
      JSON.stringify(navLabels()) === JSON.stringify(['首页', '创建代币', '我的投资组合']),
      `Chinese nav labels render (${navLabels().join(' / ')})`
    );
    assert(
      window.localStorage.getItem('solpump-lang') === 'zh',
      'language choice persists in localStorage (zh)'
    );
    // Back to Indonesian for the rest of the test (which asserts
    // Indonesian strings), and wait for the feed to re-render.
    document.querySelector('#langBox .lang-btn[data-lang="id"]').click();
    await waitFor(
      () => navLabels()[0] === 'Beranda' && document.querySelector('.coin-card'),
      15000,
      'nav labels switch back to Indonesian + feed re-renders'
    );
    assert(
      window.localStorage.getItem('solpump-lang') === 'id',
      'language choice persists in localStorage (id)'
    );

    // Categories: filter pills (Semua + 9) + the category badge on cards.
    assert(
      document.querySelectorAll('[data-category]').length === 10,
      'category filter has Semua + 9 category pills'
    );
    assert(
      document.querySelector('[data-category="Meme"]'),
      'Meme category pill renders'
    );
    assert(
      document.querySelector('.coin-card .badge-category'),
      'coin card shows the category badge'
    );
    assert(
      document.querySelector('.coin-card .badge-category').textContent.includes('Lainnya'),
      'the SMOKE card shows the Lainnya category badge'
    );
    // The Meme filter shows only the Meme coin; Semua restores the feed.
    document.querySelector('[data-category="Meme"]').click();
    await waitFor(
      () =>
        document.querySelectorAll('.coin-card').length === 1 &&
        document.querySelector('.coin-card').textContent.includes('AOWL'),
      15000,
      'Meme filter shows only the Meme coin'
    );
    assert(true, 'category filter narrows the feed to the Meme coin');
    document.querySelector('[data-category=""]').click();
    await waitFor(
      () => document.querySelectorAll('.coin-card').length === 5,
      15000,
      'Semua restores all 5 coins'
    );
    assert(true, 'Semua filter restores the full feed');

    // 18+: the adult coin's card is blurred with a veil button; the age
    // confirmation modal unblurs it (one-time, persisted).
    const adultCard = [...document.querySelectorAll('.coin-card')].find((c) =>
      c.textContent.includes('AOWL')
    );
    assert(adultCard, 'the 18+ coin card renders in the feed');
    assert(
      adultCard.classList.contains('adult-blurred'),
      'the 18+ coin card is blurred before confirmation'
    );
    assert(
      adultCard.querySelector('.badge-adult'),
      'the 18+ coin card shows the 18+ badge'
    );
    assert(adultCard.querySelector('.adult-veil'), 'the 18+ card has a click-to-reveal veil');
    adultCard.querySelector('.adult-veil button, .adult-veil').click();
    await waitFor(() => document.querySelector('.modal-overlay'), 15000, 'age confirmation modal');
    assert(
      document.querySelector('.modal-overlay').textContent.includes('18+'),
      'age confirmation modal asks about 18+ content'
    );
    const confirmBtn = [...document.querySelectorAll('.modal-overlay button')].find((b) =>
      b.textContent.includes('Saya 18+')
    );
    assert(confirmBtn, 'age confirmation modal has a confirm button');
    confirmBtn.click();
    await waitFor(
      () => !document.querySelector('.coin-card.adult-blurred'),
      15000,
      'the 18+ card unblurs after confirmation'
    );
    assert(
      window.localStorage.getItem('solpump-age-confirmed') === 'yes',
      'age confirmation persists in localStorage'
    );
    // The 18+ toggle hides adult coins; clicking again shows them.
    document.querySelector('#adultToggle').click();
    await waitFor(
      () => ![...document.querySelectorAll('.coin-card')].some((c) => c.textContent.includes('AOWL')),
      15000,
      'the 18+ toggle hides the adult coin'
    );
    assert(true, 'the 18+ toggle hides adult coins');
    document.querySelector('#adultToggle').click();
    await waitFor(
      () => [...document.querySelectorAll('.coin-card')].some((c) => c.textContent.includes('AOWL')),
      15000,
      'the 18+ toggle shows the adult coin again'
    );
    assert(true, 'the 18+ toggle shows adult coins again');

    // Verified creator (WALLET_A graduated a coin): the checkmark shows
    // on the SMOKE card next to the creator name, with community badges.
    assert(
      document.querySelector('.coin-card .verified-badge'),
      'the coin card shows the verified checkmark for the creator'
    );
    assert(
      document.querySelector('.coin-card .badges'),
      'the coin card shows community badges next to the creator'
    );
    // No admin link without a wallet (and no admin wallet connected).
    assert(
      !document.querySelector('[data-nav="admin"]'),
      'no Admin nav link without a connected wallet'
    );

    // Collapsible sidebar: the toggle renders, collapses to the rail,
    // re-expands, and persists the state in localStorage.
    const appShell = document.getElementById('appShell');
    assert(document.querySelector('#sidebarToggle'), 'sidebar toggle button renders');
    assert(!appShell.classList.contains('sidebar-collapsed'), 'sidebar starts expanded');
    document.querySelector('#sidebarToggle').click();
    assert(
      appShell.classList.contains('sidebar-collapsed'),
      'clicking the toggle collapses the sidebar'
    );
    assert(
      window.localStorage.getItem('solpump-sidebar-collapsed') === '1',
      'collapsed state persists in localStorage'
    );
    document.querySelector('#sidebarToggle').click();
    assert(
      !appShell.classList.contains('sidebar-collapsed'),
      'clicking the toggle again re-expands the sidebar'
    );
    assert(
      window.localStorage.getItem('solpump-sidebar-collapsed') === '0',
      'expanded state persists in localStorage'
    );

    // Coin detail: chart, stats, trade panel, PnL prompt, trades table.
    window.location.hash = `#/coin/${mint}`;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitFor(() => document.querySelector('#chartSvg'), 15000, 'price chart SVG');
    assert(document.body.textContent.includes('Grafik Harga'), 'detail shows price chart heading');
    assert(document.body.textContent.includes('Market Cap'), 'detail shows market cap stat');
    assert(document.body.textContent.includes('SMOKE/SOL'), 'detail shows the TICKER/SOL pair label');
    assert(document.querySelector('.terminal-market-strip'), 'detail shows the compact trader market-data strip');
    assert(
      document.querySelectorAll('.terminal-market-strip .terminal-market-stat').length === 5,
      'market strip summarizes price, market cap, volume, traders and transactions'
    );
    // Price and market cap are prominent in the terminal market-data strip.
    const chartCard = document.querySelector('#chartWrap').closest('.card');
    const marketStrip = document.querySelector('.terminal-market-strip');
    assert(marketStrip.textContent.includes('Market Cap'), 'market strip shows market cap next to the price');
    if (expPrice) {
      assert(marketStrip.textContent.includes(expPrice), `market strip shows the USD price (${expPrice})`);
      assert(marketStrip.textContent.includes(expMc), `market strip shows the USD market cap (${expMc})`);
      // High/low stats and the trade table price column are USD too.
      const expHigh = window.fmtPriceUsd((0.5 / tok2) * solUsd);
      const expLow = window.fmtPriceUsd((55 / 800000000) * solUsd);
      assert(document.body.textContent.includes(expHigh), `detail shows the USD high (${expHigh})`);
      assert(document.body.textContent.includes(expLow), `detail shows the USD low (${expLow})`);
      const expTradePrice = window.fmtPriceUsd((1.5 / tok1) * solUsd);
      assert(
        document.querySelector('#tradesTable').textContent.includes(expTradePrice),
        `trade table shows the USD price (${expTradePrice})`
      );
      // Callout entry price is USD.
      const expEntry = window.fmtPriceUsd((2.0 / (tok1 + tok2)) * solUsd);
      assert(
        document.querySelector('#calloutsCard').textContent.includes(expEntry),
        `callout shows the USD entry price (${expEntry})`
      );
    }
    assert(document.body.textContent.includes('Terverifikasi on-chain'), 'detail shows verified badge');
    assert(document.body.textContent.includes('explorer.solana.com') || document.querySelector('a[href*="explorer.solana.com"]'), 'detail links to Solana Explorer');
    // Two-column detail layout (pump.fun style): chart left, trade sidebar right.
    assert(document.querySelector('.detail-layout'), 'detail uses the two-column layout');
    assert(document.querySelector('.terminal-layout'), 'coin detail uses the trading terminal layout');
    assert(document.querySelector('.detail-side'), 'detail has a sticky trade sidebar');
    assert(
      document.querySelector('.detail-side .trade-box'),
      'buy/sell panel lives in the detail sidebar'
    );
    assert(
      document.querySelector('.detail-side #feeCard'),
      'creator fee card lives in the detail sidebar'
    );
    assert(document.querySelector('.trade-box'), 'buy/sell panel renders');
    assert(document.querySelector('.terminal-order-panel'), 'buy/sell panel uses the terminal order panel');
    assert(
      document.querySelector('.terminal-activity-card') &&
        document.querySelector('.terminal-activity-card #tradesTable'),
      'recent trades are grouped directly below the chart'
    );
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
      document.querySelector('#calloutsCard img.profile-avatar-img, #calloutsCard .coin-avatar'),
      'callout shows the trader avatar'
    );
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

    // Burn section: card with totals + history (empty) + connect prompt
    // (no wallet here); circulating supply shows 1B with zero burns.
    assert(document.querySelector('#burnCard'), 'burn section renders on the coin detail');
    assert(
      document.querySelector('#burnCard').textContent.includes('Total Burn'),
      'burn card shows the total burned stat'
    );
    assert(
      document.querySelector('#burnCard').textContent.includes('1.000.000.000'),
      'burn card shows the 1B circulating supply with zero burns'
    );
    assert(document.querySelector('#burnHistory'), 'burn history container renders');
    assert(
      document.querySelector('#burnHistory').textContent.includes('Belum ada burn'),
      'burn history shows the empty state'
    );
    assert(
      document.querySelector('#burnForm').textContent.includes('Hubungkan dompet'),
      'burn form asks to connect a wallet first'
    );
    // Transfer card (coin detail): connect prompt without a wallet.
    assert(document.querySelector('#transferCard'), 'transfer section renders on the coin detail');
    assert(
      document.querySelector('#transferCard').textContent.includes('Hubungkan dompet'),
      'transfer form asks to connect a wallet first'
    );
    // Creator-only panels are hidden without a wallet: no dev burn card,
    // no buyback section (the fee card shows the non-creator note).
    assert(
      !document.querySelector('#devBurnCard'),
      'dev burn panel does not render without a wallet'
    );
    assert(
      !document.querySelector('#buybackBox'),
      'buyback section does not render without a wallet'
    );
    // Candlestick chart: Area/Candles toggle + timeframe pills; switching
    // to candles renders real candles from the seeded trades.
    assert(document.querySelector('[data-chart-type="area"]'), 'area chart toggle renders');
    assert(document.querySelector('[data-chart-type="candles"]'), 'candles chart toggle renders');
    assert(
      document.querySelector('[data-chart-type="area"].active'),
      'area chart is active by default'
    );
    document.querySelector('[data-chart-type="candles"]').click();
    await waitFor(
      () => document.querySelector('#chartSvg g[data-candle]'),
      15000,
      'candlesticks render'
    );
    assert(
      document.querySelectorAll('#chartSvg g[data-candle]').length >= 1,
      'candlestick chart shows at least one candle from the seeded trades'
    );
    assert(
      document.querySelector('[data-timeframe="1m"]') &&
        document.querySelector('[data-timeframe="5m"]') &&
        document.querySelector('[data-timeframe="15m"]') &&
        document.querySelector('[data-timeframe="1h"]'),
      'timeframe pills render (1m / 5m / 15m / 1h)'
    );
    assert(
      document.querySelector('[data-timeframe="5m"].active'),
      '5m is the default candle timeframe'
    );
    document.querySelector('[data-timeframe="1m"]').click();
    await waitFor(
      () => document.querySelector('[data-timeframe="1m"].active'),
      15000,
      '1m timeframe activates'
    );
    await waitFor(
      () => document.querySelector('#chartSvg g[data-candle]'),
      15000,
      'candlesticks re-render at 1m'
    );
    assert(true, 'candlesticks re-render after switching timeframe');
    // Back to the area chart.
    document.querySelector('[data-chart-type="area"]').click();
    await waitFor(
      () => document.querySelector('#chartSvg path') && !document.querySelector('#chartSvg g[data-candle]'),
      15000,
      'area chart renders again'
    );
    assert(true, 'area chart renders again after switching back');
    // Callout shows the author's username + photo avatar + gold ring.
    const calloutCard = document.querySelector('#calloutsCard');
    assert(
      calloutCard.textContent.includes('smokecat'),
      'callout shows the author username'
    );
    const calloutAvatar = calloutCard.querySelector('img.profile-avatar-img');
    assert(
      calloutAvatar && calloutAvatar.getAttribute('src') === '/uploads/smoke-avatar.png',
      'callout shows the author photo avatar'
    );
    assert(
      calloutAvatar && calloutAvatar.classList.contains('avatar-ring-gold'),
      'callout avatar carries the gold border ring'
    );
    // Livestream panel: not-live state + the mesh-limit note.
    assert(document.querySelector('#streamCard'), 'livestream panel renders on the coin detail');
    assert(
      document.querySelector('#streamCard').textContent.includes('Livestream'),
      'stream panel carries its title'
    );
    assert(
      document.querySelector('#streamCard').textContent.includes('tidak live'),
      'stream panel shows the not-live state'
    );
    assert(
      document.querySelector('#streamCard').textContent.includes('WebRTC'),
      'stream panel states the WebRTC mesh limit'
    );
    const holderRow = document.querySelector('#holdersTable tbody tr');
    assert(holderRow, 'coin detail lists holders with recorded trade balances');
    assert(
      holderRow.textContent.includes(window.shortAddr(WALLET_A)) &&
        holderRow.textContent.includes(window.fmtTokens(tok1 + tok2)),
      'top holder row shows the wallet and its net token balance'
    );
    assert(
      holderRow.textContent.includes(window.fmtHolderSharePct(((tok1 + tok2) / 1000000000) * 100)),
      'top holder row shows its share of circulating supply'
    );
    // Callout rewards: the pool card (0.5 SOL funded) + tier chips on
    // the +50% callout (all three tiers eligible).
    assert(document.querySelector('#rewardCard'), 'reward card renders on the coin detail');
    assert(
      document.querySelector('#rewardCard').textContent.includes('Reward Callout'),
      'reward card carries its title'
    );
    assert(
      document.querySelector('#rewardCard').textContent.includes('0,5'),
      'reward card shows the 0.5 SOL pool balance'
    );
    assert(
      document.querySelectorAll('#calloutsCard .reward-chip').length >= 3,
      'the callouts show reward tier chips'
    );
    assert(
      document.querySelectorAll('#calloutsCard .reward-chip.eligible').length >= 3,
      'the +50% callout has all three tiers eligible'
    );
    // Tax + category badges and the verified creator checkmark on detail.
    assert(
      document.querySelector('.badge-tax'),
      'detail shows the creator tax badge'
    );
    assert(
      document.querySelector('.badge-tax').textContent.includes('1%'),
      'the tax badge shows the default 1%'
    );
    assert(
      document.querySelector('.badge-category'),
      'detail shows the category badge'
    );
    assert(
      document.querySelector('.verified-badge'),
      'detail shows the verified checkmark next to the creator'
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
    // Verified checkmark + badge shelf (Creator at minimum — WALLET_A
    // created coins; the verified rule is shown in the UI).
    assert(
      document.querySelector('.verified-badge'),
      'creator profile shows the verified checkmark'
    );
    assert(
      document.querySelector('.badge-shelf'),
      'creator profile shows the badge shelf'
    );
    assert(
      document.querySelector('.badge-shelf').textContent.includes('Kreator'),
      'badge shelf includes the Creator badge'
    );
    assert(
      document.body.textContent.includes('market cap $100K'),
      'creator profile shows the verified rule'
    );

    // Create view: form renders with Phantom guidance (no extension here).
    window.location.hash = '#/create';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitFor(() => document.querySelector('#coinName'), 15000, 'create form');
    assert(document.querySelector('#coinTicker'), 'create form has ticker input');
    assert(document.querySelector('#mintBtn'), 'create form has mint button');
    assert(document.querySelector('#createPreview'), 'create page shows the live preview panel');
    assert(
      document.querySelector('#createPreview').textContent.includes('Pratinjau'),
      'preview panel is labeled Pratinjau'
    );
    assert(
      document.querySelector('#createPreview').textContent.includes('$5K'),
      'preview shows the ~$5K starting market cap'
    );
    assert(
      document.body.textContent.includes('Phantom tidak terdeteksi'),
      'create view shows Phantom guidance without the extension'
    );
    assert(document.querySelector('#devnetConfirm'), 'create form has the Devnet confirmation checkbox');
    assert(
      document.body.textContent.includes('Phantom harus di jaringan Devnet'),
      'create form reminds that Phantom must be on Devnet'
    );
    // Category + tax + 18+ pickers on the create form; GIF logos accepted.
    assert(document.querySelector('#coinCategory'), 'create form has a category select');
    assert(
      document.querySelectorAll('#coinCategory option').length === 9,
      'category select offers all 9 categories'
    );
    assert(document.querySelector('#coinTax'), 'create form has a creator tax select');
    assert(
      document.querySelector('#coinTax').value === '100',
      'creator tax defaults to 1% (100 bps)'
    );
    assert(document.querySelector('#coinAdult'), 'create form has the 18+ checkbox');
    assert(
      document.querySelector('#coinLogo').getAttribute('accept').includes('image/gif'),
      'logo upload accepts GIF (including animated)'
    );
    assert(
      document.querySelector('#createPreview').textContent.includes('Pajak kreator'),
      'preview shows the creator tax note'
    );
    // Re-register link on the create page.
    assert(
      document.querySelector('a[href="#/re-register"]'),
      'create page links to the re-register form'
    );
    // Pair picker: SOL (default) + a searchable list of listed site coins.
    assert(document.querySelector('#pairPicker'), 'pair picker renders on the create form');
    assert(document.querySelector('#pairSearch'), 'pair picker has a search input');
    assert(
      document.querySelector('input[name="pairAsset"][value=""]:checked'),
      'SOL is the default pair asset'
    );
    await waitFor(
      () => document.querySelector('#pairList').textContent.includes('$SMOKE'),
      15000,
      'pair list loads the listed SMOKE coin'
    );
    assert(
      document.querySelector('#pairList .pair-option input[value="' + mint + '"]'),
      'pair list offers the seeded coin as a pair option'
    );
    // Searching filters the pair list; a non-matching query empties it.
    const pairSearch = document.getElementById('pairSearch');
    pairSearch.value = 'zzz-no-such-coin';
    pairSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(
      () => document.querySelector('#pairList').textContent.includes('Belum ada coin lain'),
      15000,
      'pair search with no match shows the empty state'
    );
    assert(true, 'pair search filters to the empty state on no match');
    pairSearch.value = 'smoke';
    pairSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(
      () => document.querySelector('#pairList').textContent.includes('$SMOKE'),
      15000,
      'pair search finds the coin again'
    );
    assert(true, 'pair search finds the coin by ticker');

    // Re-register view (no wallet): connect-first prompt.
    window.location.hash = '#/re-register';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitFor(
      () => document.body.textContent.includes('Daftar Ulang Coin'),
      15000,
      're-register view'
    );
    assert(
      document.body.textContent.includes('Hubungkan dompet'),
      're-register asks to connect the creator wallet first'
    );

    // Receipt page: the seeded transfer renders as a receipt.
    window.location.hash = `#/receipt/${transferId}`;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitFor(() => document.querySelector('.receipt'), 15000, 'receipt page');
    assert(
      document.body.textContent.includes('Struk Transfer'),
      'receipt page carries its title'
    );
    assert(
      document.querySelector('.receipt').textContent.includes('1.000.000'),
      'receipt shows the token amount'
    );
    assert(
      document.querySelector('.receipt').textContent.includes('$12.50'),
      'receipt shows the USD value snapshot'
    );
    assert(
      document.querySelector('.receipt a[href*="explorer.solana.com/tx/"]'),
      'receipt links the tx signature to Explorer'
    );
    assert(document.querySelector('#receiptCopyBtn'), 'receipt has a copy button');
    assert(document.querySelector('#receiptShareBtn'), 'receipt has a share button');
    assert(document.querySelector('#receiptPrintBtn'), 'receipt has a print button');

    // Creator profile (no wallet connected): username, photo avatar with
    // ring, cover banner — and NO edit form for a non-owner.
    window.location.hash = `#/creator/${WALLET_A}`;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitFor(
      () => document.querySelector('.profile-cover img'),
      15000,
      'profile cover banner'
    );
    assert(
      document.querySelector('.profile-cover img').getAttribute('src') === '/uploads/smoke-cover.png',
      'profile shows the cover banner image'
    );
    assert(
      document.body.textContent.includes('smokecat'),
      'profile shows the username as the display name'
    );
    const profileAvatar = document.querySelector('img.profile-avatar-img');
    assert(
      profileAvatar && profileAvatar.getAttribute('src') === '/uploads/smoke-avatar.png',
      'profile shows the photo avatar'
    );
    assert(
      profileAvatar && profileAvatar.classList.contains('avatar-ring-gold'),
      'profile avatar carries the gold border ring'
    );
    assert(
      !document.querySelector('#editProfileBtn'),
      'no edit button on a profile when no wallet is connected'
    );

    // ---- Connected wallet (second page, wallet pre-seeded in
    // localStorage): portfolio deposit section + transfer UI, and the
    // owner-only edit-profile form. ----
    dom2 = await JSDOM.fromURL(`${BASE}/`, {
      resources: 'usable',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) {
        const nodeFetch = fetch;
        window.fetch = (input, init) => {
          const url =
            typeof input === 'string' && input.startsWith('/')
              ? new URL(input, window.location.href).toString()
              : input;
          return nodeFetch(url, init);
        };
        // Same WebCrypto injection as page 1 (jsdom has no SubtleCrypto).
        Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
        window.localStorage.setItem('solpump-wallet', WALLET_A);
        window.HTMLMediaElement.prototype.play = () => Promise.resolve();
        const cameraTracks = [];
        const mediaRequests = [];
        Object.defineProperty(window, '__testCameraTracks', { value: cameraTracks });
        Object.defineProperty(window, '__testMediaRequests', { value: mediaRequests });
        Object.defineProperty(window.navigator, 'mediaDevices', {
          configurable: true,
          value: {
            getUserMedia: async (constraints) => {
              mediaRequests.push(constraints);
              if (constraints.audio) {
                throw new window.DOMException('Could not start audio source', 'NotReadableError');
              }
              const track = { kind: 'video', readyState: 'live', stop() { this.readyState = 'ended'; } };
              cameraTracks.push(track);
              return {
                getTracks: () => [track],
                getAudioTracks: () => [],
                getVideoTracks: () => [track],
              };
            },
          },
        });
      },
    });
    const win2 = dom2.window;
    const doc2 = win2.document;
    win2.addEventListener('error', (e) => {
      throw new Error(`page 2 error: ${e.message}`);
    });
    await waitFor(() => doc2.querySelector('.coin-card'), 15000, 'feed in page 2');

    // Portfolio with a wallet: deposit section (address + copy + QR),
    // per-holding transfer button, transfer history card.
    win2.location.hash = '#/portfolio';
    win2.dispatchEvent(new win2.HashChangeEvent('hashchange'));
    await waitFor(() => doc2.querySelector('#depositCard'), 20000, 'deposit card in portfolio');
    assert(
      doc2.querySelector('#depositCard').textContent.includes(WALLET_A),
      'deposit section shows the connected wallet address'
    );
    assert(doc2.querySelector('#copyDepositBtn'), 'deposit section has a copy button');
    await waitFor(() => doc2.querySelector('#depositQr img'), 15000, 'deposit QR code');
    assert(
      doc2.querySelector('#depositQr img').getAttribute('src').startsWith('data:image/'),
      'deposit QR code renders as an image'
    );
    assert(
      doc2.querySelector('#depositCard').textContent.includes('tidak pernah memegang dana'),
      'deposit section notes the site never holds user funds'
    );
    assert(
      doc2.querySelector('[data-transfer="' + mint + '"]'),
      'portfolio positions have a per-holding transfer (Kirim) button'
    );
    assert(doc2.querySelector('#transferHistory'), 'portfolio shows the transfer history card');
    assert(
      doc2.querySelector('#transferHistory').textContent.includes('1.000.000'),
      'transfer history shows the seeded transfer'
    );
    assert(
      doc2.querySelector(`#transferHistory a[href="#/receipt/${transferId}"]`),
      'transfer history links each row to its receipt'
    );
    // Contacts section: the seeded contact + the add form.
    assert(doc2.querySelector('#contactsList'), 'portfolio shows the contacts section');
    await waitFor(
      () => doc2.querySelector('#contactsList').textContent.includes('Budi'),
      15000,
      'contacts list loads the seeded contact'
    );
    assert(
      doc2.querySelector('#contactsList').textContent.includes('Budi'),
      'contacts list shows the seeded contact'
    );
    assert(doc2.querySelector('#newContactName'), 'contacts section has a name input');
    assert(doc2.querySelector('#addContactBtn'), 'contacts section has an add button');
    // Clicking Kirim opens the transfer card for that coin.
    doc2.querySelector('[data-transfer="' + mint + '"]').click();
    await waitFor(
      () => !doc2.querySelector('#portfolioTransferCard').hidden,
      15000,
      'portfolio transfer card opens'
    );
    assert(
      doc2.querySelector('#pfTransferTo') && doc2.querySelector('#pfTransferAmount'),
      'portfolio transfer card has recipient + amount inputs'
    );
    // Contact picker: the seeded contact is offered; picking it fills
    // the recipient input.
    await waitFor(
      () =>
        !doc2.querySelector('#pfTransferContact').hidden &&
        [...doc2.querySelector('#pfTransferContact').options].some((o) => o.textContent.includes('Budi')),
      15000,
      'contact picker loads the seeded contact'
    );
    assert(true, 'transfer form offers the contact picker');
    const picker = doc2.querySelector('#pfTransferContact');
    picker.value = 'J6uK6XxHL2T2bg8CefLKYTSCwpMeBmTG7Pa9K8NYWSvb';
    picker.dispatchEvent(new win2.Event('change', { bubbles: true }));
    assert(
      doc2.querySelector('#pfTransferTo').value === 'J6uK6XxHL2T2bg8CefLKYTSCwpMeBmTG7Pa9K8NYWSvb',
      'picking a contact fills the recipient address'
    );
    // No Admin link for a non-admin wallet.
    assert(
      !doc2.querySelector('[data-nav="admin"]'),
      'no Admin nav link for a non-admin wallet'
    );

    // Re-register view (connected): the full form renders.
    win2.location.hash = '#/re-register';
    win2.dispatchEvent(new win2.HashChangeEvent('hashchange'));
    await waitFor(() => doc2.querySelector('#rrMint'), 15000, 're-register form');
    assert(doc2.querySelector('#rrName'), 're-register form has a name input');
    assert(doc2.querySelector('#rrTicker'), 're-register form has a ticker input');
    assert(doc2.querySelector('#rrPair'), 're-register form has a pair select');
    assert(doc2.querySelector('#rrCategory'), 're-register form has a category select');
    assert(doc2.querySelector('#rrTax'), 're-register form has a tax select');
    assert(doc2.querySelector('#rrAdult'), 're-register form has the 18+ checkbox');
    assert(doc2.querySelector('#rrSubmitBtn'), 're-register form has a submit button');
    assert(
      doc2.body.textContent.includes('mulai dari nol'),
      're-register states the fresh-history caveat'
    );

    // Own profile (owner wallet): edit button + edit form prefilled with
    // the current username/border; deposit card also present.
    win2.location.hash = `#/creator/${WALLET_A}`;
    win2.dispatchEvent(new win2.HashChangeEvent('hashchange'));
    await waitFor(() => doc2.querySelector('#editProfileBtn'), 15000, 'edit button on own profile');
    assert(true, 'edit button renders on the owner profile');
    assert(doc2.querySelector('#depositCard'), 'own profile shows the deposit card');
    assert(
      doc2.querySelector('#editProfileCard').hidden,
      'edit form starts hidden'
    );
    doc2.querySelector('#editProfileBtn').click();
    await waitFor(
      () => !doc2.querySelector('#editProfileCard').hidden,
      15000,
      'edit form opens'
    );
    assert(
      doc2.querySelector('#editUsername').value === 'smokecat',
      'edit form prefills the current username'
    );
    assert(
      doc2.querySelector('input[name="editBorder"][value="gold"]').checked,
      'edit form preselects the current border'
    );
    assert(
      doc2.querySelectorAll('input[name="editBorder"]').length === 6,
      'border picker offers all 6 presets'
    );
    assert(doc2.querySelector('#editAvatar'), 'edit form has an avatar upload input');
    assert(doc2.querySelector('#editCover'), 'edit form has a cover upload input');
    assert(doc2.querySelector('#saveProfileBtn'), 'edit form has a save button');
    assert(doc2.querySelector('#removeAvatar'), 'edit form offers removing the current photo');
    assert(doc2.querySelector('#removeCover'), 'edit form offers removing the current cover');

    // Another wallet's profile (same connected wallet): no edit button.
    win2.location.hash = '#/creator/J6uK6XxHL2T2bg8CefLKYTSCwpMeBmTG7Pa9K8NYWSvb';
    win2.dispatchEvent(new win2.HashChangeEvent('hashchange'));
    await waitFor(
      () => doc2.body.textContent.includes('Coin yang Dibuat'),
      15000,
      'other creator profile'
    );
    assert(
      !doc2.querySelector('#editProfileBtn'),
      'no edit button on another wallet profile'
    );

    // Creator coin detail (connected wallet IS the creator): dev burn
    // panel + buyback section both render.
    win2.location.hash = `#/coin/${mint}`;
    win2.dispatchEvent(new win2.HashChangeEvent('hashchange'));
    await waitFor(() => doc2.querySelector('#devBurnBtn'), 15000, 'dev burn card for the creator');
    assert(true, 'dev burn panel renders for the coin creator');
    assert(
      doc2.querySelector('#devBurnCard').textContent.includes('Dev Burn'),
      'dev burn panel carries its title'
    );
    assert(doc2.querySelector('#devBurnSource'), 'dev burn panel has a source selector');
    assert(
      doc2.querySelector('#devBurnSource').options.length === 2,
      'dev burn source selector offers holdings + pool reserve'
    );
    assert(doc2.querySelector('#devBurnAmount'), 'dev burn panel has an amount input');
    assert(doc2.querySelector('#devBurnMax'), 'dev burn panel has a MAX button');
    assert(doc2.querySelector('#devBurnBtn'), 'dev burn panel has a burn button');
    assert(doc2.querySelector('#devBurnCalc'), 'dev burn panel has a calculation area');
    await waitFor(() => doc2.querySelector('#buybackBox'), 15000, 'buyback section for the creator');
    assert(true, 'buyback section renders for the coin creator');
    assert(
      doc2.querySelector('#buybackBox').textContent.includes('Buyback dari Fee'),
      'buyback section carries its title'
    );
    assert(doc2.querySelector('#buybackAmount'), 'buyback section has an amount input');
    assert(doc2.querySelector('#buybackAllBtn'), 'buyback section has a buyback-all button');
    assert(doc2.querySelector('#buybackBtn'), 'buyback section has a buyback button');
    assert(doc2.querySelector('#buybackPreview'), 'buyback section has a preview area');
    // The dev burn calculation fetches the server preview on input:
    // typing an amount renders the current → projected table.
    doc2.querySelector('#devBurnAmount').value = '1000000';
    doc2.querySelector('#devBurnAmount').dispatchEvent(new win2.Event('input', { bubbles: true }));
    await waitFor(
      () => doc2.querySelector('#devBurnCalc table'),
      15000,
      'dev burn calculation table'
    );
    assert(
      doc2.querySelector('#devBurnCalc').textContent.includes('Setelah Burn'),
      'dev burn calculation shows the projected column'
    );
    assert(
      doc2.querySelector('#devBurnCalc').textContent.includes('Kenaikan Harga'),
      'dev burn calculation shows the price gain row'
    );
    // Creator-only reward funding + the author's claim buttons on the
    // +50% callout (WALLET_A is both creator and callout author).
    assert(
      doc2.querySelector('#rewardFundAmount'),
      'reward fund form renders for the coin creator'
    );
    assert(
      doc2.querySelectorAll('#calloutsCard [data-claim-reward]').length >= 3,
      'the callout author sees claim buttons for the three eligible tiers'
    );
    doc2.querySelector('[data-side="sell"]').click();
    await waitFor(() => doc2.querySelector('#sellAllCreatorBtn'), 15000, 'creator sell-all control');
    assert(
      doc2.querySelector('#sellAllCreatorBtn').textContent.includes('Jual Semua Token Kreator'),
      'the creator can start a normal sell of their full token balance'
    );
    doc2.querySelector('[data-side="buy"]').click();
    await waitFor(() => doc2.querySelector('#streamStartBtn'), 5000, 'creator detail re-renders after switching back to buy');
    // Livestream: the creator sees the Go Live button.
    assert(
      doc2.querySelector('#streamStartBtn'),
      'the coin creator sees the Go Live button'
    );
    assert(
      doc2.querySelector('#streamCard').textContent.includes('WebRTC'),
      'the stream panel states the mesh limit for the creator too'
    );
    doc2.querySelector('#streamStartBtn').click();
    await waitFor(() => doc2.querySelector('#streamSetupModal'), 5000, 'livestream setup popup');
    assert(doc2.querySelector('#streamSetupVideo'), 'livestream setup shows a camera preview');
    assert(
      win2.__testMediaRequests.length >= 2 &&
        win2.__testMediaRequests[0].audio === true &&
        win2.__testMediaRequests[1].audio === false,
      'livestream retries with video-only capture when the audio source fails'
    );
    assert(
      doc2.querySelector('#streamSetupStatus').textContent.includes('video saja'),
      'livestream explains when the microphone is unavailable'
    );
    const mirrorToggle = doc2.querySelector('#streamMirrorToggle');
    assert(mirrorToggle.checked, 'camera preview is mirrored by default');
    mirrorToggle.checked = false;
    mirrorToggle.dispatchEvent(new win2.Event('change', { bubbles: true }));
    assert(
      !doc2.querySelector('#streamSetupVideo').classList.contains('is-mirrored'),
      'camera mirror toggle updates the preview'
    );
    doc2.querySelector('#streamSetupCancel').click();
    await waitFor(() => !doc2.querySelector('#streamSetupModal'), 5000, 'livestream setup popup closes');
    assert(
      win2.__testCameraTracks.at(-1).readyState === 'ended',
      'closing livestream setup releases the camera'
    );

    // Routed SOL buys: on the pair coin, the buy form offers SOL
    // (default) or the pair asset; on the deep-chain coin the SOL
    // option is disabled with the reason.
    win2.location.hash = `#/coin/${mintPair}`;
    win2.dispatchEvent(new win2.HashChangeEvent('hashchange'));
    await waitFor(
      () =>
        doc2.querySelector('.coin-head')?.textContent.includes('PDOG') &&
        doc2.querySelector('.pay-choice'),
      15000,
      'pay-choice radios on the pair coin'
    );
    assert(
      doc2.querySelectorAll('.pay-choice input[type="radio"]').length === 2,
      'the pair coin buy form offers two payment options (SOL + pair asset)'
    );
    assert(
      doc2.querySelector('.pay-choice input[value="sol"]').checked,
      'SOL is the default payment option'
    );
    assert(
      doc2.querySelector('.pay-choice').textContent.includes('SMOKE'),
      'the pair-asset option names the pair coin'
    );
    win2.location.hash = `#/coin/${mintDeep}`;
    win2.dispatchEvent(new win2.HashChangeEvent('hashchange'));
    await waitFor(
      () =>
        doc2.querySelector('.coin-head')?.textContent.includes('DCCAT') &&
        doc2.querySelector('.pay-choice'),
      15000,
      'pay-choice radios on the deep-chain coin'
    );
    assert(
      doc2.querySelector('.pay-choice input[value="sol"]').disabled,
      'the SOL option is disabled for the deep-chain coin'
    );
    assert(
      doc2.querySelector('.trade-box').textContent.includes('lebih dari satu hop'),
      'the deep-chain coin explains why SOL is unavailable'
    );

    // ---- Admin wallet (third page, test admin pre-seeded in
    // localStorage + collapsed sidebar): the Admin nav link appears and
    // the #/admin panel renders the grant form. No signing happens in
    // jsdom — the panel renders fully without it. ----
    dom3 = await JSDOM.fromURL(`${BASE}/`, {
      resources: 'usable',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) {
        const nodeFetch = fetch;
        window.fetch = (input, init) => {
          const url =
            typeof input === 'string' && input.startsWith('/')
              ? new URL(input, window.location.href).toString()
              : input;
          return nodeFetch(url, init);
        };
        Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
        window.localStorage.setItem('solpump-wallet', TEST_ADMIN_ADDRESS);
        window.localStorage.setItem('solpump-sidebar-collapsed', '1');
      },
    });
    const win3 = dom3.window;
    const doc3 = win3.document;
    win3.addEventListener('error', (e) => {
      throw new Error(`page 3 error: ${e.message}`);
    });
    await waitFor(() => doc3.querySelector('.coin-card'), 15000, 'feed in page 3');
    // The collapsed sidebar persists across a reload (seeded '1').
    assert(
      doc3.getElementById('appShell').classList.contains('sidebar-collapsed'),
      'the sidebar starts collapsed when localStorage says so'
    );
    // The Admin link appears once the server confirms the wallet.
    await waitFor(() => doc3.querySelector('[data-nav="admin"]'), 15000, 'Admin nav link for the admin wallet');
    assert(
      doc3.querySelector('[data-nav="admin"]').textContent.includes('Admin'),
      'the Admin nav link renders for the admin wallet'
    );
    win3.location.hash = '#/admin';
    win3.dispatchEvent(new win3.HashChangeEvent('hashchange'));
    await waitFor(() => doc3.querySelector('#adminGrantBtn'), 15000, 'admin grant form');
    assert(doc3.querySelector('#adminWallet'), 'admin panel has a wallet input');
    assert(doc3.querySelector('#adminBadge'), 'admin panel has a badge select');
    assert(
      doc3.querySelectorAll('#adminBadge option').length === 5,
      'admin badge select offers all 5 community badges'
    );
    assert(doc3.querySelector('#adminLoadListBtn'), 'admin panel has a load-list button');

    console.log('\nALL UI SMOKE CHECKS PASSED');
  } finally {
    if (dom) dom.window.close();
    if (dom2) dom2.window.close();
    if (dom3) dom3.window.close();
    const allMints = [mint, mintAdult, mintPair, mintDeep, mintGrad];
    const placeholders = allMints.map(() => '?').join(', ');
    db.prepare(`DELETE FROM trades WHERE mint_address IN (${placeholders})`).run(...allMints);
    db.prepare(`DELETE FROM callouts WHERE mint_address IN (${placeholders})`).run(...allMints);
    db.prepare(`DELETE FROM reward_funds WHERE mint_address IN (${placeholders})`).run(...allMints);
    db.prepare(`DELETE FROM transfers WHERE mint_address IN (${placeholders})`).run(...allMints);
    db.prepare(`DELETE FROM coins WHERE mint_address IN (${placeholders})`).run(...allMints);
    db.prepare('DELETE FROM profiles WHERE wallet = ?').run(WALLET_A);
    db.prepare('DELETE FROM contacts WHERE owner_wallet = ?').run(WALLET_A);
    const left = db.prepare('SELECT COUNT(*) AS n FROM coins').get().n;
    console.log(`test data cleaned; coins remaining in DB: ${left}`);
    db.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
