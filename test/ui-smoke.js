'use strict';
// UI smoke test: loads the real frontend in jsdom against a running server,
// walks the feed -> coin detail -> creator profile -> portfolio -> create
// views and asserts the key elements render. Requires the server running
// (default http://localhost:3100). Seeds one test coin + trades + a callout
// directly in the local DB, then removes all test data. Also unit-checks
// the price formatters: plain decimals everywhere, never scientific
// notation — SOL prices, USD prices ($0.000005), USD money ($12.35) and
// the $K/$M/$B market-cap suffixes. Run with:
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
  console.log('seeded smoke coin', mint);

  let dom;
  let dom2;
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

    // Coin detail: chart, stats, trade panel, PnL prompt, trades table.
    window.location.hash = `#/coin/${mint}`;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitFor(() => document.querySelector('#chartSvg'), 15000, 'price chart SVG');
    assert(document.body.textContent.includes('Grafik Harga'), 'detail shows price chart heading');
    assert(document.body.textContent.includes('Market Cap'), 'detail shows market cap stat');
    assert(document.body.textContent.includes('SMOKE/SOL'), 'detail shows the TICKER/SOL pair label');
    // Market cap appears in the chart header too (next to the price).
    const chartCard = document.querySelector('#chartWrap').closest('.card');
    assert(chartCard.textContent.includes('Market Cap'), 'chart header shows market cap next to the price');
    if (expPrice) {
      assert(chartCard.textContent.includes(expPrice), `chart header shows the USD price (${expPrice})`);
      assert(chartCard.textContent.includes(expMc), `chart header shows the USD market cap (${expMc})`);
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
        window.localStorage.setItem('solpump-wallet', WALLET_A);
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
      doc2.querySelector('#transferHistory').textContent.includes('Belum ada transfer'),
      'transfer history shows the empty state'
    );
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

    console.log('\nALL UI SMOKE CHECKS PASSED');
  } finally {
    if (dom) dom.window.close();
    if (dom2) dom2.window.close();
    db.prepare('DELETE FROM trades WHERE mint_address = ?').run(mint);
    db.prepare('DELETE FROM callouts WHERE mint_address = ?').run(mint);
    db.prepare('DELETE FROM profiles WHERE wallet = ?').run(WALLET_A);
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
