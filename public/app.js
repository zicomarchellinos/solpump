'use strict';
// solpump frontend: hash-routed single-page app.
// Views: feed (#/), create (#/create), coin detail (#/coin/<mint>),
// creator profile (#/creator/<wallet>), portfolio (#/portfolio).
// Minting AND trading are real on Solana devnet via Phantom + the pool
// wallet; every trade takes a 1% creator fee (see src/bonding.js).
// Display currency: token prices + market cap are USD (pump.fun style —
// the server supplies the SOL/USD rate and the *Usd fields; the UI falls
// back to SOL when no rate is available). The trading pair is TICKER/SOL:
// buy/sell amounts, amounts received, pool balances and fees stay in SOL
// because that is the currency actually moving.

const EXPLORER = 'https://explorer.solana.com';

// ---------- State ----------
const state = {
  wallet: localStorage.getItem('solpump-wallet') || null,
  balanceSol: null,
  poolAddress: null,
  onchainBalances: {}, // mintAddress -> live on-chain token balance
  coinCache: null, // last loaded coin detail
  chartRange: 0, // 0 = all, else last N trades
  tradeTab: 'Semua',
  tradeSide: 'buy',
  following: new Set(), // wallets the connected wallet follows
  feedFollowingOnly: false, // feed filter: only coins by followed creators
};

// A mint that succeeded on-chain but whose registration failed: kept so the
// user can retry registration without minting (and paying rent) again.
function loadPendingMint() {
  try {
    return JSON.parse(localStorage.getItem('solpump-pending-mint') || 'null');
  } catch {
    return null;
  }
}
function savePendingMint(p) {
  if (p) localStorage.setItem('solpump-pending-mint', JSON.stringify(p));
  else localStorage.removeItem('solpump-pending-mint');
}

// ---------- Helpers ----------
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortAddr(a) {
  if (!a) return '';
  return a.length <= 12 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function fmtSol(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 6 });
}

// Token prices are tiny (SOL per token); show enough precision to be useful.
// ALWAYS plain decimal notation — never scientific notation ("×10^-8" /
// "e-8"): tiny prices render as e.g. 0,000000041 (Indonesian decimal comma,
// like the rest of the site). Keeps 4 significant digits, then trims
// trailing zeros so 0,0000000410 displays as 0,000000041.
function fmtPrice(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 0.0001) return n.toLocaleString('id-ID', { maximumFractionDigits: 6 });
  const decimals = Math.min(-Math.floor(Math.log10(n)) + 3, 20);
  const fixed = n.toFixed(decimals);
  const trimmed = fixed.replace(/\.?0+$/, '') || '0';
  return trimmed.replace('.', ',');
}

function fmtTokens(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '0';
  if (n >= 1000) return n.toLocaleString('id-ID', { maximumFractionDigits: 0 });
  return n.toLocaleString('id-ID', { maximumFractionDigits: 2 });
}

function fmtPct(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '0%';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtSignedSol(x) {
  const n = Number(x);
  return `${n >= 0 ? '+' : '−'}${fmtSol(Math.abs(n))} SOL`;
}

// USD price formatting (pump.fun style): plain decimals, never scientific
// notation, $ prefix, dot decimal separator. Token prices are tiny, so keep
// 4 significant digits and trim trailing zeros: $0.000005, $0.000002987.
function fmtPriceUsd(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n === 0) return '$0';
  if (n >= 0.0001) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 6 });
  const decimals = Math.min(-Math.floor(Math.log10(n)) + 3, 20);
  const fixed = n.toFixed(decimals);
  const trimmed = fixed.replace(/\.?0+$/, '') || '0';
  return '$' + trimmed;
}

// USD money amounts (PnL, values): 2 decimals from $1 up, plain decimals
// with 4 significant digits below $1. Never scientific notation.
function fmtUsd(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n === 0) return '$0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1) {
    return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  const decimals = Math.min(-Math.floor(Math.log10(abs)) + 3, 20);
  const trimmed = abs.toFixed(decimals).replace(/\.?0+$/, '') || '0';
  return `${sign}$${trimmed}`;
}

function fmtSignedUsd(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '$0';
  return `${n >= 0 ? '+' : '−'}${fmtUsd(Math.abs(n))}`;
}

// Market cap in USD with compact suffixes: $5K, $500K, $5M, $50M, $500M,
// $5B. One decimal when it adds information ($5.2K, $12.4M), none for round
// values. Mirrors the server's fmtMarketCapUsd (src/bonding.js).
function fmtMarketCapUsd(usd) {
  if (usd === null || usd === undefined) return null; // Number(null) is 0
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0) return null;
  const oneDecimal = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  const scales = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (let i = 0; i < scales.length; i++) {
    const [div, suffix] = scales[i];
    if (n < div) continue;
    let v = Math.round((n / div) * 10) / 10;
    if (v >= 1000 && i > 0) {
      const [upDiv, upSuffix] = scales[i - 1];
      v = Math.round((n / upDiv) * 10) / 10;
      return `$${oneDecimal(v)}${upSuffix}`;
    }
    return `$${oneDecimal(v)}${suffix}`;
  }
  return `$${oneDecimal(Math.round(n * 10) / 10)}`;
}

// Price display: USD when the server has a SOL price, SOL otherwise (the
// API carries the *Usd fields only when a price was available).
function fmtPriceBoth(usdValue, solValue) {
  if (Number.isFinite(usdValue)) return fmtPriceUsd(usdValue);
  return `${fmtPrice(solValue)} SOL`;
}

// Market-cap display: USD with suffixes when available, SOL otherwise.
function fmtMarketCap(c) {
  if (c && Number.isFinite(c.marketCapUsd)) return fmtMarketCapUsd(c.marketCapUsd);
  return `${fmtSol(c.marketCapSol)} SOL`;
}

// Money figure (PnL, value): USD primary, SOL as a small secondary line.
// Falls back to SOL only when no USD price is available.
function fmtMoneyBoth(usd, sol, signed = false) {
  const solStr = signed ? fmtSignedSol(sol) : `${fmtSol(sol)} SOL`;
  if (!Number.isFinite(usd)) return solStr;
  const usdStr = signed ? fmtSignedUsd(usd) : fmtUsd(usd);
  return `${usdStr}<div class="small muted">${solStr}</div>`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

async function apiGet(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function logoHtml(coin, cls = 'coin-logo') {
  if (coin.logoUrl) {
    return `<img class="${cls}" src="${esc(coin.logoUrl)}" alt="${esc(coin.ticker)}">`;
  }
  const initials = (coin.ticker || '?').slice(0, 2).toUpperCase();
  return `<div class="coin-avatar">${esc(initials)}</div>`;
}

function txLink(sig, label) {
  if (!sig) return '<span class="muted">—</span>';
  return `<a class="mono" href="${EXPLORER}/tx/${esc(sig)}?cluster=devnet" target="_blank" rel="noopener" title="${esc(sig)}">${esc(label || shortAddr(sig))} ↗</a>`;
}

// Link to a creator/trader profile. Inside clickable cards the caller must
// stopPropagation on the link's click (see coinCard wiring).
function creatorLink(addr, label) {
  if (!addr) return '';
  return `<a class="addr-link mono" href="#/creator/${esc(addr)}" title="${esc(addr)}">${esc(label || shortAddr(addr))}</a>`;
}

// Canonical follow message — must match src/signverify.js on the server.
// The server rebuilds the expected message and verifies the signature.
function followMessage(action, followingWallet) {
  return `solpump:${action}:${followingWallet}`;
}

// One callout (social trade call). Entry price + holdings were computed
// server-side from the trader's real trades; PnL is live vs the current
// price. Prices are USD (plain decimals, never scientific notation), PnL is
// USD primary with the SOL figure in parentheses; PnL uses the same
// green=profit / pink=loss styling as the PnL card.
function calloutHtml(c, { showCoin = false } = {}) {
  const cls = c.pnlSol >= 0 ? 'profit' : 'loss';
  const pnlUsd = Number.isFinite(c.pnlUsd)
    ? `${fmtSignedUsd(c.pnlUsd)} <span class="muted">(${fmtSignedSol(c.pnlSol)})</span>`
    : fmtSignedSol(c.pnlSol);
  return `
    <div class="callout">
      <div class="callout-head">
        ${creatorLink(c.wallet)}
        <span class="badge badge-ok">✓ Pembeli terverifikasi</span>
        ${showCoin ? `<a href="#/coin/${esc(c.mintAddress)}"><b>$${esc(c.coinTicker)}</b></a>` : ''}
        <span class="muted small" style="margin-left:auto">${fmtTime(c.createdAt)}</span>
      </div>
      <p class="callout-text">${esc(c.text)}</p>
      <div class="callout-meta small">
        <span>Entry <b>${fmtPriceBoth(c.entryPriceUsd, c.entryPrice)}</b></span>
        <span>Dipergang <b>${fmtTokens(c.holdingsAtPost)}</b></span>
        <span>Harga kini <b>${fmtPriceBoth(c.currentPriceUsd, c.currentPrice)}</b></span>
        <span>PnL <b class="${cls}">${pnlUsd} (${fmtPct(c.pnlPct)})</b></span>
      </div>
    </div>`;
}

async function loadPoolAddress() {
  if (state.poolAddress) return state.poolAddress;
  try {
    state.poolAddress = await getPoolAddress();
  } catch {
    state.poolAddress = null;
  }
  return state.poolAddress;
}

// Refresh the wallet's live on-chain SPL balances (one RPC call).
async function refreshOnchainBalances() {
  if (!state.wallet || !solanaLibsReady()) {
    state.onchainBalances = {};
    return;
  }
  try {
    state.onchainBalances = await getAllTokenBalances(state.wallet);
  } catch {
    state.onchainBalances = {};
  }
}

// ---------- Wallet (Phantom) ----------
function solanaLibsReady() {
  return typeof window.solanaWeb3 !== 'undefined' && typeof window.splToken !== 'undefined';
}

async function refreshBalance() {
  if (!state.wallet || !solanaLibsReady()) {
    state.balanceSol = null;
    return;
  }
  try {
    state.balanceSol = await getDevnetBalanceSol(state.wallet);
  } catch {
    state.balanceSol = null;
  }
}

// Load the wallets the connected wallet follows (for the feed filter and
// follow buttons). Silent on failure — following is a nicety, not a blocker.
async function loadFollowing() {
  state.following = new Set();
  if (!state.wallet) return;
  try {
    const data = await apiGet(`/api/follows/${encodeURIComponent(state.wallet)}`);
    state.following = new Set(data.following || []);
  } catch {
    state.following = new Set();
  }
}

// Sync the site's wallet state with the account currently active in
// Phantom. A user can switch accounts inside Phantom at any time; without
// this, the site would check the OLD account's devnet balance while
// Phantom signs with the NEW (possibly empty) account — the classic cause
// of a "Not enough SOL" popup after a passing balance check. connect()
// is silent when the site is already connected. Returns false when the
// account could not be determined.
async function syncWalletAccount() {
  const phantom = (await waitForPhantom(3000)) || getPhantom();
  if (!phantom) return false;
  try {
    const resp = await phantom.connect();
    const current = resp.publicKey.toString();
    if (current !== state.wallet) {
      state.wallet = current;
      localStorage.setItem('solpump-wallet', current);
      await loadFollowing();
      toast(`Dompet aktif di Phantom berubah — sekarang ${shortAddr(current)}.`);
    }
    await refreshBalance();
    await refreshOnchainBalances();
    renderHeader();
    return true;
  } catch {
    return false;
  }
}

async function connectWallet() {
  // The extension can inject after our scripts run; wait briefly for it.
  const phantom = (await waitForPhantom(3000)) || getPhantom();
  if (!phantom) {
    toast('Phantom tidak ditemukan. Instal ekstensi Phantom dulu (di HP, buka situs ini dari browser di dalam aplikasi Phantom).');
    window.open('https://phantom.app/', '_blank', 'noopener');
    return;
  }
  try {
    const resp = await phantom.connect();
    state.wallet = resp.publicKey.toString();
    localStorage.setItem('solpump-wallet', state.wallet);
    await refreshBalance();
    await refreshOnchainBalances();
    await loadFollowing();
    // Sanity-check our devnet endpoint (genesis hash). The wallet's own
    // selected network cannot be read from a website — the create page
    // tells the user to switch Phantom to Devnet explicitly.
    try {
      const ok = await verifyDevnetRpc();
      if (!ok) toast('Peringatan: endpoint RPC bukan devnet. Laporkan ke pengelola situs.');
    } catch {
      // Non-fatal: the mint flow re-checks before signing.
    }
    renderHeader();
    route();
    toast('Dompet terhubung.');
  } catch (err) {
    toast(`Gagal menghubungkan dompet: ${friendlyError(err)}`);
  }
}

function disconnectWallet() {
  const phantom = getPhantom();
  if (phantom) phantom.disconnect().catch(() => {});
  state.wallet = null;
  state.balanceSol = null;
  state.following = new Set();
  state.feedFollowingOnly = false;
  localStorage.removeItem('solpump-wallet');
  renderHeader();
  route();
}

function renderHeader() {
  const box = document.getElementById('walletBox');
  if (state.wallet) {
    // Live devnet balance, prominent: re-read from devnet RPC on connect
    // and after every confirmed transaction (mint / funding / trade /
    // claim). The refresh button re-reads it on demand; the address links
    // to the wallet's own profile page.
    box.innerHTML = `
      <a class="wallet-chip" href="#/creator/${esc(state.wallet)}" title="Profil saya">
        <span class="mono">${esc(shortAddr(state.wallet))}</span>
        <span class="bal" title="Saldo SOL devnet (dibaca langsung dari devnet)">${state.balanceSol === null ? '…' : `${fmtSol(state.balanceSol)} SOL`}</span>
      </a>
      <button class="btn btn-sm btn-ghost" id="refreshBalHeaderBtn" title="Periksa ulang saldo devnet">↻</button>
      <button class="btn btn-sm" id="disconnectBtn">Putuskan</button>`;
    document.getElementById('disconnectBtn').onclick = disconnectWallet;
    document.getElementById('refreshBalHeaderBtn').onclick = async () => {
      const btn = document.getElementById('refreshBalHeaderBtn');
      if (btn) btn.disabled = true;
      await refreshBalance();
      renderHeader();
    };
  } else {
    box.innerHTML = `<button class="btn btn-primary" id="connectBtn">Hubungkan Phantom</button>`;
    document.getElementById('connectBtn').onclick = connectWallet;
  }
  // Nav active state
  const hash = location.hash || '#/';
  document.querySelectorAll('.nav a').forEach((a) => {
    const href = a.getAttribute('href');
    a.classList.toggle(
      'active',
      href === hash || (href === '#/' && (hash === '' || hash === '#/'))
    );
  });
}

// ---------- Router ----------
function route() {
  const hash = location.hash || '#/';
  renderHeader();
  if (hash === '#/' || hash === '') return renderFeed();
  if (hash === '#/create') return renderCreate();
  if (hash === '#/portfolio') return renderPortfolio();
  const m = hash.match(/^#\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (m) return renderCoin(m[1]);
  const c = hash.match(/^#\/creator\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (c) return renderCreator(c[1]);
  document.getElementById('view').innerHTML =
    '<div class="card"><p>Halaman tidak ditemukan.</p><a href="#/">Kembali ke Beranda</a></div>';
}

window.addEventListener('hashchange', route);

// ---------- Feed ----------
let feedSearch = '';
let feedSort = 'newest';

async function renderFeed() {
  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="hero">
      <div class="badge-live">● TRADING ASLI DI DEVNET</div>
      <h1>Buat coin-mu sendiri di Solana devnet</h1>
      <p>Isi nama, ticker, dan logo — satu tanda tangan di Phantom me-mint token SPL beneran di devnet. Trading memakai SOL devnet asli lewat dompet pool.</p>
      <a class="btn btn-primary" href="#/create">+ Buat Coin</a>
    </div>
    <div class="toolbar">
      <input id="searchInput" type="search" placeholder="Cari coin atau ticker…" value="${esc(feedSearch)}">
      <select id="sortSelect">
        <option value="newest" ${feedSort === 'newest' ? 'selected' : ''}>Terbaru</option>
        <option value="price" ${feedSort === 'price' ? 'selected' : ''}>Harga tertinggi</option>
        <option value="marketcap" ${feedSort === 'marketcap' ? 'selected' : ''}>Market cap</option>
        <option value="volume" ${feedSort === 'volume' ? 'selected' : ''}>Volume</option>
        <option value="change" ${feedSort === 'change' ? 'selected' : ''}>Perubahan harga</option>
      </select>
      ${state.wallet && state.following.size > 0
        ? `<button class="btn btn-sm ${state.feedFollowingOnly ? 'active' : ''}" id="followingToggle" title="Hanya coin dan callout dari kreator yang kamu ikuti">Mengikuti (${state.following.size})</button>`
        : ''}
    </div>
    <div id="followingCallouts"></div>
    <div id="coinList"><p class="muted">Memuat coin…</p></div>`;

  const searchInput = document.getElementById('searchInput');
  const sortSelect = document.getElementById('sortSelect');
  let debounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      feedSearch = searchInput.value;
      loadCoins();
    }, 300);
  });
  sortSelect.addEventListener('change', () => {
    feedSort = sortSelect.value;
    loadCoins();
  });
  const followingToggle = document.getElementById('followingToggle');
  if (followingToggle) {
    followingToggle.addEventListener('click', () => {
      state.feedFollowingOnly = !state.feedFollowingOnly;
      followingToggle.classList.toggle('active', state.feedFollowingOnly);
      loadCoins();
    });
  }
  loadCoins();

  async function loadCoins() {
    const list = document.getElementById('coinList');
    if (!list) return;
    // When the Following filter is active, show callouts from followed
    // traders above the coin list.
    const calloutsBox = document.getElementById('followingCallouts');
    if (state.feedFollowingOnly && state.wallet && calloutsBox) {
      try {
        const cd = await apiGet(`/api/callouts?following=${encodeURIComponent(state.wallet)}`);
        calloutsBox.innerHTML = cd.callouts.length
          ? `<div class="card"><h2 style="margin-top:0">Callout dari yang Kamu Ikuti</h2>${cd.callouts
              .map((c) => calloutHtml(c, { showCoin: true }))
              .join('')}</div>`
          : '';
      } catch {
        calloutsBox.innerHTML = '';
      }
    } else if (calloutsBox) {
      calloutsBox.innerHTML = '';
    }
    try {
      const params = new URLSearchParams({ sort: feedSort });
      if (feedSearch.trim()) params.set('search', feedSearch.trim());
      if (state.feedFollowingOnly && state.wallet) {
        params.set('following', state.wallet);
      }
      const data = await apiGet(`/api/coins?${params}`);
      if (!data.coins.length) {
        list.innerHTML = state.feedFollowingOnly
          ? `
          <div class="card empty">
            <h2>Belum ada coin dari kreator yang kamu ikuti</h2>
            <p>Kreator yang kamu ikuti belum membuat coin, atau filter ini aktif. Matikan filter "Mengikuti" untuk melihat semua coin.</p>
          </div>`
          : `
          <div class="card empty">
            <h2>Belum ada coin</h2>
            <p>Feed masih kosong — coin muncul setelah ada mint asli yang terverifikasi di devnet.</p>
            <p><a class="btn btn-primary" href="#/create">Jadi yang pertama membuat coin</a></p>
          </div>`;
        return;
      }
      list.innerHTML = `<div class="coin-grid">${data.coins.map(coinCard).join('')}</div>`;
      list.querySelectorAll('.coin-card').forEach((card) => {
        card.addEventListener('click', () => {
          location.hash = `#/coin/${card.dataset.mint}`;
        });
      });
      // Creator links inside cards must not trigger the card's navigation.
      list.querySelectorAll('.coin-card .addr-link').forEach((a) => {
        a.addEventListener('click', (e) => e.stopPropagation());
      });
    } catch (err) {
      list.innerHTML = `<div class="alert alert-error">Gagal memuat coin: ${esc(err.message)}</div>`;
    }
  }
}

function coinCard(c) {
  const chg = c.changePct >= 0 ? 'profit' : 'loss';
  return `
    <div class="card coin-card" data-mint="${esc(c.mintAddress)}">
      <div class="coin-head">
        ${logoHtml(c)}
        <div class="coin-id">
          <div class="coin-name">${esc(c.name)}</div>
          <div class="coin-ticker">$${esc(c.ticker)}</div>
          <div class="small muted">${esc(c.ticker)}/SOL</div>
        </div>
        ${c.tradingEnabled ? '' : '<span class="badge badge-warn">Trading nonaktif</span>'}
      </div>
      ${c.description ? `<p class="coin-desc">${esc(c.description)}</p>` : ''}
      <div class="coin-price"><b>${fmtPriceBoth(c.priceUsd, c.price)}</b> <span class="${chg}">${fmtPct(c.changePct)}</span></div>
      <div class="coin-stats">
        <span>Market cap <b>${fmtMarketCap(c)}</b></span>
        <span>Vol <b>${fmtSol(c.volumeSol)}</b></span>
      </div>
      <div class="progress" title="Progres kurva bonding: ${c.progressPct.toFixed(1)}%">
        <div style="width:${c.progressPct.toFixed(1)}%"></div>
      </div>
      <div class="small muted" style="margin-top:4px">Kurva bonding ${c.progressPct.toFixed(1)}% • ${c.txCount} tx • oleh ${creatorLink(c.creatorWallet)}</div>
    </div>`;
}

// ---------- Create coin ----------
async function renderCreate() {
  const view = document.getElementById('view');
  view.innerHTML = `
    <h1>Buat Coin</h1>
    <p class="muted">Minting asli di Solana devnet: suplai 1.000.000.000 token, 6 desimal, otoritas mint langsung dicabut. Nama, ticker, dan logo tersimpan di registry situs ini. Setelah mint, kamu akan diminta satu tanda tangan lagi untuk memindahkan 800.000.000 token ke dompet pool agar coin bisa diperdagangkan (200.000.000 token tetap di dompetmu).</p>
    <div id="pendingMintBox"></div>
    <div class="card">
      <div class="field">
        <label for="coinName">Nama coin</label>
        <input id="coinName" maxlength="32" placeholder="cth: SolPump Cat">
      </div>
      <div class="field">
        <label for="coinTicker">Ticker</label>
        <input id="coinTicker" maxlength="10" placeholder="cth: SPCAT">
        <div class="hint">Otomatis huruf besar, maksimal 10 karakter.</div>
      </div>
      <div class="field">
        <label for="coinDesc">Deskripsi (opsional)</label>
        <textarea id="coinDesc" rows="3" maxlength="500" placeholder="Ceritakan tentang coin-mu…"></textarea>
      </div>
      <div class="field">
        <label for="coinLogo">Logo (opsional, maks ~675 KB)</label>
        <input id="coinLogo" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
        <div id="logoPreview" style="margin-top:8px"></div>
      </div>
      <div id="walletStatus"></div>
      <div id="mintSteps"></div>
      <div id="mintError"></div>
      <div class="alert alert-info" style="margin-top:8px">
        <strong>⚠️ Phantom harus di jaringan Devnet.</strong> Website tidak bisa membaca atau mengubah jaringan Phantom.
        Buka Phantom → Pengaturan → Developer Settings → Testnet Mode → pilih <strong>Devnet</strong>.
        Kalau Phantom di Mainnet, minting akan gagal dengan "Failed to simulate" / "Not enough SOL" di Phantom
        meski saldo devnet-mu cukup — karena Phantom memeriksa jaringan yang salah.
      </div>
      <label class="check-row">
        <input type="checkbox" id="devnetConfirm">
        <span>Saya sudah memastikan Phantom di jaringan <strong>Devnet</strong> dan akun aktifnya adalah akun yang punya SOL devnet.</span>
      </label>
      <button class="btn btn-primary" id="mintBtn" style="margin-top:8px">Buat Coin &amp; Mint di Devnet</button>
    </div>`;

  const tickerInput = document.getElementById('coinTicker');
  tickerInput.addEventListener('input', () => {
    tickerInput.value = tickerInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  let logoData = null;
  const logoInput = document.getElementById('coinLogo');
  logoInput.addEventListener('change', () => {
    const file = logoInput.files[0];
    logoData = null;
    const preview = document.getElementById('logoPreview');
    if (!file) {
      preview.innerHTML = '';
      return;
    }
    if (file.size > 675000) {
      preview.innerHTML = '<p class="loss small">File terlalu besar (maks ~675 KB).</p>';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const [meta, base64] = String(reader.result).split(',');
      logoData = { dataBase64: base64, mimeType: file.type };
      preview.innerHTML = `<img src="${esc(reader.result)}" alt="Pratinjau logo" style="width:64px;height:64px;border-radius:50%;object-fit:cover">`;
    };
    reader.readAsDataURL(file);
  });

  renderPendingMint();
  updateWalletStatus();
  document.getElementById('mintBtn').addEventListener('click', () => doMint(logoData));

  // A mint that landed on-chain but failed to register: offer a retry
  // instead of making the user mint (and pay rent) all over again.
  function renderPendingMint() {
    const box = document.getElementById('pendingMintBox');
    const pending = loadPendingMint();
    if (!pending) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = `
      <div class="card" style="border-color:var(--gold)">
        <h2 style="margin-top:0">Mint tertunda: $${esc(pending.ticker)}</h2>
        <p>Coin ini <strong>sudah berhasil di-mint di devnet</strong> (${esc(shortAddr(pending.mintAddress))}), tapi pendaftarannya gagal: ${esc(pending.error || 'tidak diketahui')}. Kamu tidak perlu mint ulang — coba daftarkan lagi.</p>
        <p>
          <button class="btn btn-primary" id="retryRegisterBtn">Coba daftarkan lagi</button>
          <button class="btn" id="dropPendingBtn">Buang</button>
        </p>
      </div>`;
    document.getElementById('retryRegisterBtn').onclick = async () => {
      const btn = document.getElementById('retryRegisterBtn');
      btn.disabled = true;
      try {
        await apiPost('/api/coins/register', {
          mintAddress: pending.mintAddress,
          name: pending.name,
          ticker: pending.ticker,
          description: pending.description,
          creatorWallet: pending.creatorWallet,
          txSignature: pending.txSignature,
          fundingTxSignature: pending.fundingTxSignature || undefined,
          image: pending.image || undefined,
        });
        savePendingMint(null);
        toast(`Coin $${pending.ticker} berhasil didaftarkan!`);
        location.hash = `#/coin/${pending.mintAddress}`;
      } catch (err) {
        toast(`Pendaftaran masih gagal: ${err.message}`);
        btn.disabled = false;
      }
    };
    document.getElementById('dropPendingBtn').onclick = () => {
      savePendingMint(null);
      renderPendingMint();
    };
  }

  async function updateWalletStatus() {
    const el = document.getElementById('walletStatus');
    // Re-detect on every render: the extension can inject late, and the
    // cached value from page load may be stale.
    const detected = getPhantom();
    if (!detected) {
      el.innerHTML = `
        <div class="alert alert-info">
          <strong>Phantom tidak terdeteksi.</strong> Instal ekstensi Phantom di browser ini untuk membuat coin.
          <div class="small" style="margin-top:6px">Di HP: ekstensi tidak tersedia — buka situs ini dari <strong>browser di dalam aplikasi Phantom</strong>.</div>
          <div style="margin-top:8px">
            <a class="btn btn-sm" href="https://phantom.app/" target="_blank" rel="noopener">Unduh Phantom</a>
            <button class="btn btn-sm" id="recheckPhantom">Periksa lagi</button>
          </div>
        </div>`;
      document.getElementById('recheckPhantom').onclick = () => updateWalletStatus();
      return;
    }
    if (!state.wallet) {
      el.innerHTML = `
        <div class="alert alert-info">
          <strong>Dompet belum terhubung.</strong> Hubungkan Phantom dulu.
          <div class="small" style="margin-top:6px">Pastikan Phantom di jaringan <strong>Devnet</strong>: buka Phantom → Pengaturan → Developer Settings → Testnet Mode → pilih Devnet. Website tidak bisa mengubah jaringan Phantom secara otomatis — kalau Phantom di Mainnet, minting akan gagal dengan "Failed to simulate" / "Not enough SOL".</div>
          <div style="margin-top:8px"><button class="btn btn-sm btn-primary" id="connectFromCreate">Hubungkan Phantom</button></div>
        </div>`;
      document.getElementById('connectFromCreate').onclick = connectWallet;
      return;
    }
    // Fresh balance + exact mint cost, right now — never trust the value
    // from connect time (the user may have just topped up at the faucet).
    let bal = state.balanceSol;
    let cost = null;
    if (solanaLibsReady()) {
      try {
        bal = await getDevnetBalanceSol(state.wallet);
        state.balanceSol = bal;
        cost = await getMintCostSol();
      } catch {
        // Keep the cached balance; the mint flow will surface the RPC error.
      }
    }
    const need = cost ? cost.totalSol : 0.01;
    const low = bal !== null && bal < need;
    el.innerHTML = `
      <div class="alert ${low ? 'alert-error' : 'alert-success'}">
        <strong>Dompet:</strong> <span class="mono">${esc(state.wallet)}</span><br>
        <strong>Saldo devnet:</strong> ${bal === null ? '…' : `${fmtSol(bal)} SOL`}
        ${cost ? `• Butuh ~${fmtSol(need)} SOL untuk minting (sewa akun ${fmtSol(cost.mintRentSol + cost.ataRentSol)} + biaya)` : ''}
        ${low ? `<br>Saldo kurang ${fmtSol(need - bal)} SOL. Ambil SOL devnet gratis di <a href="https://faucet.solana.com" target="_blank" rel="noopener">faucet.solana.com</a>, lalu periksa ulang saldo di bawah.` : ''}
        <div style="margin-top:8px"><button class="btn btn-sm" id="refreshBalBtn">Periksa ulang saldo</button></div>
      </div>
      <div class="alert alert-info">
        <strong>Jaringan:</strong> pastikan Phantom di <strong>Devnet</strong> sebelum mint (Pengaturan → Developer Settings → Testnet Mode → Devnet). Kalau Phantom di Mainnet, minting akan gagal dengan "Failed to simulate" / "Not enough SOL" — Phantom memeriksa saldo Mainnet-mu, bukan saldo devnet.
      </div>`;
    document.getElementById('refreshBalBtn').onclick = () => updateWalletStatus();
  }

  async function doMint(logo) {
    const name = document.getElementById('coinName').value.trim();
    const ticker = document.getElementById('coinTicker').value.trim();
    const description = document.getElementById('coinDesc').value.trim();
    const errEl = document.getElementById('mintError');
    const stepsEl = document.getElementById('mintSteps');
    const btn = document.getElementById('mintBtn');
    errEl.innerHTML = '';
    const fail = (msg) => {
      errEl.innerHTML = `<div class="alert alert-error">${msg}</div>`;
      stepsEl.innerHTML = '';
      btn.disabled = false;
    };

    if (!name || !ticker) {
      fail('Nama dan ticker wajib diisi.');
      return;
    }
    if (!document.getElementById('devnetConfirm').checked) {
      fail('Centang dulu konfirmasi Devnet di atas — pastikan Phantom di jaringan Devnet sebelum minting, supaya tidak gagal dengan "Failed to simulate".');
      return;
    }
    if (!solanaLibsReady()) {
      fail('Library Solana gagal dimuat. Muat ulang halaman dan coba lagi.');
      return;
    }
    // Re-detect Phantom fresh (late injection) and re-check everything
    // right now — never trust connect-time state.
    const phantom = (await waitForPhantom(3000)) || getPhantom();
    if (!phantom) {
      fail('Phantom tidak terdeteksi. Instal ekstensi Phantom (di HP, buka situs ini dari browser di dalam aplikasi Phantom).');
      return;
    }
    if (!state.wallet) {
      fail('Hubungkan dompet Phantom dulu.');
      return;
    }
    // Sync with the account currently active in Phantom: the user may have
    // switched accounts since connecting, and Phantom signs with the active
    // one — checking the old account's balance would let a doomed mint
    // through to the popup.
    const synced = await syncWalletAccount();
    if (!synced) {
      fail('Tidak bisa membaca akun aktif di Phantom. Buka Phantom dan coba lagi.');
      return;
    }

    const steps = [
      'Memeriksa dompet & saldo',
      'Membangun + simulasi transaksi mint',
      'Tanda tangan mint di Phantom',
      'Mengirim & konfirmasi mint',
      'Transfer 800M token ke pool (funding)',
      'Memverifikasi & mendaftarkan coin',
    ];
    const paint = (activeIdx, doneUntil) => {
      stepsEl.innerHTML = `<ul class="steps">${steps
        .map((s, i) => {
          const cls = i <= doneUntil ? 'done' : i === activeIdx ? 'active' : 'pending';
          const mark = i <= doneUntil ? '✓' : i === activeIdx ? '…' : '○';
          return `<li class="${cls}"><span>${mark}</span><span>${esc(s)}</span></li>`;
        })
        .join('')}</ul>`;
    };
    btn.disabled = true;

    let mintAddress = null;
    let mintSignature = null;
    let fundingSignature = null;
    try {
      // 0. Fresh balance + exact cost + devnet endpoint check.
      paint(0, -1);
      let cost;
      try {
        const [bal, c, rpcOk] = await Promise.all([
          getDevnetBalanceSol(state.wallet),
          getMintCostSol(),
          verifyDevnetRpc(),
        ]);
        state.balanceSol = bal;
        cost = c;
        if (!rpcOk) throw new Error('Endpoint RPC bukan devnet — laporkan ke pengelola situs.');
      } catch (err) {
        fail(`Gagal memeriksa dompet: ${esc(friendlyError(err))}`);
        return;
      }
      // Mint + funding need rent for the mint, two ATAs, and fees.
      const needTotal = cost.totalSol + 0.003;
      if (state.balanceSol < needTotal) {
        fail(
          `Saldo devnet ${fmtSol(state.balanceSol)} SOL kurang dari ~${fmtSol(needTotal)} SOL yang dibutuhkan (mint + funding). Ambil SOL gratis di <a href="https://faucet.solana.com" target="_blank" rel="noopener">faucet.solana.com</a>, lalu periksa ulang saldo di atas.`
        );
        return;
      }

      // 1. Build the mint transaction and simulate it BEFORE signing.
      paint(1, 0);
      const built = await buildMintTransaction(state.wallet);
      mintAddress = built.mintAddress;
      const sim = await simulateTransaction(built.transaction);
      if (!sim.ok) {
        fail(`Transaksi mint tidak lolos simulasi devnet — belum ada yang ditandatangani.<br><span class="mono small">${esc(sim.error)}</span>`);
        return;
      }

      // 2-3. Sign with Phantom (fresh blockhash) and broadcast.
      paint(2, 1);
      mintSignature = await signAndSendMint(phantom, built.transaction, built.mintKeypair);
      paint(3, 2);
      // The mint is confirmed on-chain — re-read the balance now so the
      // header shows the rent + fees actually spent.
      await refreshBalance();
      renderHeader();

      // 4. Funding: move 800M tokens to the pool so the coin can trade.
      // Skippable — without it the coin still lists, but trading is off.
      paint(4, 3);
      const poolAddress = await loadPoolAddress();
      if (poolAddress) {
        try {
          // Re-check the balance after the mint: the mint just spent rent
          // + fees, and funding needs its own ATA rent + fee. Never open
          // a Phantom popup for a funding tx that cannot pay its fee.
          const balAfterMint = await getDevnetBalanceSol(state.wallet);
          state.balanceSol = balAfterMint;
          const fundingNeed = 0.003; // pool ATA rent (~0.002 SOL) + fee buffer
          if (balAfterMint < fundingNeed) {
            throw new Error(
              `Saldo devnet tersisa ${fmtSol(balAfterMint)} SOL setelah mint — kurang dari ~${fmtSol(fundingNeed)} SOL untuk funding. Ambil SOL gratis di faucet.solana.com, lalu funding dari halaman coin.`
            );
          }
          const funding = await buildFundingTransaction(state.wallet, mintAddress, poolAddress);
          const fundSim = await simulateTransaction(funding.transaction);
          if (!fundSim.ok) throw new Error(fundSim.error);
          fundingSignature = await signAndSend(phantom, funding.transaction);
          await refreshBalance();
          renderHeader();
        } catch (fundErr) {
          // Ask instead of failing the whole mint: the coin exists on-chain.
          const skip = window.confirm(
            `Transfer funding 800M token ke pool gagal (${friendlyError(fundErr)}).\n\n` +
              'Klik OK untuk tetap mendaftarkan coin TANPA trading (bisa di-funding nanti dari halaman coin), atau Batal untuk berhenti di sini.'
          );
          if (!skip) {
            fail(
              `Mint berhasil on-chain (${txLink(mintSignature)}), tapi funding dibatalkan. Coin belum terdaftar — kamu bisa mendaftarkannya nanti dengan tombol di bawah setelah funding berhasil.`
            );
            savePendingMint({
              mintAddress,
              name,
              ticker,
              description,
              creatorWallet: state.wallet,
              txSignature: mintSignature,
              fundingTxSignature: null,
              image: logo,
              error: 'funding dibatalkan',
            });
            renderPendingMint();
            return;
          }
          fundingSignature = null;
        }
      }

      // 5. Register (server verifies mint + funding on-chain).
      paint(5, 4);
      try {
        await apiPost('/api/coins/register', {
          mintAddress,
          name,
          ticker,
          description,
          creatorWallet: state.wallet,
          txSignature: mintSignature,
          fundingTxSignature: fundingSignature || undefined,
          image: logo,
        });
      } catch (regErr) {
        // The mint is on-chain — save it so the user can retry registration
        // without minting again.
        savePendingMint({
          mintAddress,
          name,
          ticker,
          description,
          creatorWallet: state.wallet,
          txSignature: mintSignature,
          fundingTxSignature: fundingSignature || null,
          image: logo,
          error: regErr.message,
        });
        renderPendingMint();
        fail(
          `Mint berhasil on-chain (${txLink(mintSignature)}), tapi pendaftaran gagal: ${esc(regErr.message)}. Gunakan tombol "Coba daftarkan lagi" di atas — tidak perlu mint ulang.`
        );
        return;
      }
      savePendingMint(null);
      paint(5, 5);
      toast(`Coin $${ticker} berhasil dibuat!`);
      location.hash = `#/coin/${mintAddress}`;
    } catch (err) {
      fail(`Mint gagal: ${esc(friendlyError(err))}`);
    }
  }
}

// ---------- Coin detail ----------
async function renderCoin(mintAddress) {
  const view = document.getElementById('view');
  view.innerHTML = '<p class="muted">Memuat coin…</p>';
  let data;
  try {
    const params = state.wallet ? `?wallet=${encodeURIComponent(state.wallet)}` : '';
    data = await apiGet(`/api/coins/${mintAddress}${params}`);
  } catch (err) {
    view.innerHTML = `<div class="alert alert-error">Gagal memuat coin: ${esc(err.message)}</div>
      <p><a href="#/">Kembali ke Beranda</a></p>`;
    return;
  }
  state.coinCache = data;
  const { coin, stats, chart, trades, feeClaims, creatorFees, creatorFeePct, viewerFollowsCreator, callouts, walletPnl, walletTrades, solUsd } = data;
  const chg = stats.changePct >= 0 ? 'profit' : 'loss';
  const isCreator = state.wallet && state.wallet === coin.creatorWallet;

  view.innerHTML = `
    <div class="card">
      <div class="coin-head">
        ${logoHtml(coin)}
        <div>
          <div class="coin-name" style="font-size:1.3rem">${esc(coin.name)} <span class="muted">$${esc(coin.ticker)}</span></div>
          <div class="small muted">${esc(coin.ticker)}/SOL • Dibuat ${fmtDate(coin.createdAt)} oleh ${creatorLink(coin.creatorWallet)}</div>
        </div>
        <span class="badge badge-ok" style="margin-left:auto">✓ Terverifikasi on-chain</span>
        ${coin.tradingEnabled ? '' : '<span class="badge badge-warn">Trading nonaktif</span>'}
        ${state.wallet && !isCreator
          ? `<button class="btn btn-sm" id="followCreatorBtn">${viewerFollowsCreator ? '✓ Mengikuti' : '+ Ikuti kreator'}</button>`
          : ''}
      </div>
      ${coin.description ? `<p>${esc(coin.description)}</p>` : ''}
      ${coin.tradingEnabled ? '' : `
      <div class="alert alert-info" id="fundingBox">
        <strong>Trading belum aktif.</strong> Kreator belum memindahkan 800.000.000 token ke dompet pool, jadi coin ini belum bisa diperdagangkan.
        ${state.wallet === coin.creatorWallet ? '<div style="margin-top:8px"><button class="btn btn-sm btn-primary" id="fundPoolBtn">Fund pool sekarang (800M token)</button></div><div id="fundResult"></div>' : ''}
      </div>`}
      <div class="proof">
        <div class="row"><span class="k">Alamat mint</span>
          <span class="mono">${esc(shortAddr(coin.mintAddress))}</span>
          <button class="btn btn-sm btn-ghost" data-copy="${esc(coin.mintAddress)}">Salin</button>
          <a href="${EXPLORER}/address/${esc(coin.mintAddress)}?cluster=devnet" target="_blank" rel="noopener">Explorer ↗</a>
        </div>
        <div class="row"><span class="k">Transaksi mint</span>
          <span class="mono">${esc(shortAddr(coin.txSignature))}</span>
          <a href="${EXPLORER}/tx/${esc(coin.txSignature)}?cluster=devnet" target="_blank" rel="noopener">Explorer ↗</a>
        </div>
      </div>
    </div>

    <div class="card" id="feeCard">
      <h2 style="margin-top:0">Fee Kreator <span class="badge badge-ok">${creatorFeePct}% dari setiap trade</span></h2>
      <div class="stat-grid">
        <div class="stat"><div class="label">Total fee terkumpul</div><div class="value">${fmtSol(creatorFees.totalEarnedSol)} SOL</div></div>
        <div class="stat"><div class="label">Sudah diklaim</div><div class="value">${fmtSol(creatorFees.totalClaimedSol)} SOL</div></div>
        <div class="stat"><div class="label">Bisa diklaim</div><div class="value">${fmtSol(creatorFees.unclaimedSol)} SOL</div></div>
      </div>
      ${isCreator
        ? `<div style="margin-top:12px">
            <button class="btn btn-primary" id="claimFeesBtn" ${creatorFees.unclaimedSol > 0 ? '' : 'disabled'}>Klaim ${fmtSol(creatorFees.unclaimedSol)} SOL</button>
            <div id="claimResult" style="margin-top:8px"></div>
            <p class="small muted">Fee dikirim dari dompet pool ke dompetmu sebagai transaksi devnet asli. Klaim tercatat di riwayat transaksi.</p>
          </div>`
        : `<p class="small muted" style="margin-top:12px">1% dari volume SOL setiap beli dan jual masuk ke kreator ${creatorLink(coin.creatorWallet)}.</p>`}
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
        <h2 style="margin:0">Grafik Harga</h2>
        <div style="text-align:right"><span style="font-size:1.2rem;font-weight:800">${fmtPriceBoth(stats.priceUsd, stats.price)}</span>
        <span class="${chg}"> ${fmtPct(stats.changePct)}</span>
        <div class="small muted">Market Cap <b style="color:var(--text)">${fmtMarketCap(stats)}</b></div></div>
      </div>
      <div class="range-btns" style="margin-top:12px">
        ${[0, 10, 25, 50]
          .map(
            (n) =>
              `<button class="btn btn-sm ${state.chartRange === n ? 'active' : ''}" data-range="${n}">${
                n === 0 ? 'Semua' : `${n} tx`
              }</button>`
          )
          .join('')}
      </div>
      <div class="chart-wrap" id="chartWrap"></div>
    </div>

    <div class="card">
      <div class="stat-grid">
        <div class="stat"><div class="label">Market Cap</div><div class="value">${fmtMarketCap(stats)}</div></div>
        <div class="stat"><div class="label">Perubahan</div><div class="value ${chg}">${fmtPct(stats.changePct)}</div></div>
        <div class="stat"><div class="label">Tertinggi</div><div class="value">${fmtPriceBoth(stats.highUsd, stats.high)}</div></div>
        <div class="stat"><div class="label">Terendah</div><div class="value">${fmtPriceBoth(stats.lowUsd, stats.low)}</div></div>
        <div class="stat"><div class="label">Volume</div><div class="value">${fmtSol(stats.volumeSol)} SOL</div></div>
        <div class="stat"><div class="label">Fee Kreator Terkumpul</div><div class="value">${fmtSol(stats.totalFeesSol)} SOL</div></div>
        <div class="stat"><div class="label">Transaksi</div><div class="value">${stats.txCount}</div></div>
        <div class="stat"><div class="label">Trader Unik</div><div class="value">${stats.uniqueTraders}</div></div>
        <div class="stat"><div class="label">Suplai</div><div class="value">1.000.000.000</div></div>
      </div>
      <div style="margin-top:14px">
        <div class="small muted">Kurva bonding: ${stats.progressPct.toFixed(1)}% menuju kelulusan (85 SOL)</div>
        <div class="progress"><div style="width:${stats.progressPct.toFixed(1)}%"></div></div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card trade-box">
        <h2 style="margin-top:0">Beli / Jual <span class="badge badge-live">DEVNET ASLI</span></h2>
        <p class="small muted">Trading asli di devnet: SOL dan token beneran berpindah on-chain lewat dompet pool kustodian (<span id="tradePoolAddr">…</span>). Devnet hanya untuk percobaan — SOL di sini token testnet gratis tanpa nilai uang.</p>
        <p class="small"><b>${creatorFeePct}% creator fee</b> dari volume SOL setiap trade masuk ke kreator ${creatorLink(coin.creatorWallet)} — saat beli sudah termasuk dalam SOL yang kamu bayar, saat jual dipotong dari SOL yang kamu terima.</p>
        <div class="tabs">
          <button class="btn btn-sm ${state.tradeSide === 'buy' ? 'active' : ''}" data-side="buy">Beli</button>
          <button class="btn btn-sm ${state.tradeSide === 'sell' ? 'active' : ''}" data-side="sell">Jual</button>
        </div>
        <div id="tradeForm"></div>
        <div id="tradeResult"></div>
      </div>
      <div class="card" id="pnlCard"></div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Riwayat Transaksi</h2>
      <div class="tabs">
        ${['Semua', 'Beli', 'Jual', 'Punyaku']
          .map((t) => `<button class="btn btn-sm ${state.tradeTab === t ? 'active' : ''}" data-tab="${t}">${t}</button>`)
          .join('')}
      </div>
      <div class="table-wrap" id="tradesTable"></div>
    </div>

    <div class="card" id="calloutsCard">
      <h2 style="margin-top:0">Callout (${(callouts || []).length})</h2>
      <p class="small muted">Post singkat dari trader yang benar-benar membeli coin ini — entry price dan holdings dihitung dari transaksi devnet asli mereka, PnL-nya live mengikuti harga.</p>
      <div id="calloutForm"></div>
      <div id="calloutList">
        ${(callouts || []).length === 0
          ? '<p class="muted">Belum ada callout untuk coin ini.</p>'
          : (callouts || []).map((c) => calloutHtml(c)).join('')}
      </div>
    </div>`;

  // Copy buttons
  view.querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Disalin.'));
    });
  });

  // Follow/unfollow the creator from the coin page.
  const followBtn = document.getElementById('followCreatorBtn');
  if (followBtn) {
    followBtn.addEventListener('click', async () => {
      followBtn.disabled = true;
      await toggleFollow(coin.creatorWallet, viewerFollowsCreator);
      renderCoin(mintAddress);
    });
  }

  // Creator claims accrued fees from the pool wallet.
  const claimBtn = document.getElementById('claimFeesBtn');
  if (claimBtn) {
    claimBtn.addEventListener('click', async () => {
      const resEl = document.getElementById('claimResult');
      claimBtn.disabled = true;
      resEl.innerHTML = '<p class="muted">Mengirim klaim dari pool…</p>';
      try {
        const res = await apiPost(`/api/coins/${coin.mintAddress}/claim-fees`, {
          wallet: state.wallet,
        });
        resEl.innerHTML = `<div class="alert alert-success">Berhasil mengklaim ${fmtSol(res.claim.amountSol)} SOL! Transaksi: ${txLink(res.claim.txSignature)}</div>`;
        await refreshBalance();
        renderHeader();
        setTimeout(() => renderCoin(mintAddress), 1200);
      } catch (err) {
        resEl.innerHTML = `<div class="alert alert-error">Klaim gagal: ${esc(friendlyError(err))}</div>`;
        claimBtn.disabled = false;
      }
    });
  }

  // Pool address in the trade panel disclosure.
  loadPoolAddress().then(() => {
    const el = document.getElementById('tradePoolAddr');
    if (el && state.poolAddress) {
      el.innerHTML = `<a class="mono" href="${EXPLORER}/address/${esc(state.poolAddress)}?cluster=devnet" target="_blank" rel="noopener">${esc(shortAddr(state.poolAddress))} ↗</a>`;
    } else if (el) {
      el.textContent = 'tidak tersedia';
    }
  });

  // Creator funding: enable trading later for an unfunded coin.
  const fundBtn = document.getElementById('fundPoolBtn');
  if (fundBtn) {
    fundBtn.addEventListener('click', async () => {
      const resEl = document.getElementById('fundResult');
      fundBtn.disabled = true;
      try {
        if (!solanaLibsReady()) throw new Error('Library Solana gagal dimuat.');
        const phantom = (await waitForPhantom(3000)) || getPhantom();
        if (!phantom) throw new Error('Phantom tidak terdeteksi.');
        // Sync with the account currently active in Phantom, then check
        // its fresh devnet balance against the funding cost (pool ATA rent
        // + fee) — never open a popup for a tx that cannot pay its fee.
        if (!(await syncWalletAccount())) {
          throw new Error('Tidak bisa membaca akun aktif di Phantom.');
        }
        if (state.balanceSol !== null && state.balanceSol < 0.003) {
          throw new Error(
            `Saldo devnet ${fmtSol(state.balanceSol)} SOL kurang dari ~0,003 SOL untuk funding. Ambil SOL gratis di faucet.solana.com.`
          );
        }
        const poolAddress = await loadPoolAddress();
        if (!poolAddress) throw new Error('Alamat pool tidak tersedia.');
        resEl.innerHTML = '<p class="muted">Membangun transaksi funding…</p>';
        const funding = await buildFundingTransaction(state.wallet, coin.mintAddress, poolAddress);
        const sim = await simulateTransaction(funding.transaction);
        if (!sim.ok) throw new Error(sim.error);
        resEl.innerHTML = '<p class="muted">Tanda tangani transfer funding di Phantom…</p>';
        const sig = await signAndSend(phantom, funding.transaction);
        await refreshBalance();
        renderHeader();
        resEl.innerHTML = '<p class="muted">Memverifikasi funding on-chain…</p>';
        await apiPost(`/api/coins/${coin.mintAddress}/fund`, { fundingTxSignature: sig });
        toast('Pool ter-funding — trading aktif!');
        renderCoin(mintAddress);
      } catch (err) {
        resEl.innerHTML = `<div class="alert alert-error">Funding gagal: ${esc(friendlyError(err))}</div>`;
        fundBtn.disabled = false;
      }
    });
  }

  // Chart range buttons
  view.querySelectorAll('[data-range]').forEach((b) => {
    b.addEventListener('click', () => {
      state.chartRange = Number(b.dataset.range);
      renderCoin(mintAddress);
    });
  });

  // Trade side tabs
  view.querySelectorAll('[data-side]').forEach((b) => {
    b.addEventListener('click', () => {
      state.tradeSide = b.dataset.side;
      renderCoin(mintAddress);
    });
  });

  // Trade filter tabs
  view.querySelectorAll('[data-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      state.tradeTab = b.dataset.tab;
      renderTradesTable();
      view.querySelectorAll('[data-tab]').forEach((x) =>
        x.classList.toggle('active', x.dataset.tab === state.tradeTab)
      );
    });
  });

  renderChartEl(document.getElementById('chartWrap'), chart, state.chartRange);
  // Live on-chain balances before the trade form renders (MAX uses them).
  await refreshOnchainBalances();
  renderTradeForm();
  renderPnlCard();
  renderTradesTable();
  renderCalloutForm();

  // Callout form: only wallets with a real buy of this coin may post
  // (the server re-verifies from the trade records).
  function renderCalloutForm() {
    const form = document.getElementById('calloutForm');
    if (!state.wallet) {
      form.innerHTML = `<p class="muted">Hubungkan dompet untuk membuat callout.</p>`;
      return;
    }
    const hasBuy = (walletTrades || []).some((t) => t.side === 'buy');
    if (!hasBuy) {
      form.innerHTML = `<p class="muted">Kamu belum membeli coin ini — beli dulu untuk membuat callout (hanya pembeli terverifikasi yang bisa posting).</p>`;
      return;
    }
    form.innerHTML = `
      <div class="field">
        <textarea id="calloutText" rows="2" maxlength="280" placeholder="Call coin ini… (maks 280 karakter)"></textarea>
        <div class="small muted" style="text-align:right"><span id="calloutCount">0</span>/280</div>
      </div>
      <button class="btn btn-primary" id="postCalloutBtn">Posting Callout</button>
      <div id="calloutResult" style="margin-top:8px"></div>`;
    const input = document.getElementById('calloutText');
    const count = document.getElementById('calloutCount');
    input.addEventListener('input', () => {
      count.textContent = input.value.length;
    });
    document.getElementById('postCalloutBtn').addEventListener('click', async () => {
      const text = input.value.trim();
      const resEl = document.getElementById('calloutResult');
      const btn = document.getElementById('postCalloutBtn');
      if (!text) {
        toast('Tulis callout-mu dulu.');
        return;
      }
      btn.disabled = true;
      try {
        await apiPost(`/api/coins/${coin.mintAddress}/callouts`, {
          wallet: state.wallet,
          text,
        });
        toast('Callout diposting!');
        renderCoin(mintAddress);
      } catch (err) {
        resEl.innerHTML = `<div class="alert alert-error">Gagal posting: ${esc(friendlyError(err))}</div>`;
        btn.disabled = false;
      }
    });
  }

  function renderTradeForm() {
    const form = document.getElementById('tradeForm');
    const pnl = walletPnl;
    // Live on-chain holdings (the user may also hold minted tokens, which
    // the trade history does not know about).
    const liveHoldings = state.onchainBalances[coin.mintAddress] || 0;
    if (!coin.tradingEnabled) {
      form.innerHTML = `<p class="muted">Trading belum aktif untuk coin ini — kreator belum memindahkan 800.000.000 token ke pool.</p>`;
      return;
    }
    if (!state.wallet) {
      form.innerHTML = `<p class="muted">Hubungkan dompet Phantom untuk trading di devnet.</p>
        <button class="btn btn-primary" id="connectTrade">Hubungkan Phantom</button>`;
      document.getElementById('connectTrade').onclick = connectWallet;
      return;
    }
    if (state.tradeSide === 'buy') {
      form.innerHTML = `
        <div class="field">
          <label>Jumlah SOL</label>
          <input id="buySol" type="number" min="0" step="0.01" placeholder="0.5">
          <div class="quick">
            ${[0.1, 0.5, 1, 5].map((v) => `<button class="btn" data-quick="${v}">${v} SOL</button>`).join('')}
          </div>
          <div class="estimate" id="buyEstimate"></div>
        </div>
        <button class="btn btn-buy" id="buyBtn">Beli $${esc(coin.ticker)}</button>
        <p class="small muted" style="margin-top:8px">Kamu akan menandatangani transfer SOL asli ke dompet pool, lalu pool mengirim token ke dompetmu.</p>`;
      const input = document.getElementById('buySol');
      const update = () => {
        const sol = Number(input.value);
        const est = document.getElementById('buyEstimate');
        if (sol > 0) {
          const tokens = (coin.tokenReserve * sol) / (coin.solReserve + sol);
          const fee = (sol * creatorFeePct) / 100;
          const execSol = sol / tokens;
          const execUsd = Number.isFinite(solUsd) ? execSol * solUsd : null;
          est.textContent = `≈ ${fmtTokens(tokens)} ${coin.ticker} (harga eksekusi ≈ ${fmtPriceBoth(execUsd, execSol)}) • Fee kreator ${creatorFeePct}%: ${fmtSol(fee)} SOL`;
        } else est.textContent = '';
      };
      input.addEventListener('input', update);
      form.querySelectorAll('[data-quick]').forEach((b) => {
        b.addEventListener('click', () => {
          input.value = b.dataset.quick;
          update();
        });
      });
      document.getElementById('buyBtn').addEventListener('click', async () => {
        const sol = Number(input.value);
        if (!(sol > 0)) return toast('Masukkan jumlah SOL.');
        await submitTrade('buy', { solAmount: sol });
      });
    } else {
      form.innerHTML = `
        <div class="field">
          <label>Jumlah ${esc(coin.ticker)}</label>
          <input id="sellTokens" type="number" min="0" step="any" placeholder="1000000">
          <div class="quick">
            <button class="btn" id="maxSell">MAX (${fmtTokens(liveHoldings)})</button>
          </div>
          <div class="estimate" id="sellEstimate"></div>
        </div>
        <button class="btn btn-sell" id="sellBtn">Jual $${esc(coin.ticker)}</button>
        <p class="small muted" style="margin-top:8px">Kamu akan menandatangani transfer token asli ke dompet pool, lalu pool mengirim SOL ke dompetmu.</p>`;
      const input = document.getElementById('sellTokens');
      const update = () => {
        const tokens = Number(input.value);
        const est = document.getElementById('sellEstimate');
        if (tokens > 0) {
          const sol = (coin.solReserve * tokens) / (coin.tokenReserve + tokens);
          const fee = (sol * creatorFeePct) / 100;
          const execSol = sol / tokens;
          const execUsd = Number.isFinite(solUsd) ? execSol * solUsd : null;
          est.textContent = `≈ ${fmtSol(sol - fee)} SOL diterima setelah fee kreator ${creatorFeePct}% (${fmtSol(fee)} SOL) • Harga eksekusi ≈ ${fmtPriceBoth(execUsd, execSol)}`;
        } else est.textContent = '';
      };
      input.addEventListener('input', update);
      document.getElementById('maxSell').addEventListener('click', () => {
        input.value = liveHoldings;
        update();
      });
      document.getElementById('sellBtn').addEventListener('click', async () => {
        const tokens = Number(input.value);
        if (!(tokens > 0)) return toast('Masukkan jumlah token.');
        await submitTrade('sell', { tokenAmount: tokens });
      });
    }
    if (pnl && pnl.totalTrades > 0) {
      const pnlUsd = Number.isFinite(pnl.totalPnlUsd)
        ? `${fmtSignedUsd(pnl.totalPnlUsd)} <span class="muted">(${fmtSignedSol(pnl.totalPnlSol)})</span>`
        : fmtSignedSol(pnl.totalPnlSol);
      form.insertAdjacentHTML(
        'beforeend',
        `<p class="small" style="margin-top:10px">Saldo on-chain: <b>${fmtTokens(liveHoldings)} ${esc(
          coin.ticker
        )}</b> • PnL <b class="${pnl.totalPnlSol >= 0 ? 'profit' : 'loss'}">${pnlUsd} (${fmtPct(
          pnl.roiPct
        )})</b></p>`
      );
    }
  }

  // Real trade flow: prepare (quote + balance pre-checks, server-side) ->
  // build the user's leg -> simulate -> sign in Phantom -> send + confirm
  // -> server verifies the leg on-chain, completes the pool leg, records.
  async function submitTrade(side, amounts) {
    const resEl = document.getElementById('tradeResult');
    const btn = document.getElementById(side === 'buy' ? 'buyBtn' : 'sellBtn');
    const setBusy = (msg) => {
      if (btn) btn.disabled = true;
      resEl.innerHTML = `<p class="muted">${esc(msg)}</p>`;
    };
    const fail = (msg) => {
      if (btn) btn.disabled = false;
      resEl.innerHTML = `<div class="alert alert-error">${msg}</div>`;
    };
    try {
      if (!solanaLibsReady()) throw new Error('Library Solana gagal dimuat. Muat ulang halaman.');
      const phantom = (await waitForPhantom(3000)) || getPhantom();
      if (!phantom) throw new Error('Phantom tidak terdeteksi.');
      // Sync with the account currently active in Phantom so the quote and
      // balance checks apply to the account that will actually sign.
      if (!(await syncWalletAccount())) {
        throw new Error('Tidak bisa membaca akun aktif di Phantom.');
      }
      const poolAddress = await loadPoolAddress();
      if (!poolAddress) throw new Error('Alamat pool tidak tersedia.');

      // 1. Prepare: quote + pool/user balance checks BEFORE signing.
      setBusy('Memeriksa kuota & saldo pool…');
      const prepared = await apiPost('/api/trades/prepare', {
        mintAddress: coin.mintAddress,
        wallet: state.wallet,
        side,
        ...amounts,
      });

      // 2. Build the user's leg and simulate it before asking to sign.
      setBusy('Membangun transaksi…');
      const built =
        side === 'buy'
          ? await buildBuyTransaction(state.wallet, coin.mintAddress, poolAddress, prepared.solAmount)
          : await buildSellTransaction(state.wallet, coin.mintAddress, poolAddress, prepared.tokenAmount);
      const sim = await simulateTransaction(built.transaction);
      if (!sim.ok) throw new Error(`Simulasi gagal: ${sim.error}`);

      // 3. Sign + send + confirm the user's leg.
      setBusy('Tanda tangani transaksi di Phantom…');
      const userSig = await signAndSend(phantom, built.transaction);

      // 4. Server verifies the leg on-chain, completes the pool leg, records.
      setBusy('Memverifikasi & menyelesaikan trade…');
      const res = await apiPost(`/api/trades/${side}`, {
        mintAddress: coin.mintAddress,
        wallet: state.wallet,
        ...(side === 'buy' ? { solAmount: prepared.solAmount } : { tokenAmount: prepared.tokenAmount }),
        userTxSignature: userSig,
      });
      const receivedNote =
        side === 'sell'
          ? ` Kamu menerima ${fmtSol(res.netSolAmount)} SOL setelah fee kreator ${fmtSol(res.trade.feeSol)} SOL.`
          : ` Termasuk fee kreator ${fmtSol(res.trade.feeSol)} SOL.`;
      const execUsd = Number.isFinite(solUsd) ? res.trade.price * solUsd : null;
      resEl.innerHTML = `<div class="alert alert-success">${side === 'buy' ? 'Beli' : 'Jual'} berhasil: ${fmtTokens(
        res.trade.tokenAmount
      )} ${esc(coin.ticker)} untuk ${fmtSol(res.trade.solAmount)} SOL @ ${fmtPriceBoth(execUsd, res.trade.price)}.${receivedNote}<br>
      Transaksimu: ${txLink(res.trade.userTxSignature)} • Transaksi pool: ${txLink(res.trade.poolTxSignature)}</div>`;
      await refreshBalance();
      renderHeader();
      await refreshOnchainBalances();
      setTimeout(() => renderCoin(mintAddress), 800);
    } catch (err) {
      fail(`Gagal: ${esc(friendlyError(err))}`);
    }
  }

  function renderPnlCard() {
    const card = document.getElementById('pnlCard');
    if (!state.wallet) {
      card.innerHTML = `<h2 style="margin-top:0">Profit / Loss</h2>
        <p class="muted">Hubungkan dompet untuk melihat untung-rugi kamu di coin ini.</p>`;
      return;
    }
    if (!walletPnl || walletPnl.totalTrades === 0) {
      card.innerHTML = `<h2 style="margin-top:0">Profit / Loss</h2>
        <p class="muted">Belum ada transaksi di coin ini. Beli dulu untuk mulai melacak PnL.</p>
        <p class="small">Saldo on-chain di dompetmu: <b>${fmtTokens(state.onchainBalances[coin.mintAddress] || 0)} ${esc(coin.ticker)}</b></p>`;
      return;
    }
    const p = walletPnl;
    const cls = p.totalPnlSol >= 0 ? 'profit' : 'loss';
    card.innerHTML = `
      <h2 style="margin-top:0">Profit / Loss
        <span class="badge ${p.totalPnlSol >= 0 ? 'badge-buy' : 'badge-sell'}" style="float:right">${
          p.totalPnlSol >= 0 ? 'UNTUNG' : 'RUGI'
        }</span>
      </h2>
      <div class="pnl-grid">
        <div class="stat"><div class="label">Holdings (dari trading)</div><div class="value">${fmtTokens(p.holdings)}</div></div>
        <div class="stat"><div class="label">Saldo On-chain di Dompet</div><div class="value">${fmtTokens(state.onchainBalances[coin.mintAddress] || 0)}</div></div>
        <div class="stat"><div class="label">Harga Rata-rata Beli</div><div class="value">${fmtPriceBoth(p.avgBuyPriceUsd, p.avgBuyPrice)}</div></div>
        <div class="stat"><div class="label">Cost Basis</div><div class="value">${fmtMoneyBoth(p.costBasisUsd, p.costBasisSol)}</div></div>
        <div class="stat"><div class="label">Nilai Sekarang</div><div class="value">${fmtMoneyBoth(p.currentValueUsd, p.currentValueSol)}</div></div>
        <div class="stat"><div class="label">Unrealized PnL</div><div class="value ${p.unrealizedPnlSol >= 0 ? 'profit' : 'loss'}">${fmtMoneyBoth(p.unrealizedPnlUsd, p.unrealizedPnlSol, true)}</div></div>
        <div class="stat"><div class="label">Realized PnL</div><div class="value ${p.realizedPnlSol >= 0 ? 'profit' : 'loss'}">${fmtMoneyBoth(p.realizedPnlUsd, p.realizedPnlSol, true)}</div></div>
        <div class="stat"><div class="label">Total PnL</div><div class="value ${cls}">${fmtMoneyBoth(p.totalPnlUsd, p.totalPnlSol, true)}</div></div>
        <div class="stat"><div class="label">ROI</div><div class="value ${cls}">${fmtPct(p.roiPct)}</div></div>
        <div class="stat"><div class="label">Fee Kreator Dibayar</div><div class="value">${fmtSol(p.totalFeesPaidSol || 0)} SOL</div></div>
      </div>
      <p class="small muted" style="margin-top:10px">Metode average-cost, dihitung server dari transaksi devnet yang tercatat. Jual dihitung dari SOL bersih setelah fee kreator 1%.</p>`;
  }

  function renderTradesTable() {
    const wrap = document.getElementById('tradesTable');
    // Fee claims are shown in the same history (newest first) on the
    // "Semua" and "Punyaku" tabs; they are not trades, so the Beli/Jual
    // filters exclude them.
    const claims = (feeClaims || []).map((c) => ({
      kind: 'claim',
      createdAt: c.createdAt,
      amountSol: c.amountSol,
      wallet: c.creatorWallet,
      txSignature: c.txSignature,
    }));
    let rows = trades.map((t) => ({ kind: 'trade', ...t }));
    if (state.tradeTab === 'Beli') rows = rows.filter((t) => t.side === 'buy');
    else if (state.tradeTab === 'Jual') rows = rows.filter((t) => t.side === 'sell');
    else if (state.tradeTab === 'Punyaku') {
      if (!state.wallet) {
        wrap.innerHTML = '<p class="muted">Hubungkan dompet untuk melihat transaksimu.</p>';
        return;
      }
      rows = walletTrades.map((t) => ({ kind: 'trade', ...t }));
      if (state.wallet === coin.creatorWallet) {
        rows = rows.concat(claims);
      }
    } else {
      rows = rows.concat(claims);
    }
    rows.sort((a, b) => b.createdAt - a.createdAt);
    if (!rows.length) {
      wrap.innerHTML = '<p class="muted">Belum ada transaksi.</p>';
      return;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Waktu</th><th>Jenis</th><th>Token</th><th>SOL</th><th>Fee Kreator</th><th>Harga</th><th>Dompet</th><th>Tx Kamu</th><th>Tx Pool</th></tr></thead>
        <tbody>
          ${rows
            .map((t) => {
              if (t.kind === 'claim') {
                return `<tr>
                <td>${fmtTime(t.createdAt)}</td>
                <td><span class="badge badge-ok">Klaim Fee</span></td>
                <td class="muted">—</td>
                <td>${fmtSol(t.amountSol)}</td>
                <td class="muted">—</td>
                <td class="muted">—</td>
                <td>${creatorLink(t.wallet)}${t.wallet === state.wallet ? ' (kamu)' : ''}</td>
                <td class="muted">—</td>
                <td>${txLink(t.txSignature)}</td>
              </tr>`;
              }
              return `<tr>
                <td>${fmtTime(t.createdAt)}</td>
                <td><span class="badge ${t.side === 'buy' ? 'badge-buy' : 'badge-sell'}">${
                  t.side === 'buy' ? 'Beli' : 'Jual'
                }</span></td>
                <td>${fmtTokens(t.tokenAmount)}</td>
                <td>${fmtSol(t.solAmount)}</td>
                <td>${fmtSol(t.feeSol || 0)}</td>
                <td>${fmtPriceBoth(t.priceUsd, t.price)}</td>
                <td>${creatorLink(t.wallet)}${t.wallet === state.wallet ? ' (kamu)' : ''}</td>
                <td>${txLink(t.userTxSignature)}</td>
                <td>${txLink(t.poolTxSignature)}</td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>`;
  }
}

// ---------- Follow / unfollow ----------
// Follow state is keyed by wallet address and stored server-side. The
// follower proves ownership by signing a canonical message with Phantom
// (no transaction, no fee) — the server verifies the Ed25519 signature.
async function toggleFollow(targetWallet, currentlyFollowing) {
  if (!state.wallet) {
    toast('Hubungkan dompet dulu untuk mengikuti.');
    return;
  }
  if (targetWallet === state.wallet) {
    toast('Kamu tidak bisa mengikuti dirimu sendiri.');
    return;
  }
  const phantom = (await waitForPhantom(3000)) || getPhantom();
  if (!phantom) {
    toast('Phantom tidak terdeteksi.');
    return;
  }
  if (typeof phantom.signMessage !== 'function') {
    toast('Phantom-mu tidak mendukung penandatanganan pesan. Perbarui Phantom ke versi terbaru.');
    return;
  }
  const action = currentlyFollowing ? 'unfollow' : 'follow';
  try {
    const message = followMessage(action, targetWallet);
    toast('Tanda tangani pesan di Phantom untuk membuktikan dompetmu (tanpa biaya).');
    const signature = await signFollowMessage(phantom, message);
    const res = await apiPost('/api/follows', {
      followerWallet: state.wallet,
      followingWallet: targetWallet,
      action,
      message,
      signature,
    });
    if (res.following) state.following.add(targetWallet);
    else state.following.delete(targetWallet);
    toast(
      res.following
        ? `Mengikuti ${shortAddr(targetWallet)}. Coin mereka muncul di filter "Mengikuti" di Beranda.`
        : `Berhenti mengikuti ${shortAddr(targetWallet)}.`
    );
  } catch (err) {
    toast(`Gagal: ${friendlyError(err)}`);
  }
}

// Claim accrued creator fees for one coin (from the creator's own profile).
async function claimFeesForCoin(mintAddress, btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await apiPost(`/api/coins/${mintAddress}/claim-fees`, { wallet: state.wallet });
    toast(`Berhasil mengklaim ${fmtSol(res.claim.amountSol)} SOL!`);
    await refreshBalance();
    renderHeader();
    route();
  } catch (err) {
    toast(`Klaim gagal: ${friendlyError(err)}`);
    if (btn) btn.disabled = false;
  }
}

// ---------- Creator profile ----------
async function renderCreator(walletAddress) {
  const view = document.getElementById('view');
  view.innerHTML = '<p class="muted">Memuat profil…</p>';
  let data;
  try {
    const params = state.wallet ? `?viewer=${encodeURIComponent(state.wallet)}` : '';
    data = await apiGet(`/api/creators/${encodeURIComponent(walletAddress)}${params}`);
  } catch (err) {
    view.innerHTML = `<div class="alert alert-error">Gagal memuat profil: ${esc(err.message)}</div>
      <p><a href="#/">Kembali ke Beranda</a></p>`;
    return;
  }
  const isSelf = data.isSelf;
  const initials = walletAddress.slice(0, 2).toUpperCase();

  const followListHtml = (list, emptyText) => {
    if (!list.length) return `<p class="muted">${emptyText}</p>`;
    return `<ul class="follow-list">${list
      .map(
        (w) => `<li>${creatorLink(w)}${w === state.wallet ? ' <span class="muted">(kamu)</span>' : ''}</li>`
      )
      .join('')}</ul>`;
  };

  view.innerHTML = `
    <div class="card">
      <div class="coin-head">
        <div class="coin-avatar" style="width:56px;height:56px;font-size:1.3rem">${esc(initials)}</div>
        <div>
          <div class="coin-name" style="font-size:1.3rem">${esc(shortAddr(walletAddress))}</div>
          <div class="small muted mono" style="word-break:break-all">${esc(walletAddress)}</div>
        </div>
        <span class="badge ${isSelf ? 'badge-ok' : 'badge-live'}" style="margin-left:auto">${isSelf ? 'Ini profilmu' : 'Kreator / Trader'}</span>
        ${state.wallet && !isSelf
          ? `<button class="btn btn-sm ${data.isFollowing ? '' : 'btn-primary'}" id="profileFollowBtn">${data.isFollowing ? '✓ Mengikuti' : '+ Ikuti'}</button>`
          : ''}
      </div>
      <div class="stat-grid" style="margin-top:16px">
        <div class="stat"><div class="label">Coin Dibuat</div><div class="value">${data.coins.length}</div></div>
        <div class="stat"><div class="label">Total Volume Trading</div><div class="value">${fmtSol(data.totalVolumeSol)} SOL</div></div>
        <div class="stat"><div class="label">Fee Kreator Terkumpul</div><div class="value">${fmtSol(data.totalFeesEarnedSol)} SOL</div></div>
        <div class="stat"><div class="label">Fee Sudah Diklaim</div><div class="value">${fmtSol(data.totalFeesClaimedSol)} SOL</div></div>
        <div class="stat"><div class="label">Fee Bisa Diklaim</div><div class="value">${fmtSol(data.totalFeesUnclaimedSol)} SOL</div></div>
        <div class="stat"><div class="label">Pengikut</div><div class="value">${data.followerCount}</div></div>
        <div class="stat"><div class="label">Mengikuti</div><div class="value">${data.followingCount}</div></div>
      </div>
      <p style="margin-top:12px"><a href="${EXPLORER}/address/${esc(walletAddress)}?cluster=devnet" target="_blank" rel="noopener">Lihat di Solana Explorer ↗</a></p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Coin yang Dibuat (${data.coins.length})</h2>
      ${data.coins.length === 0
        ? '<p class="muted">Dompet ini belum membuat coin.</p>'
        : `<div class="coin-grid">${data.coins.map(coinCard).join('')}</div>`}
    </div>

    <div class="card">
      <h2 style="margin-top:0">Callout (${(data.callouts || []).length})</h2>
      ${(data.callouts || []).length === 0
        ? '<p class="muted">Belum ada callout dari dompet ini.</p>'
        : (data.callouts || []).map((c) => calloutHtml(c, { showCoin: true })).join('')}
    </div>

    ${isSelf && data.coins.some((c) => c.feesUnclaimedSol > 0)
      ? `<div class="card">
          <h2 style="margin-top:0">Klaim Fee Kreator</h2>
          <p class="small muted">Fee dikirim dari dompet pool ke dompetmu sebagai transaksi devnet asli.</p>
          ${data.coins
            .filter((c) => c.feesUnclaimedSol > 0)
            .map(
              (c) => `<div class="row" style="margin-top:8px">
                <span><b>$${esc(c.ticker)}</b> — ${fmtSol(c.feesUnclaimedSol)} SOL bisa diklaim</span>
                <button class="btn btn-sm btn-primary" data-claim="${esc(c.mintAddress)}">Klaim ${fmtSol(c.feesUnclaimedSol)} SOL</button>
              </div>`
            )
            .join('')}
        </div>`
      : ''}

    <div class="grid-2">
      <div class="card">
        <h2 style="margin-top:0">Pengikut (${data.followerCount})</h2>
        ${followListHtml(data.followers, 'Belum ada pengikut.')}
      </div>
      <div class="card">
        <h2 style="margin-top:0">Mengikuti (${data.followingCount})</h2>
        ${followListHtml(data.following, 'Belum mengikuti siapa pun.')}
      </div>
    </div>`;

  // Coin cards navigate to the detail page; creator links inside stay local.
  view.querySelectorAll('.coin-card').forEach((card) => {
    card.addEventListener('click', () => {
      location.hash = `#/coin/${card.dataset.mint}`;
    });
  });
  view.querySelectorAll('.coin-card .addr-link').forEach((a) => {
    a.addEventListener('click', (e) => e.stopPropagation());
  });

  const followBtn = document.getElementById('profileFollowBtn');
  if (followBtn) {
    followBtn.addEventListener('click', async () => {
      followBtn.disabled = true;
      await toggleFollow(walletAddress, data.isFollowing);
      renderCreator(walletAddress);
    });
  }
  view.querySelectorAll('[data-claim]').forEach((b) => {
    b.addEventListener('click', () => claimFeesForCoin(b.dataset.claim, b));
  });
}

// ---------- Chart (SVG area chart with time axis + tooltip) ----------
function renderChartEl(wrap, points, range) {
  let pts = points;
  if (range > 0 && points.length > range + 1) {
    pts = [points[0], ...points.slice(points.length - range)];
  }
  if (pts.length < 2) {
    wrap.innerHTML =
      '<p class="muted" style="padding:40px 0;text-align:center">Belum ada transaksi — grafik muncul setelah ada trading.</p>';
    return;
  }
  const W = 1000;
  const H = 260;
  const PAD_L = 8;
  const PAD_R = 8;
  const PAD_T = 12;
  const PAD_B = 24;
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const span = Math.max(1, t1 - t0);
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    if (p.price < min) min = p.price;
    if (p.price > max) max = p.price;
  }
  if (max === min) {
    max = min * 1.1 || 1;
    min = min * 0.9;
  }
  const padY = (max - min) * 0.1;
  min -= padY;
  max += padY;
  const x = (t) => PAD_L + ((t - t0) / span) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - min) / (max - min)) * (H - PAD_T - PAD_B);
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
  const area = `${line} L${x(t1).toFixed(1)},${H - PAD_B} L${x(t0).toFixed(1)},${H - PAD_B} Z`;
  const last = pts[pts.length - 1];
  const up = last.price >= pts[0].price;
  const color = up ? '#22c55e' : '#ec4899';
  const fmtAxisTime = (t) =>
    new Date(t).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" id="chartSvg">
      <defs>
        <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#chartFill)"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2"/>
      <circle cx="${x(last.t)}" cy="${y(last.price)}" r="4" fill="${color}"/>
      <text x="${PAD_L}" y="${H - 6}" fill="#93a79a" font-size="13">${esc(fmtAxisTime(t0))}</text>
      <text x="${W - PAD_R}" y="${H - 6}" fill="#93a79a" font-size="13" text-anchor="end">${esc(fmtAxisTime(t1))}</text>
    </svg>
    <div class="chart-tip" id="chartTip"></div>`;

  const svg = document.getElementById('chartSvg');
  const tip = document.getElementById('chartTip');
  svg.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = pts[0];
    let bestD = Infinity;
    for (const p of pts) {
      const d = Math.abs(x(p.t) - px);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    tip.style.display = 'block';
    tip.style.left = `${Math.min(Math.max(e.clientX - rect.left + 12, 0), rect.width - 180)}px`;
    tip.style.top = `${Math.max(e.clientY - rect.top - 40, 0)}px`;
    tip.innerHTML = `${esc(fmtTime(best.t))}<br><b>${fmtPriceBoth(best.priceUsd, best.price)}</b>${
      best.side ? ` • ${best.side === 'buy' ? 'Beli' : 'Jual'}` : ' • Peluncuran'
    }`;
  });
  svg.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
  });
}

// ---------- Portfolio ----------
async function renderPortfolio() {
  const view = document.getElementById('view');
  view.innerHTML = '<h1>Portofolio Saya</h1>';
  if (!state.wallet) {
    view.innerHTML += `
      <div class="card empty">
        <h2>Hubungkan dompet dulu</h2>
        <p>Portofolio menampilkan posisi trading devnet dari dompet yang terhubung.</p>
        <p><button class="btn btn-primary" id="connectPf">Hubungkan Phantom</button></p>
      </div>`;
    document.getElementById('connectPf').onclick = connectWallet;
    return;
  }
  view.innerHTML += '<p class="muted">Memuat portofolio…</p>';
  let data;
  try {
    [data] = await Promise.all([
      apiGet(`/api/portfolio?wallet=${encodeURIComponent(state.wallet)}`),
      refreshOnchainBalances(),
    ]);
  } catch (err) {
    view.innerHTML += `<div class="alert alert-error">Gagal memuat portofolio: ${esc(err.message)}</div>`;
    return;
  }
  const s = data.summary;
  const cls = s.totalPnlSol >= 0 ? 'profit' : 'loss';
  view.innerHTML = `
    <h1>Portofolio Saya</h1>
    <p class="muted">Dompet <span class="mono">${esc(state.wallet)}</span> • Semua angka dari trading devnet yang tercatat. Kolom "Saldo On-chain" dibaca langsung dari devnet.</p>
    <div class="card">
      <div class="stat-grid">
        <div class="stat"><div class="label">Total PnL</div><div class="value ${cls}">${fmtMoneyBoth(s.totalPnlUsd, s.totalPnlSol, true)} (${fmtPct(s.totalPnlPct)})</div></div>
        <div class="stat"><div class="label">Nilai Sekarang</div><div class="value">${fmtMoneyBoth(s.totalCurrentValueUsd, s.totalCurrentValueSol)}</div></div>
        <div class="stat"><div class="label">Cost Basis</div><div class="value">${fmtMoneyBoth(s.totalCostBasisUsd, s.totalCostBasisSol)}</div></div>
        <div class="stat"><div class="label">Realized PnL</div><div class="value ${s.totalRealizedPnlSol >= 0 ? 'profit' : 'loss'}">${fmtMoneyBoth(s.totalRealizedPnlUsd, s.totalRealizedPnlSol, true)}</div></div>
        <div class="stat"><div class="label">Unrealized PnL</div><div class="value ${s.totalUnrealizedPnlSol >= 0 ? 'profit' : 'loss'}">${fmtMoneyBoth(s.totalUnrealizedPnlUsd, s.totalUnrealizedPnlSol, true)}</div></div>
        <div class="stat"><div class="label">Total Beli</div><div class="value">${fmtSol(s.totalBuySol)} SOL</div></div>
        <div class="stat"><div class="label">Total Jual</div><div class="value">${fmtSol(s.totalSellSol)} SOL</div></div>
        <div class="stat"><div class="label">Coin • Transaksi</div><div class="value">${s.coinCount} • ${s.totalTrades}</div></div>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Posisi per Coin</h2>
      ${
        data.positions.length === 0
          ? '<p class="muted">Belum ada posisi. Mulai trading di salah satu coin.</p>'
          : `<div class="table-wrap"><table>
              <thead><tr><th>Coin</th><th>Holdings</th><th>Saldo On-chain</th><th>Harga Rata-rata</th><th>Harga Kini</th><th>Market Cap</th><th>Nilai</th><th>PnL</th><th>ROI</th><th></th></tr></thead>
              <tbody>
                ${data.positions
                  .map(
                    (p) => `<tr>
                      <td><a href="#/coin/${esc(p.mintAddress)}"><b>${esc(p.name)}</b> <span class="muted">$${esc(p.ticker)}</span></a></td>
                      <td>${fmtTokens(p.holdings)}</td>
                      <td>${fmtTokens(state.onchainBalances[p.mintAddress] || 0)}</td>
                      <td>${fmtPriceBoth(p.avgBuyPriceUsd, p.avgBuyPrice)}</td>
                      <td>${fmtPriceBoth(p.priceUsd, p.price)}</td>
                      <td>${fmtMarketCap(p)}</td>
                      <td>${fmtMoneyBoth(p.currentValueUsd, p.currentValueSol)}</td>
                      <td class="${p.totalPnlSol >= 0 ? 'profit' : 'loss'}">${fmtMoneyBoth(p.totalPnlUsd, p.totalPnlSol, true)}</td>
                      <td class="${p.totalPnlSol >= 0 ? 'profit' : 'loss'}">${fmtPct(p.roiPct)}</td>
                      <td><a class="btn btn-sm" href="#/coin/${esc(p.mintAddress)}">Lihat</a></td>
                    </tr>`
                  )
                  .join('')}
              </tbody>
            </table></div>`
      }
    </div>`;
}

// ---------- Boot ----------
// Attach Phantom listeners once the extension has injected (it can arrive
// after our scripts run). Runs on DOMContentLoaded and again on window load.
let phantomWired = false;
async function wirePhantom() {
  if (phantomWired) return;
  const phantom = await waitForPhantom(4000);
  if (!phantom) return;
  phantomWired = true;
  phantom.on('disconnect', () => {
    state.wallet = null;
    state.balanceSol = null;
    state.onchainBalances = {};
    state.following = new Set();
    state.feedFollowingOnly = false;
    localStorage.removeItem('solpump-wallet');
    renderHeader();
    route();
  });
  // The user can switch accounts inside Phantom at any time. Without this
  // listener the site keeps checking the OLD account's devnet balance while
  // Phantom signs with the NEW one — the classic cause of a "Not enough
  // SOL" popup after a passing balance check.
  phantom.on('accountChanged', async (publicKey) => {
    if (!publicKey) {
      state.wallet = null;
      state.balanceSol = null;
      state.onchainBalances = {};
      state.following = new Set();
      state.feedFollowingOnly = false;
      localStorage.removeItem('solpump-wallet');
    } else {
      state.wallet = publicKey.toString();
      localStorage.setItem('solpump-wallet', state.wallet);
      await refreshBalance();
      await refreshOnchainBalances();
      await loadFollowing();
      toast(`Akun Phantom berubah ke ${shortAddr(state.wallet)} — saldo diperbarui.`);
    }
    renderHeader();
    route();
  });
  // Reconnect silently if the wallet was already trusted.
  if (state.wallet) {
    try {
      const resp = await phantom.connect({ onlyIfTrusted: true });
      state.wallet = resp.publicKey.toString();
      await refreshBalance();
      await refreshOnchainBalances();
      await loadFollowing();
      renderHeader();
      route();
    } catch {
      state.wallet = null;
      localStorage.removeItem('solpump-wallet');
      renderHeader();
    }
  }
}

loadPoolAddress().then(() => {
  const el = document.getElementById('poolAddress');
  if (el && state.poolAddress) {
    el.innerHTML = `<a class="mono" href="${EXPLORER}/address/${esc(state.poolAddress)}?cluster=devnet" target="_blank" rel="noopener">${esc(shortAddr(state.poolAddress))} ↗</a>`;
  }
});
wirePhantom();
window.addEventListener('load', wirePhantom);

renderHeader();
route();
