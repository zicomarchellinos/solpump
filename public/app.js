'use strict';
// solpump frontend: hash-routed single-page app.
// Views: feed (#/), create (#/create), coin detail (#/coin/<mint>),
// creator profile (#/creator/<wallet>), portfolio (#/portfolio).
// Minting AND trading are real on Solana devnet via Phantom + the pool
// wallet; every trade takes a 1% creator fee (see src/bonding.js).
// Display currency: token prices + market cap are USD (pump.fun style —
// the server supplies the SOL/USD rate and the *Usd fields; the UI falls
// back to the pair asset when no USD price is available). Each coin trades
// against a PAIR ASSET — SOL by default, or another coin in the registry
// (see src/pairs.js): buy/sell amounts, amounts received, pool balances
// and fees are denominated in that asset (coin.pairAsset.symbol), and the
// pair label is coin.pairLabel (TICKER/SOL or TICKER/PAIR).
// All user-facing strings go through translate() (public/i18n.js) —
// Indonesian (default), English, Simplified Chinese.

const EXPLORER = 'https://explorer.solana.com';

// ---------- State ----------
const state = {
  wallet: localStorage.getItem('solpump-wallet') || null,
  balanceSol: null,
  poolAddress: null,
  onchainBalances: {}, // mintAddress -> live on-chain token balance
  coinCache: null, // last loaded coin detail
  chartRange: 0, // 0 = all, else last N trades
  chartType: 'area', // 'area' | 'candles'
  candleTimeframe: '5m', // '1m' | '5m' | '15m' | '1h'
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

function fmtSignedSol(x, asset = 'SOL') {
  const n = Number(x);
  return `${n >= 0 ? '+' : '−'}${fmtSol(Math.abs(n))} ${asset}`;
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

// Market-cap display: USD with suffixes when available, pair asset
// otherwise (the pair asset is SOL for SOL pairs, the pair coin for
// coin pairs — the coin's pairAsset.symbol labels it).
function fmtMarketCap(c) {
  if (c && Number.isFinite(c.marketCapUsd)) return fmtMarketCapUsd(c.marketCapUsd);
  const asset = (c && c.pairAsset && c.pairAsset.symbol) || 'SOL';
  return `${fmtSol(c.marketCapSol)} ${asset}`;
}

// Money figure (PnL, value): USD primary, pair asset as a small secondary
// line. Falls back to the pair asset only when no USD price is available.
// `asset` is the pair-asset symbol (default SOL for SOL pairs).
function fmtMoneyBoth(usd, sol, signed = false, asset = 'SOL') {
  const solStr = signed ? fmtSignedSol(sol, asset) : `${fmtSol(sol)} ${asset}`;
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

// Relative time, pump.fun style ("5 mnt lalu", "2 jam lalu" / "5 min ago").
function fmtAgo(ts) {
  const diff = Date.now() - Number(ts);
  if (!Number.isFinite(diff) || diff < 0) return translate('agoJustNow');
  const min = Math.floor(diff / 60000);
  if (min < 1) return translate('agoJustNow');
  if (min < 60) return translate('agoMinutes', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return translate('agoHours', { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return translate('agoDays', { n: day });
  return fmtDate(ts);
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

// Server errors come back in Indonesian; translateError() maps the common
// ones to the current language (unknown ones stay Indonesian).
async function apiGet(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(translateError(data.error || `HTTP ${res.status}`));
  return data;
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(translateError(data.error || `HTTP ${res.status}`));
  return data;
}

function logoHtml(coin, cls = 'coin-logo') {
  if (coin.logoUrl) {
    return `<img class="${cls}" src="${esc(coin.logoUrl)}" alt="${esc(coin.ticker)}">`;
  }
  const initials = (coin.ticker || '?').slice(0, 2).toUpperCase();
  return `<div class="coin-avatar${cls === 'coin-logo' ? '' : ` ${cls}`}">${esc(initials)}</div>`;
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

// ---------- Editable profiles (username / photo / border / cover) ----------
// Border presets: the stored value is the key; the ring is a CSS class
// (see .avatar-ring-* in styles.css). 'none' = no ring.
const BORDER_PRESETS = [
  { key: 'none', labelKey: 'borderNone' },
  { key: 'green', labelKey: 'borderGreen' },
  { key: 'blue', labelKey: 'borderBlue' },
  { key: 'purple', labelKey: 'borderPurple' },
  { key: 'gold', labelKey: 'borderGold' },
  { key: 'rainbow', labelKey: 'borderRainbow' },
];

// Canonical profile-edit message — must match src/signverify.js exactly.
// The server rebuilds it from the SUBMITTED fields: username '' when
// cleared/absent, border 'none' when absent, and the sha256 of each
// submitted image's base64 payload ('' when no image is submitted).
function profileMessage({ wallet, username, border, avatarHash, coverHash }) {
  return [
    `solpump:profile:${wallet}`,
    `username:${username || ''}`,
    `border:${border || 'none'}`,
    `avatar:${avatarHash || ''}`,
    `cover:${coverHash || ''}`,
  ].join('\n');
}

async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest('sha256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Display name for a wallet: the username when the profile has one,
// otherwise the shortened address.
function displayName(profile, wallet) {
  return (profile && profile.username) || shortAddr(wallet);
}

// Avatar: the profile photo when set, otherwise an initials tile. The
// border preset renders as a CSS ring around it. `size` is px (square);
// `round` makes it a circle (callouts), otherwise a rounded tile.
function avatarHtml(profile, wallet, size = 56, round = false) {
  const border = (profile && profile.border) || 'none';
  const ringClass = border !== 'none' ? ` avatar-ring avatar-ring-${border}` : '';
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.32)}px${round ? ';border-radius:50%' : ''}`;
  if (profile && profile.avatarUrl) {
    return `<img src="${esc(profile.avatarUrl)}" alt="${translate('profileAvatarAlt')}" class="profile-avatar-img${ringClass}" style="${style}">`;
  }
  const initials = (wallet || '?').slice(0, 2).toUpperCase();
  return `<div class="coin-avatar${ringClass}" style="${style}">${esc(initials)}</div>`;
}

// One callout (social trade call). Entry price + holdings were computed
// server-side from the trader's real trades; PnL is live vs the current
// price. Prices are USD (plain decimals, never scientific notation), PnL is
// USD primary with the SOL figure in parentheses; PnL uses the same
// green=profit / pink=loss styling as the PnL card.
function calloutHtml(c, { showCoin = false } = {}) {
  const cls = c.pnlSol >= 0 ? 'profit' : 'loss';
  const asset = c.assetSymbol || 'SOL';
  const pnlUsd = Number.isFinite(c.pnlUsd)
    ? `${fmtSignedUsd(c.pnlUsd)} <span class="muted">(${fmtSignedSol(c.pnlSol, asset)})</span>`
    : fmtSignedSol(c.pnlSol, asset);
  return `
    <div class="callout">
      <div class="callout-head">
        ${avatarHtml(c.authorProfile, c.wallet, 28, true)}
        ${creatorLink(c.wallet, displayName(c.authorProfile, c.wallet))}
        <span class="badge badge-ok">${translate('calloutVerified')}</span>
        <span class="muted small" style="margin-left:auto">${fmtAgo(c.createdAt)}</span>
      </div>
      <p class="callout-text">${esc(c.text)}</p>
      ${showCoin
        ? `<a class="callout-coin" href="#/coin/${esc(c.mintAddress)}">
            <span class="coin-mini">${esc((c.coinTicker || '?').slice(0, 2).toUpperCase())}</span>
            <span><b>${esc(c.coinName || c.coinTicker)}</b> <span class="muted">$${esc(c.coinTicker)}</span></span>
            <span class="muted small" style="margin-left:auto">${translate('calloutViewCoin')}</span>
          </a>`
        : ''}
      <div class="callout-meta small">
        <span>${translate('calloutEntry')} <b>${fmtPriceBoth(c.entryPriceUsd, c.entryPrice)}</b></span>
        <span>${translate('calloutHeld')} <b>${fmtTokens(c.holdingsAtPost)}</b></span>
        <span>${translate('calloutCurrentPrice')} <b>${fmtPriceBoth(c.currentPriceUsd, c.currentPrice)}</b></span>
        <span>${translate('calloutPnl')} <b class="${cls}">${pnlUsd} (${fmtPct(c.pnlPct)})</b></span>
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
    // Never let a slow or hanging RPC block the page: after 8s, fall back
    // to empty on-chain balances (the trade-based holdings still render;
    // the "Saldo On-chain" column just shows 0 until the next refresh).
    state.onchainBalances = await Promise.race([
      getAllTokenBalances(state.wallet),
      new Promise((resolve) => setTimeout(() => resolve({}), 8000)),
    ]);
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
    // Same 8s guard as refreshOnchainBalances: a hanging RPC must not
    // stall the header/balance refresh forever.
    state.balanceSol = await Promise.race([
      getDevnetBalanceSol(state.wallet),
      new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
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
      toast(translate('toastWalletChanged', { addr: shortAddr(current) }));
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
    toast(translate('errPhantomNotFound'));
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
      if (!ok) toast(translate('warnRpcNotDevnet'));
    } catch {
      // Non-fatal: the mint flow re-checks before signing.
    }
    renderHeader();
    route();
    toast(translate('toastWalletConnected'));
  } catch (err) {
    toast(translate('errConnectWallet', { msg: friendlyError(err) }));
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
  renderLangSwitcher();
  const box = document.getElementById('walletBox');
  if (state.wallet) {
    // Live devnet balance, prominent: re-read from devnet RPC on connect
    // and after every confirmed transaction (mint / funding / trade /
    // claim). The refresh button re-reads it on demand; the address links
    // to the wallet's own profile page.
    box.innerHTML = `
      <a class="wallet-chip" href="#/creator/${esc(state.wallet)}" title="${translate('headerMyProfile')}">
        <span class="mono">${esc(shortAddr(state.wallet))}</span>
        <span class="bal" title="${translate('headerBalanceTitle')}">${state.balanceSol === null ? '…' : `${fmtSol(state.balanceSol)} SOL`}</span>
      </a>
      <button class="btn btn-sm btn-ghost" id="refreshBalHeaderBtn" title="${translate('headerRefreshTitle')}">↻</button>
      <button class="btn btn-sm" id="disconnectBtn">${translate('headerDisconnect')}</button>`;
    document.getElementById('disconnectBtn').onclick = disconnectWallet;
    document.getElementById('refreshBalHeaderBtn').onclick = async () => {
      const btn = document.getElementById('refreshBalHeaderBtn');
      if (btn) btn.disabled = true;
      await refreshBalance();
      renderHeader();
    };
  } else {
    box.innerHTML = `<button class="btn btn-primary" id="connectBtn">${translate('headerConnect')}</button>`;
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

// Language switcher in the topbar (ID / EN / 中文), persisted in
// localStorage by i18n.js. Switching re-renders the header and the
// current view so dynamic strings switch too; static shell strings are
// applied by setLang() itself. The footer pool address is re-filled after
// the switch (applyStaticI18n rebuilds the footer's innerHTML).
function renderLangSwitcher() {
  const box = document.getElementById('langBox');
  if (!box) return;
  const langs = [
    ['id', 'ID'],
    ['en', 'EN'],
    ['zh', '中文'],
  ];
  const current = getLang();
  box.innerHTML = langs
    .map(
      ([code, label]) =>
        `<button class="lang-btn ${current === code ? 'active' : ''}" data-lang="${code}" title="${translate('langSwitcherLabel')}">${label}</button>`
    )
    .join('');
  box.querySelectorAll('[data-lang]').forEach((b) => {
    b.addEventListener('click', () => {
      if (getLang() === b.dataset.lang) return;
      setLang(b.dataset.lang);
      fillPoolAddress();
      renderHeader();
      route();
    });
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
    `<div class="card"><p>${translate('notFoundTitle')}</p><a href="#/">${translate('backHome')}</a></div>`;
}

window.addEventListener('hashchange', route);

// ---------- Feed ----------
let feedSearch = '';
let feedSort = 'newest';

async function renderFeed() {
  const view = document.getElementById('view');
  // Layout ala pump.fun: strip trending di atas, lalu filter pill + grid.
  // (Tidak ada hero — pump.fun langsung ke konten.)
  const sortPills = [
    ['newest', translate('sortNewest')],
    ['marketcap', translate('sortMarketCap')],
    ['volume', translate('sortVolume')],
    ['price', translate('sortPrice')],
    ['change', translate('sortChange')],
  ];
  view.innerHTML = `
    <div id="trendStrip"></div>
    <div class="toolbar">
      <input id="searchInput" type="search" placeholder="${translate('searchPlaceholder')}" value="${esc(feedSearch)}">
      <div class="sort-pills" role="tablist" aria-label="${translate('sortAriaLabel')}">
        ${sortPills
          .map(
            ([v, label]) =>
              `<button class="pill ${feedSort === v ? 'active' : ''}" data-sort="${v}" role="tab">${label}</button>`
          )
          .join('')}
      </div>
      ${state.wallet && state.following.size > 0
        ? `<button class="pill ${state.feedFollowingOnly ? 'active' : ''}" id="followingToggle" title="${translate('followingOnlyTitle')}">${translate('followingFilter', { n: state.following.size })}</button>`
        : ''}
    </div>
    <div id="followingCallouts"></div>
    <div id="coinList"><p class="muted">${translate('loadingCoins')}</p></div>`;

  const searchInput = document.getElementById('searchInput');
  let debounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      feedSearch = searchInput.value;
      loadCoins();
    }, 300);
  });
  view.querySelectorAll('[data-sort]').forEach((b) => {
    b.addEventListener('click', () => {
      feedSort = b.dataset.sort;
      view.querySelectorAll('[data-sort]').forEach((x) =>
        x.classList.toggle('active', x.dataset.sort === feedSort)
      );
      loadCoins();
    });
  });
  const followingToggle = document.getElementById('followingToggle');
  if (followingToggle) {
    followingToggle.addEventListener('click', () => {
      state.feedFollowingOnly = !state.feedFollowingOnly;
      followingToggle.classList.toggle('active', state.feedFollowingOnly);
      loadCoins();
    });
  }
  loadTrendStrip();
  loadCoins();

  // Strip trending ala pump.fun: 10 coin teratas berdasarkan market cap,
  // bisa di-scroll horizontal. Gagal memuat = strip kosong (tidak fatal).
  async function loadTrendStrip() {
    const strip = document.getElementById('trendStrip');
    if (!strip) return;
    try {
      const data = await apiGet('/api/coins?sort=marketcap&limit=10');
      if (!data.coins.length) {
        strip.innerHTML = '';
        return;
      }
      strip.innerHTML = `
        <div class="trend-title">${translate('trendingTitle')}</div>
        <div class="trend-strip">
          ${data.coins
            .map(
              (c, i) => `
            <div class="trend-chip" data-mint="${esc(c.mintAddress)}" title="${esc(c.name)} ($${esc(c.ticker)})">
              ${logoHtml(c)}
              <div style="min-width:0">
                <div class="tc-name">${esc(c.ticker)}${i < 3 ? '<span class="hot">HOT</span>' : ''}</div>
                <div class="tc-price">${fmtPriceBoth(c.priceUsd, c.price)}</div>
                <div class="tc-mc">${fmtMarketCap(c)}</div>
              </div>
            </div>`
            )
            .join('')}
        </div>`;
      strip.querySelectorAll('.trend-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          location.hash = `#/coin/${chip.dataset.mint}`;
        });
      });
    } catch {
      strip.innerHTML = '';
    }
  }

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
          ? `<div class="card"><h2 style="margin-top:0">${translate('followingCalloutsTitle')}</h2>${cd.callouts
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
            <h2>${translate('emptyFollowingTitle')}</h2>
            <p>${translate('emptyFollowingBody')}</p>
          </div>`
          : `
          <div class="card empty">
            <h2>${translate('emptyFeedTitle')}</h2>
            <p>${translate('emptyFeedBody')}</p>
            <p><a class="btn btn-primary" href="#/create">${translate('emptyFeedCta')}</a></p>
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
      list.innerHTML = `<div class="alert alert-error">${esc(translate('errLoadCoins', { msg: err.message }))}</div>`;
    }
  }
}

function coinCard(c) {
  const chg = c.changePct >= 0 ? 'profit' : 'loss';
  const pairAsset = (c.pairAsset && c.pairAsset.symbol) || 'SOL';
  const pairLabel = c.pairLabel || `${c.ticker}/SOL`;
  return `
    <div class="card coin-card" data-mint="${esc(c.mintAddress)}">
      <div class="coin-head">
        ${logoHtml(c)}
        <div class="coin-id">
          <div class="coin-name">${esc(c.name)} <span class="coin-ticker">$${esc(c.ticker)}</span></div>
          <div class="coin-pair">${esc(pairLabel)} • ${fmtAgo(c.createdAt)}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="small muted">${translate('cardMarketCap')}</div>
          <div><b>${fmtMarketCap(c)}</b></div>
        </div>
        ${c.tradingEnabled ? '' : `<span class="badge badge-warn">${translate('badgeTradingOff')}</span>`}
      </div>
      ${c.description ? `<p class="coin-desc">${esc(c.description)}</p>` : ''}
      <div class="coin-price-row">
        <span class="coin-price"><b>${fmtPriceBoth(c.priceUsd, c.price)}</b> <span class="${chg}">${fmtPct(c.changePct)}</span></span>
        <span class="small muted">${translate('cardVolume')} <b style="color:var(--text)">${fmtSol(c.volumeSol)} ${esc(pairAsset)}</b></span>
      </div>
      <div class="progress" title="${translate('cardProgressTitle', { pct: c.progressPct.toFixed(1) })}">
        <div style="width:${c.progressPct.toFixed(1)}%"></div>
      </div>
      <div class="coin-foot">${translate('cardFoot', { pct: c.progressPct.toFixed(1), n: c.txCount, creator: creatorLink(c.creatorWallet, displayName(c.creatorProfile, c.creatorWallet)) })}</div>
    </div>`;
}

// ---------- Create coin ----------
async function renderCreate() {
  const view = document.getElementById('view');
  // Selected pair asset: null = SOL (default), otherwise a pair coin's mint.
  let selectedPairMint = null;
  let pairOptions = [];
  view.innerHTML = `
    <h1>${translate('createTitle')}</h1>
    <p class="muted">${translate('createIntro')}</p>
    <div id="pendingMintBox"></div>
    <div class="create-layout">
    <div class="card">
      <div class="field">
        <label for="coinName">${translate('createNameLabel')}</label>
        <input id="coinName" maxlength="32" placeholder="${translate('createNamePlaceholder')}">
      </div>
      <div class="field">
        <label for="coinTicker">${translate('createTickerLabel')}</label>
        <input id="coinTicker" maxlength="10" placeholder="${translate('createTickerPlaceholder')}">
        <div class="hint">${translate('createTickerHint')}</div>
      </div>
      <div class="field">
        <label for="coinDesc">${translate('createDescLabel')}</label>
        <textarea id="coinDesc" rows="3" maxlength="500" placeholder="${translate('createDescPlaceholder')}"></textarea>
      </div>
      <div class="field">
        <label for="coinLogo">${translate('createLogoLabel')}</label>
        <input id="coinLogo" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
      </div>
      <div class="field">
        <label>${translate('pairPickerTitle')}</label>
        <p class="hint">${translate('pairPickerHint')}</p>
        <div id="pairPicker">
          <label class="pair-option"><input type="radio" name="pairAsset" value="" checked> <b>SOL</b> <span class="muted small">${translate('pairSolLabel')}</span></label>
          <input id="pairSearch" type="search" placeholder="${translate('pairSearchPlaceholder')}" style="margin-top:8px">
          <div id="pairList" style="margin-top:8px"><p class="muted small">${translate('loadingGeneric')}</p></div>
        </div>
      </div>
      <div id="walletStatus"></div>
      <div id="mintSteps"></div>
      <div id="mintError"></div>
      <div class="alert alert-info" style="margin-top:8px">
        ${translate('createDevnetWarning')}
      </div>
      <label class="check-row">
        <input type="checkbox" id="devnetConfirm">
        <span>${translate('createDevnetConfirm')}</span>
      </label>
      <button class="btn btn-primary" id="mintBtn" style="margin-top:8px">${translate('createMintBtn')}</button>
    </div>
    <div class="create-preview-col">
      <div class="card" id="createPreview">
        <h2 style="margin-top:0">${translate('previewTitle')}</h2>
        <p class="small muted">${translate('previewSubtitle')}</p>
        <div class="card coin-card" style="margin-bottom:0;cursor:default">
          <div class="coin-head">
            <div id="logoPreview"><div class="coin-avatar">??</div></div>
            <div class="coin-id">
              <div class="coin-name"><span id="pvName">${translate('createNameLabel')}</span> <span class="coin-ticker">$<span id="pvTicker">TICKER</span></span></div>
              <div class="coin-pair"><span id="pvPair">TICKER/SOL</span> • ${translate('agoJustNow')}</div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div class="small muted">${translate('cardMarketCap')}</div>
              <div><b>$5K</b></div>
            </div>
          </div>
          <p class="coin-desc" id="pvDesc">${translate('previewDescDefault')}</p>
          <div class="coin-price-row">
            <span class="coin-price"><b>~$0.000005</b></span>
            <span class="small muted">${translate('cardVolume')} <b style="color:var(--text)" id="pvVol">0 SOL</b></span>
          </div>
          <div class="progress"><div style="width:0%"></div></div>
          <div class="coin-foot">${translate('previewFoot')}</div>
        </div>
        <p class="preview-note">${translate('previewNote')}</p>
        <p class="preview-note" id="pvPairNote">${translate('pairPreviewNote', { pair: 'SOL' })}</p>
      </div>
    </div>
    </div>`;

  const tickerInput = document.getElementById('coinTicker');
  tickerInput.addEventListener('input', () => {
    tickerInput.value = tickerInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    renderPreview();
  });
  document.getElementById('coinName').addEventListener('input', renderPreview);
  document.getElementById('coinDesc').addEventListener('input', renderPreview);

  // Live preview: mirror the form into the preview card (pump.fun's create
  // page shows the same "how your coin will look" panel).
  function selectedPairSymbol() {
    if (!selectedPairMint) return 'SOL';
    const found = pairOptions.find((p) => p.mint === selectedPairMint);
    return found ? found.symbol : 'SOL';
  }
  function renderPreview() {
    const name = document.getElementById('coinName').value.trim() || translate('createNameLabel');
    const ticker = document.getElementById('coinTicker').value.trim() || 'TICKER';
    const desc = document.getElementById('coinDesc').value.trim() || translate('previewDescDefault');
    document.getElementById('pvName').textContent = name;
    document.getElementById('pvTicker').textContent = ticker;
    document.getElementById('pvPair').textContent = `${ticker}/${selectedPairSymbol()}`;
    document.getElementById('pvDesc').textContent = desc;
    const pairNote = document.getElementById('pvPairNote');
    if (pairNote) {
      pairNote.textContent = translate('pairPreviewNote', { pair: `${ticker}/${selectedPairSymbol()}` });
    }
    const pvVol = document.getElementById('pvVol');
    if (pvVol) pvVol.textContent = `0 ${selectedPairSymbol()}`;
    // Without a logo, the preview avatar shows the ticker's initials.
    if (!logoData) {
      document.getElementById('logoPreview').innerHTML =
        `<div class="coin-avatar">${esc(ticker.slice(0, 2).toUpperCase())}</div>`;
    }
  }

  // Pair picker: SOL (default) + a searchable list of listed site coins.
  async function loadPairOptions() {
    const list = document.getElementById('pairList');
    try {
      const data = await apiGet('/api/pairs');
      pairOptions = (data.pairs || []).filter((p) => p.type === 'COIN');
      renderPairList('');
    } catch {
      if (list) list.innerHTML = `<p class="muted small">${translate('pairEmpty')}</p>`;
    }
  }
  function renderPairList(query) {
    const list = document.getElementById('pairList');
    if (!list) return;
    const q = (query || '').trim().toLowerCase();
    const filtered = pairOptions.filter(
      (p) =>
        !q ||
        p.symbol.toLowerCase().includes(q) ||
        (p.name || '').toLowerCase().includes(q)
    );
    if (!filtered.length) {
      list.innerHTML = `<p class="muted small">${translate('pairEmpty')}</p>`;
      return;
    }
    list.innerHTML = filtered
      .map(
        (p) => `<label class="pair-option">
          <input type="radio" name="pairAsset" value="${esc(p.mint)}" ${selectedPairMint === p.mint ? 'checked' : ''}>
          <b>$${esc(p.symbol)}</b> <span class="muted small">${esc(p.name || '')}</span>
        </label>`
      )
      .join('');
    list.querySelectorAll('input[name="pairAsset"]').forEach((r) => {
      r.addEventListener('change', () => {
        selectedPairMint = r.value || null;
        renderPreview();
      });
    });
  }
  document.querySelector('input[name="pairAsset"][value=""]').addEventListener('change', () => {
    selectedPairMint = null;
    renderPreview();
  });
  document.getElementById('pairSearch').addEventListener('input', (e) => {
    renderPairList(e.target.value);
  });
  loadPairOptions();

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
      preview.innerHTML = `<p class="loss small">${translate('errFileTooBig')}</p>`;
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const [meta, base64] = String(reader.result).split(',');
      logoData = { dataBase64: base64, mimeType: file.type };
      preview.innerHTML = `<img src="${esc(reader.result)}" alt="${translate('previewLogoAlt')}" class="coin-logo">`;
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
        <h2 style="margin-top:0">${translate('pendingTitle', { ticker: esc(pending.ticker) })}</h2>
        <p>${translate('pendingBody', { addr: esc(shortAddr(pending.mintAddress)), err: esc(pending.error || translate('notAvailable')) })}</p>
        <p>
          <button class="btn btn-primary" id="retryRegisterBtn">${translate('pendingRetry')}</button>
          <button class="btn" id="dropPendingBtn">${translate('pendingDrop')}</button>
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
          pairMint: pending.pairMint || undefined,
          image: pending.image || undefined,
        });
        savePendingMint(null);
        toast(translate('toastCoinRegistered', { ticker: pending.ticker }));
        location.hash = `#/coin/${pending.mintAddress}`;
      } catch (err) {
        toast(translate('errRegisterStillFailing', { msg: err.message }));
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
          <strong>${translate('createPhantomMissingTitle')}</strong> ${translate('createPhantomMissingBody')}
          <div class="small" style="margin-top:6px">${translate('createPhantomMissingMobile')}</div>
          <div style="margin-top:8px">
            <a class="btn btn-sm" href="https://phantom.app/" target="_blank" rel="noopener">${translate('createDownloadPhantom')}</a>
            <button class="btn btn-sm" id="recheckPhantom">${translate('createRecheck')}</button>
          </div>
        </div>`;
      document.getElementById('recheckPhantom').onclick = () => updateWalletStatus();
      return;
    }
    if (!state.wallet) {
      el.innerHTML = `
        <div class="alert alert-info">
          <strong>${translate('createWalletMissingTitle')}</strong> ${translate('createWalletMissingBody')}
          <div class="small" style="margin-top:6px">${translate('createWalletMissingNote')}</div>
          <div style="margin-top:8px"><button class="btn btn-sm btn-primary" id="connectFromCreate">${translate('headerConnect')}</button></div>
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
        <strong>${translate('createWalletLabel')}</strong> <span class="mono">${esc(state.wallet)}</span><br>
        <strong>${translate('createBalanceLabel')}</strong> ${bal === null ? '…' : `${fmtSol(bal)} SOL`}
        ${cost ? translate('createNeedSol', { need: fmtSol(need), rent: fmtSol(cost.mintRentSol + cost.ataRentSol) }) : ''}
        ${low ? translate('createLowBalance', { short: fmtSol(need - bal) }) : ''}
        <div style="margin-top:8px"><button class="btn btn-sm" id="refreshBalBtn">${translate('createRefreshBalance')}</button></div>
      </div>
      <div class="alert alert-info">
        ${translate('createNetworkNote')}
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
      fail(translate('errNameTickerRequired'));
      return;
    }
    if (!document.getElementById('devnetConfirm').checked) {
      fail(translate('errDevnetConfirm'));
      return;
    }
    if (!solanaLibsReady()) {
      fail(translate('errSolanaLibs'));
      return;
    }
    // Re-detect Phantom fresh (late injection) and re-check everything
    // right now — never trust connect-time state.
    const phantom = (await waitForPhantom(3000)) || getPhantom();
    if (!phantom) {
      fail(translate('errPhantomNotDetected'));
      return;
    }
    if (!state.wallet) {
      fail(translate('errConnectFirst'));
      return;
    }
    // Sync with the account currently active in Phantom: the user may have
    // switched accounts since connecting, and Phantom signs with the active
    // one — checking the old account's balance would let a doomed mint
    // through to the popup.
    const synced = await syncWalletAccount();
    if (!synced) {
      fail(translate('errReadAccount'));
      return;
    }

    const steps = [
      translate('stepWallet'),
      translate('stepBuildMint'),
      translate('stepSignMint'),
      translate('stepSendMint'),
      translate('stepFunding'),
      translate('stepRegister'),
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
        if (!rpcOk) throw new Error(translate('errRpcNotDevnet'));
      } catch (err) {
        fail(translate('errCheckWallet', { msg: esc(friendlyError(err)) }));
        return;
      }
      // Mint + funding need rent for the mint, two ATAs, and fees.
      const needTotal = cost.totalSol + 0.003;
      if (state.balanceSol < needTotal) {
        fail(
          translate('errLowBalanceMint', { bal: fmtSol(state.balanceSol), need: fmtSol(needTotal) })
        );
        return;
      }

      // 1. Build the mint transaction and simulate it BEFORE signing.
      paint(1, 0);
      const built = await buildMintTransaction(state.wallet);
      mintAddress = built.mintAddress;
      const sim = await simulateTransaction(built.transaction);
      if (!sim.ok) {
        fail(`${translate('errMintSimFailed')}<br><span class="mono small">${esc(sim.error)}</span>`);
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
              translate('errLowBalanceFunding', { bal: fmtSol(balAfterMint), need: fmtSol(fundingNeed) })
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
            translate('confirmFundingFailed', { err: friendlyError(fundErr) })
          );
          if (!skip) {
            fail(
              translate('errMintFundCancelled', { tx: txLink(mintSignature) })
            );
            savePendingMint({
              mintAddress,
              name,
              ticker,
              description,
              creatorWallet: state.wallet,
              txSignature: mintSignature,
              fundingTxSignature: null,
              pairMint: selectedPairMint,
              image: logo,
              error: translate('pendingErrFundingCancelled'),
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
          pairMint: selectedPairMint || undefined,
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
          pairMint: selectedPairMint,
          image: logo,
          error: regErr.message,
        });
        renderPendingMint();
        fail(
          translate('errMintRegisterFailed', { tx: txLink(mintSignature), err: esc(regErr.message) })
        );
        return;
      }
      // Clear the pending mint ONLY if it is the coin just registered: a
      // pending mint for a DIFFERENT coin (an earlier failed registration)
      // must survive, so the user can still retry it after creating
      // another coin. One wallet can create many coins.
      const pending = loadPendingMint();
      if (!pending || pending.mintAddress === mintAddress) savePendingMint(null);
      paint(5, 5);
      toast(translate('toastCoinCreated', { ticker }));
      location.hash = `#/coin/${mintAddress}`;
    } catch (err) {
      fail(translate('errMintFailed', { msg: esc(friendlyError(err)) }));
    }
  }
}

// ---------- Coin detail ----------
async function renderCoin(mintAddress) {
  const view = document.getElementById('view');
  view.innerHTML = `<p class="muted">${translate('loadingCoin')}</p>`;
  let data;
  try {
    const params = state.wallet ? `?wallet=${encodeURIComponent(state.wallet)}` : '';
    data = await apiGet(`/api/coins/${mintAddress}${params}`);
  } catch (err) {
    view.innerHTML = `<div class="alert alert-error">${esc(translate('errLoadCoin', { msg: err.message }))}</div>
      <p><a href="#/">${translate('backHome')}</a></p>`;
    return;
  }
  state.coinCache = data;
  const { coin, stats, chart, trades, feeClaims, creatorFees, creatorFeePct, viewerFollowsCreator, callouts, burns, burnStats, walletPnl, walletTrades, solUsd } = data;
  const chg = stats.changePct >= 0 ? 'profit' : 'loss';
  const isCreator = state.wallet && state.wallet === coin.creatorWallet;
  // Pair asset: SOL for SOL pairs, the pair coin's ticker for coin pairs.
  const pairAsset = (coin.pairAsset && coin.pairAsset.symbol) || 'SOL';
  const pairAvailable = !coin.pairAsset || coin.pairAsset.available !== false;
  const pairLabel = coin.pairLabel || `${coin.ticker}/SOL`;

  view.innerHTML = `
    <div class="card">
      <div class="coin-head">
        ${logoHtml(coin, 'coin-logo detail-head-logo')}
        <div>
          <div class="coin-name" style="font-size:1.3rem">${esc(coin.name)} <span class="muted">$${esc(coin.ticker)}</span></div>
          <div class="small muted">${esc(pairLabel)} • ${translate('coinCreatedBy', { ago: fmtAgo(coin.createdAt), creator: creatorLink(coin.creatorWallet) })}</div>
        </div>
        <span class="badge badge-ok" style="margin-left:auto">${translate('badgeVerified')}</span>
        ${coin.tradingEnabled ? '' : `<span class="badge badge-warn">${translate('badgeTradingOff')}</span>`}
        ${state.wallet && !isCreator
          ? `<button class="btn btn-sm" id="followCreatorBtn">${viewerFollowsCreator ? translate('followFollowing') : translate('followCreator')}</button>`
          : ''}
      </div>
      ${coin.description ? `<p>${esc(coin.description)}</p>` : ''}
      ${!pairAvailable ? `
      <div class="alert alert-error">
        <strong>${translate('pairUnavailableTitle')}</strong> ${translate('pairUnavailableBody')}
      </div>` : ''}
      ${coin.tradingEnabled ? '' : `
      <div class="alert alert-info" id="fundingBox">
        <strong>${translate('fundingTitle')}</strong> ${translate('fundingBody')}
        ${state.wallet === coin.creatorWallet ? `<div style="margin-top:8px"><button class="btn btn-sm btn-primary" id="fundPoolBtn">${translate('fundingBtn')}</button></div><div id="fundResult"></div>` : ''}
      </div>`}
      <div class="proof">
        <div class="row"><span class="k">${translate('proofMintAddress')}</span>
          <span class="mono">${esc(shortAddr(coin.mintAddress))}</span>
          <button class="btn btn-sm btn-ghost" data-copy="${esc(coin.mintAddress)}">${translate('copyBtn')}</button>
          <a href="${EXPLORER}/address/${esc(coin.mintAddress)}?cluster=devnet" target="_blank" rel="noopener">${translate('explorerLink')}</a>
        </div>
        <div class="row"><span class="k">${translate('proofMintTx')}</span>
          <span class="mono">${esc(shortAddr(coin.txSignature))}</span>
          <a href="${EXPLORER}/tx/${esc(coin.txSignature)}?cluster=devnet" target="_blank" rel="noopener">${translate('explorerLink')}</a>
        </div>
      </div>
    </div>

    <div class="detail-layout">
    <div class="detail-main">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
        <h2 style="margin:0">${translate('chartTitle')}</h2>
        <div style="text-align:right"><span style="font-size:1.2rem;font-weight:800">${fmtPriceBoth(stats.priceUsd, stats.price)}</span>
        <span class="${chg}"> ${fmtPct(stats.changePct)}</span>
        <div class="small muted">${translate('statMarketCap')} <b style="color:var(--text)">${fmtMarketCap(coin)}</b></div></div>
      </div>
      <div class="range-btns" style="margin-top:12px">
        <button class="btn btn-sm ${state.chartType === 'area' ? 'active' : ''}" data-chart-type="area">${translate('chartArea')}</button>
        <button class="btn btn-sm ${state.chartType === 'candles' ? 'active' : ''}" data-chart-type="candles">${translate('chartCandles')}</button>
        ${state.chartType === 'candles'
          ? ['1m', '5m', '15m', '1h']
              .map(
                (tf) =>
                  `<button class="btn btn-sm ${state.candleTimeframe === tf ? 'active' : ''}" data-timeframe="${tf}">${tf}</button>`
              )
              .join('')
          : [0, 10, 25, 50]
              .map(
                (n) =>
                  `<button class="btn btn-sm ${state.chartRange === n ? 'active' : ''}" data-range="${n}">${
                    n === 0 ? translate('rangeAll') : translate('rangeTx', { n })
                  }</button>`
              )
              .join('')}
      </div>
      <div class="chart-wrap" id="chartWrap"></div>
    </div>

    <div class="card">
      <div class="stat-grid">
        <div class="stat"><div class="label">${translate('statMarketCap')}</div><div class="value">${fmtMarketCap(coin)}</div></div>
        <div class="stat"><div class="label">${translate('statChange')}</div><div class="value ${chg}">${fmtPct(stats.changePct)}</div></div>
        <div class="stat"><div class="label">${translate('statHigh')}</div><div class="value">${fmtPriceBoth(stats.highUsd, stats.high)}</div></div>
        <div class="stat"><div class="label">${translate('statLow')}</div><div class="value">${fmtPriceBoth(stats.lowUsd, stats.low)}</div></div>
        <div class="stat"><div class="label">${translate('statVolume')}</div><div class="value">${fmtSol(stats.volumeSol)} ${esc(pairAsset)}</div></div>
        <div class="stat"><div class="label">${translate('statFeesCollected')}</div><div class="value">${fmtSol(stats.totalFeesSol)} ${esc(pairAsset)}</div></div>
        <div class="stat"><div class="label">${translate('statTxCount')}</div><div class="value">${stats.txCount}</div></div>
        <div class="stat"><div class="label">${translate('statUniqueTraders')}</div><div class="value">${stats.uniqueTraders}</div></div>
        <div class="stat"><div class="label">${translate('statSupply')}</div><div class="value">${fmtTokens(stats.circulatingSupply)}</div></div>
        <div class="stat"><div class="label">${translate('statBurned')}</div><div class="value">${fmtTokens(stats.totalBurned)}</div></div>
      </div>
      <div style="margin-top:14px">
        <div class="small muted">${translate('curveProgress', { pct: stats.progressPct.toFixed(1) })}</div>
        <div class="progress"><div style="width:${stats.progressPct.toFixed(1)}%"></div></div>
      </div>
    </div>

    <div class="card" id="burnCard">
      <h2 style="margin-top:0">${translate('burnTitle')}</h2>
      <p class="small muted">${translate('burnIntro')}</p>
      <div class="stat-grid" style="grid-template-columns:1fr 1fr">
        <div class="stat"><div class="label">${translate('burnTotalLabel')}</div><div class="value">${fmtTokens(burnStats ? burnStats.totalBurned : 0)}</div></div>
        <div class="stat"><div class="label">${translate('burnSupplyLabel')}</div><div class="value">${fmtTokens(burnStats ? burnStats.circulatingSupply : 1000000000)}</div></div>
      </div>
      <div id="burnForm" style="margin-top:12px"></div>
      <div id="burnResult" style="margin-top:8px"></div>
      <h3 style="margin-top:16px">${translate('burnHistoryTitle')} (${burnStats ? burnStats.burnCount : 0})</h3>
      <div id="burnHistory"></div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">${translate('tradesTitle')}</h2>
      <div class="tabs">
        ${[['Semua', 'tabAll'], ['Beli', 'tabBuy'], ['Jual', 'tabSell'], ['Punyaku', 'tabMine']]
          .map(([key, labelKey]) => `<button class="btn btn-sm ${state.tradeTab === key ? 'active' : ''}" data-tab="${key}">${translate(labelKey)}</button>`)
          .join('')}
      </div>
      <div class="table-wrap" id="tradesTable"></div>
    </div>

    <div class="card" id="calloutsCard">
      <h2 style="margin-top:0">${translate('calloutsTitle', { n: (callouts || []).length })}</h2>
      <p class="small muted">${translate('calloutsIntro')}</p>
      <div id="calloutForm"></div>
      <div id="calloutList">
        ${(callouts || []).length === 0
          ? `<p class="muted">${translate('calloutsEmpty')}</p>`
          : (callouts || []).map((c) => calloutHtml(c)).join('')}
      </div>
    </div>
    </div>
    <aside class="detail-side">
      <div class="card trade-box">
        <h2 style="margin-top:0">${translate('tradeTitle')} <span class="badge badge-live">${translate('badgeDevnetLive')}</span></h2>
        <p class="small muted">${translate('tradeIntro', { asset: esc(pairAsset), pool: '<span id="tradePoolAddr">…</span>' })}</p>
        <p class="small">${translate('tradeFeeNote', { pct: creatorFeePct, asset: esc(pairAsset), creator: creatorLink(coin.creatorWallet) })}</p>
        <div class="tabs">
          <button class="btn btn-sm ${state.tradeSide === 'buy' ? 'active' : ''}" data-side="buy">${translate('tabBuy')}</button>
          <button class="btn btn-sm ${state.tradeSide === 'sell' ? 'active' : ''}" data-side="sell">${translate('tabSell')}</button>
        </div>
        <div id="tradeForm"></div>
        <div id="tradeResult"></div>
      </div>
      <div class="card" id="pnlCard"></div>
      <div class="card" id="transferCard">
        <h2 style="margin-top:0">${translate('transferTitle')}</h2>
        <div id="transferForm"></div>
        <div id="transferResult" style="margin-top:8px"></div>
      </div>
      <div class="card" id="feeCard">
        <h2 style="margin-top:0">${translate('feeTitle')} <span class="badge badge-ok">${translate('feeBadge', { pct: creatorFeePct })}</span></h2>
        <div class="stat-grid" style="grid-template-columns:1fr 1fr">
          <div class="stat"><div class="label">${translate('feeTotal')}</div><div class="value">${fmtSol(creatorFees.totalEarnedSol)} ${esc(pairAsset)}</div></div>
          <div class="stat"><div class="label">${translate('feeClaimed')}</div><div class="value">${fmtSol(creatorFees.totalClaimedSol)} ${esc(pairAsset)}</div></div>
          <div class="stat"><div class="label">${translate('feeClaimable')}</div><div class="value">${fmtSol(creatorFees.unclaimedSol)} ${esc(pairAsset)}</div></div>
        </div>
        ${isCreator
          ? `<div style="margin-top:12px">
              <button class="btn btn-primary" id="claimFeesBtn" ${creatorFees.unclaimedSol > 0 ? '' : 'disabled'}>${translate('feeClaimBtn', { amount: fmtSol(creatorFees.unclaimedSol), asset: esc(pairAsset) })}</button>
              <div id="claimResult" style="margin-top:8px"></div>
              <p class="small muted">${translate('feeClaimNote')}</p>
            </div>`
          : `<p class="small muted" style="margin-top:12px">${translate('feeNonCreatorNote', { asset: esc(pairAsset), creator: creatorLink(coin.creatorWallet) })}</p>`}
      </div>
    </aside>
    </div>`;

  // Copy buttons
  view.querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.copy).then(() => toast(translate('copiedGeneric')));
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
      resEl.innerHTML = `<p class="muted">${translate('claimSending')}</p>`;
      try {
        const res = await apiPost(`/api/coins/${coin.mintAddress}/claim-fees`, {
          wallet: state.wallet,
        });
        resEl.innerHTML = `<div class="alert alert-success">${translate('claimSuccess', { amount: fmtSol(res.claim.amountSol), asset: esc(res.claim.assetSymbol || pairAsset), tx: txLink(res.claim.txSignature) })}</div>`;
        await refreshBalance();
        renderHeader();
        setTimeout(() => renderCoin(mintAddress), 1200);
      } catch (err) {
        resEl.innerHTML = `<div class="alert alert-error">${esc(translate('claimFailed', { msg: friendlyError(err) }))}</div>`;
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
      el.textContent = translate('notAvailable');
    }
  });

  // Creator funding: enable trading later for an unfunded coin.
  const fundBtn = document.getElementById('fundPoolBtn');
  if (fundBtn) {
    fundBtn.addEventListener('click', async () => {
      const resEl = document.getElementById('fundResult');
      fundBtn.disabled = true;
      try {
        if (!solanaLibsReady()) throw new Error(translate('errSolanaLibsShort'));
        const phantom = (await waitForPhantom(3000)) || getPhantom();
        if (!phantom) throw new Error(translate('errPhantomShort'));
        // Sync with the account currently active in Phantom, then check
        // its fresh devnet balance against the funding cost (pool ATA rent
        // + fee) — never open a popup for a tx that cannot pay its fee.
        if (!(await syncWalletAccount())) {
          throw new Error(translate('errReadAccountShort'));
        }
        if (state.balanceSol !== null && state.balanceSol < 0.003) {
          throw new Error(
            translate('errLowBalanceFund', { bal: fmtSol(state.balanceSol) })
          );
        }
        const poolAddress = await loadPoolAddress();
        if (!poolAddress) throw new Error(translate('errPoolUnavailable'));
        resEl.innerHTML = `<p class="muted">${translate('fundingBuilding')}</p>`;
        const funding = await buildFundingTransaction(state.wallet, coin.mintAddress, poolAddress);
        const sim = await simulateTransaction(funding.transaction);
        if (!sim.ok) throw new Error(sim.error);
        resEl.innerHTML = `<p class="muted">${translate('fundingSign')}</p>`;
        const sig = await signAndSend(phantom, funding.transaction);
        await refreshBalance();
        renderHeader();
        resEl.innerHTML = `<p class="muted">${translate('fundingVerifying')}</p>`;
        await apiPost(`/api/coins/${coin.mintAddress}/fund`, { fundingTxSignature: sig });
        toast(translate('toastFunded'));
        renderCoin(mintAddress);
      } catch (err) {
        resEl.innerHTML = `<div class="alert alert-error">${esc(translate('fundingFailed', { msg: friendlyError(err) }))}</div>`;
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

  // Chart type toggle (Area / Candles) + candle timeframe pills.
  view.querySelectorAll('[data-chart-type]').forEach((b) => {
    b.addEventListener('click', () => {
      state.chartType = b.dataset.chartType;
      renderCoin(mintAddress);
    });
  });
  view.querySelectorAll('[data-timeframe]').forEach((b) => {
    b.addEventListener('click', () => {
      state.candleTimeframe = b.dataset.timeframe;
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

  if (state.chartType === 'candles') {
    await renderCandleChartEl(document.getElementById('chartWrap'), mintAddress, state.candleTimeframe);
  } else {
    renderChartEl(document.getElementById('chartWrap'), chart, state.chartRange);
  }
  // Live on-chain balances before the trade form renders (MAX uses them).
  await refreshOnchainBalances();
  renderTradeForm();
  renderPnlCard();
  renderBurnForm();
  renderBurnHistory();
  renderTransferForm();
  renderTradesTable();
  renderCalloutForm();

  // Callout form: only wallets with a real buy of this coin may post
  // (the server re-verifies from the trade records).
  function renderCalloutForm() {
    const form = document.getElementById('calloutForm');
    if (!state.wallet) {
      form.innerHTML = `<p class="muted">${translate('calloutConnectFirst')}</p>`;
      return;
    }
    const hasBuy = (walletTrades || []).some((t) => t.side === 'buy');
    if (!hasBuy) {
      form.innerHTML = `<p class="muted">${translate('calloutNoBuy')}</p>`;
      return;
    }
    form.innerHTML = `
      <div class="field">
        <textarea id="calloutText" rows="2" maxlength="280" placeholder="${translate('calloutPlaceholder')}"></textarea>
        <div class="small muted" style="text-align:right"><span id="calloutCount">0</span>/280</div>
      </div>
      <button class="btn btn-primary" id="postCalloutBtn">${translate('calloutPostBtn')}</button>
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
        toast(translate('errCalloutEmpty'));
        return;
      }
      btn.disabled = true;
      try {
        await apiPost(`/api/coins/${coin.mintAddress}/callouts`, {
          wallet: state.wallet,
          text,
        });
        toast(translate('toastCalloutPosted'));
        renderCoin(mintAddress);
      } catch (err) {
        resEl.innerHTML = `<div class="alert alert-error">${esc(translate('errCalloutPost', { msg: friendlyError(err) }))}</div>`;
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
    // USD price of one unit of the pair asset (SOL/USD for SOL pairs, the
    // pair coin's USD token price for coin pairs) — converts execution
    // prices to USD.
    const assetUsd = Number.isFinite(coin.pairAssetUsd) ? coin.pairAssetUsd : null;
    if (!pairAvailable) {
      form.innerHTML = `<p class="muted">${translate('pairUnavailableBody')}</p>`;
      return;
    }
    if (!coin.tradingEnabled) {
      form.innerHTML = `<p class="muted">${translate('tradeNotActive')}</p>`;
      return;
    }
    if (!state.wallet) {
      form.innerHTML = `<p class="muted">${translate('tradeConnectFirst')}</p>
        <button class="btn btn-primary" id="connectTrade">${translate('headerConnect')}</button>`;
      document.getElementById('connectTrade').onclick = connectWallet;
      return;
    }
    if (state.tradeSide === 'buy') {
      // Quick amounts are pair-aware: SOL pairs use SOL amounts, coin
      // pairs use pair-token amounts (min buy is 1,000 pair tokens).
      const quickAmounts = pairAsset === 'SOL' ? [0.1, 0.5, 1, 5] : [1000, 100000, 1000000, 10000000];
      form.innerHTML = `
        <div class="field">
          <label>${translate('buyAmountLabel', { asset: esc(pairAsset) })}</label>
          <input id="buySol" type="number" min="0" step="any" placeholder="${pairAsset === 'SOL' ? '0.5' : '100000'}">
          <div class="quick">
            ${quickAmounts.map((v) => `<button class="btn" data-quick="${v}">${fmtTokens(v)} ${esc(pairAsset)}</button>`).join('')}
          </div>
          <div class="estimate" id="buyEstimate"></div>
        </div>
        <button class="btn btn-buy" id="buyBtn">${translate('buyBtnLabel', { ticker: esc(coin.ticker) })}</button>
        <p class="small muted" style="margin-top:8px">${translate('buyNote', { asset: esc(pairAsset) })}</p>`;
      const input = document.getElementById('buySol');
      const update = () => {
        const sol = Number(input.value);
        const est = document.getElementById('buyEstimate');
        if (sol > 0) {
          const tokens = (coin.tokenReserve * sol) / (coin.solReserve + sol);
          const fee = (sol * creatorFeePct) / 100;
          const execSol = sol / tokens;
          const execUsd = assetUsd !== null ? execSol * assetUsd : null;
          est.textContent = translate('buyEstimate', {
            tokens: fmtTokens(tokens),
            ticker: coin.ticker,
            price: fmtPriceBoth(execUsd, execSol),
            pct: creatorFeePct,
            fee: fmtSol(fee),
            asset: pairAsset,
          });
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
        if (!(sol > 0)) return toast(translate('errEnterSol', { asset: pairAsset }));
        await submitTrade('buy', { solAmount: sol });
      });
    } else {
      form.innerHTML = `
        <div class="field">
          <label>${translate('sellAmountLabel', { ticker: esc(coin.ticker) })}</label>
          <input id="sellTokens" type="number" min="0" step="any" placeholder="1000000">
          <div class="quick">
            <button class="btn" id="maxSell">${translate('sellMax', { bal: fmtTokens(liveHoldings) })}</button>
          </div>
          <div class="estimate" id="sellEstimate"></div>
        </div>
        <button class="btn btn-sell" id="sellBtn">${translate('sellBtnLabel', { ticker: esc(coin.ticker) })}</button>
        <p class="small muted" style="margin-top:8px">${translate('sellNote', { asset: esc(pairAsset) })}</p>`;
      const input = document.getElementById('sellTokens');
      const update = () => {
        const tokens = Number(input.value);
        const est = document.getElementById('sellEstimate');
        if (tokens > 0) {
          const sol = (coin.solReserve * tokens) / (coin.tokenReserve + tokens);
          const fee = (sol * creatorFeePct) / 100;
          const execSol = sol / tokens;
          const execUsd = assetUsd !== null ? execSol * assetUsd : null;
          est.textContent = translate('sellEstimate', {
            amount: fmtSol(sol - fee),
            asset: pairAsset,
            pct: creatorFeePct,
            fee: fmtSol(fee),
            price: fmtPriceBoth(execUsd, execSol),
          });
        } else est.textContent = '';
      };
      input.addEventListener('input', update);
      document.getElementById('maxSell').addEventListener('click', () => {
        input.value = liveHoldings;
        update();
      });
      document.getElementById('sellBtn').addEventListener('click', async () => {
        const tokens = Number(input.value);
        if (!(tokens > 0)) return toast(translate('errEnterTokens'));
        await submitTrade('sell', { tokenAmount: tokens });
      });
    }
    if (pnl && pnl.totalTrades > 0) {
      const pnlUsd = Number.isFinite(pnl.totalPnlUsd)
        ? `${fmtSignedUsd(pnl.totalPnlUsd)} <span class="muted">(${fmtSignedSol(pnl.totalPnlSol, pairAsset)})</span>`
        : fmtSignedSol(pnl.totalPnlSol, pairAsset);
      form.insertAdjacentHTML(
        'beforeend',
        `<p class="small" style="margin-top:10px">${translate('tradeFooterBalance', {
          bal: fmtTokens(liveHoldings),
          ticker: esc(coin.ticker),
          cls: pnl.totalPnlSol >= 0 ? 'profit' : 'loss',
          pnl: pnlUsd,
          roi: fmtPct(pnl.roiPct),
        })}</p>`
      );
    }
  }

  // Real trade flow: prepare (quote + balance pre-checks, server-side) ->
  // build the user's leg -> simulate -> sign in Phantom -> send + confirm
  // -> server verifies the leg on-chain, completes the pool leg, records.
  // The user's leg is a SOL transfer for SOL pairs, a pair-token transfer
  // for coin pairs (buildPairBuyTransaction).
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
      if (!solanaLibsReady()) throw new Error(translate('errSolanaLibsReload'));
      const phantom = (await waitForPhantom(3000)) || getPhantom();
      if (!phantom) throw new Error(translate('errPhantomShort'));
      // Sync with the account currently active in Phantom so the quote and
      // balance checks apply to the account that will actually sign.
      if (!(await syncWalletAccount())) {
        throw new Error(translate('errReadAccountShort'));
      }
      const poolAddress = await loadPoolAddress();
      if (!poolAddress) throw new Error(translate('errPoolUnavailable'));

      // 1. Prepare: quote + pool/user balance checks BEFORE signing.
      setBusy(translate('tradePreparing'));
      const prepared = await apiPost('/api/trades/prepare', {
        mintAddress: coin.mintAddress,
        wallet: state.wallet,
        side,
        ...amounts,
      });

      // 2. Build the user's leg and simulate it before asking to sign.
      setBusy(translate('tradeBuilding'));
      let built;
      if (side === 'buy' && coin.pairMint) {
        built = await buildPairBuyTransaction(
          state.wallet,
          coin.mintAddress,
          coin.pairMint,
          poolAddress,
          prepared.solAmount
        );
      } else if (side === 'buy') {
        built = await buildBuyTransaction(state.wallet, coin.mintAddress, poolAddress, prepared.solAmount);
      } else {
        built = await buildSellTransaction(state.wallet, coin.mintAddress, poolAddress, prepared.tokenAmount);
      }
      const sim = await simulateTransaction(built.transaction);
      if (!sim.ok) throw new Error(`Simulasi gagal: ${sim.error}`);

      // 3. Sign + send + confirm the user's leg.
      setBusy(translate('tradeSigning'));
      const userSig = await signAndSend(phantom, built.transaction);

      // 4. Server verifies the leg on-chain, completes the pool leg, records.
      setBusy(translate('tradeSettling'));
      const res = await apiPost(`/api/trades/${side}`, {
        mintAddress: coin.mintAddress,
        wallet: state.wallet,
        ...(side === 'buy' ? { solAmount: prepared.solAmount } : { tokenAmount: prepared.tokenAmount }),
        userTxSignature: userSig,
      });
      const receivedNote =
        side === 'sell'
          ? translate('tradeSuccessNet', { amount: fmtSol(res.netSolAmount), fee: fmtSol(res.trade.feeSol), asset: pairAsset })
          : translate('tradeSuccessFee', { fee: fmtSol(res.trade.feeSol), asset: pairAsset });
      const assetUsd = Number.isFinite(coin.pairAssetUsd) ? coin.pairAssetUsd : null;
      const execUsd = assetUsd !== null ? res.trade.price * assetUsd : null;
      const successMsg = translate(side === 'buy' ? 'tradeSuccessBuy' : 'tradeSuccessSell', {
        tokens: fmtTokens(res.trade.tokenAmount),
        ticker: esc(coin.ticker),
        amount: fmtSol(res.trade.solAmount),
        asset: pairAsset,
        price: fmtPriceBoth(execUsd, res.trade.price),
      });
      resEl.innerHTML = `<div class="alert alert-success">${successMsg}${receivedNote}<br>
      ${translate('tradeSuccessTxs', { userTx: txLink(res.trade.userTxSignature), poolTx: txLink(res.trade.poolTxSignature) })}</div>`;
      await refreshBalance();
      renderHeader();
      await refreshOnchainBalances();
      setTimeout(() => renderCoin(mintAddress), 800);
    } catch (err) {
      fail(esc(translate('errGeneric', { msg: friendlyError(err) })));
    }
  }

  function renderPnlCard() {
    const card = document.getElementById('pnlCard');
    if (!state.wallet) {
      card.innerHTML = `<h2 style="margin-top:0">${translate('pnlTitle')}</h2>
        <p class="muted">${translate('pnlConnectFirst')}</p>`;
      return;
    }
    if (!walletPnl || walletPnl.totalTrades === 0) {
      card.innerHTML = `<h2 style="margin-top:0">${translate('pnlTitle')}</h2>
        <p class="muted">${translate('pnlEmpty')}</p>
        <p class="small">${translate('pnlOnchainBalance', { bal: fmtTokens(state.onchainBalances[coin.mintAddress] || 0), ticker: esc(coin.ticker) })}</p>`;
      return;
    }
    const p = walletPnl;
    const cls = p.totalPnlSol >= 0 ? 'profit' : 'loss';
    card.innerHTML = `
      <h2 style="margin-top:0">${translate('pnlTitle')}
        <span class="badge ${p.totalPnlSol >= 0 ? 'badge-buy' : 'badge-sell'}" style="float:right">${
          p.totalPnlSol >= 0 ? translate('pnlProfit') : translate('pnlLoss')
        }</span>
      </h2>
      <div class="pnl-grid">
        <div class="stat"><div class="label">${translate('pnlHoldings')}</div><div class="value">${fmtTokens(p.holdings)}</div></div>
        <div class="stat"><div class="label">${translate('pnlOnchain')}</div><div class="value">${fmtTokens(state.onchainBalances[coin.mintAddress] || 0)}</div></div>
        <div class="stat"><div class="label">${translate('pnlAvgBuy')}</div><div class="value">${fmtPriceBoth(p.avgBuyPriceUsd, p.avgBuyPrice)}</div></div>
        <div class="stat"><div class="label">${translate('pnlCostBasis')}</div><div class="value">${fmtMoneyBoth(p.costBasisUsd, p.costBasisSol, false, pairAsset)}</div></div>
        <div class="stat"><div class="label">${translate('pnlCurrentValue')}</div><div class="value">${fmtMoneyBoth(p.currentValueUsd, p.currentValueSol, false, pairAsset)}</div></div>
        <div class="stat"><div class="label">${translate('pnlUnrealized')}</div><div class="value ${p.unrealizedPnlSol >= 0 ? 'profit' : 'loss'}">${fmtMoneyBoth(p.unrealizedPnlUsd, p.unrealizedPnlSol, true, pairAsset)}</div></div>
        <div class="stat"><div class="label">${translate('pnlRealized')}</div><div class="value ${p.realizedPnlSol >= 0 ? 'profit' : 'loss'}">${fmtMoneyBoth(p.realizedPnlUsd, p.realizedPnlSol, true, pairAsset)}</div></div>
        <div class="stat"><div class="label">${translate('pnlTotal')}</div><div class="value ${cls}">${fmtMoneyBoth(p.totalPnlUsd, p.totalPnlSol, true, pairAsset)}</div></div>
        <div class="stat"><div class="label">${translate('pnlRoi')}</div><div class="value ${cls}">${fmtPct(p.roiPct)}</div></div>
        <div class="stat"><div class="label">${translate('pnlFeesPaid')}</div><div class="value">${fmtSol(p.totalFeesPaidSol || 0)} ${esc(pairAsset)}</div></div>
      </div>
      <p class="small muted" style="margin-top:10px">${translate('pnlNote', { asset: esc(pairAsset) })}</p>`;
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
        wrap.innerHTML = `<p class="muted">${translate('tradesConnectFirst')}</p>`;
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
      wrap.innerHTML = `<p class="muted">${translate('tradesEmpty')}</p>`;
      return;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr><th>${translate('thTime')}</th><th>${translate('thType')}</th><th>${translate('thToken')}</th><th>${translate('thAsset', { asset: esc(pairAsset) })}</th><th>${translate('thFee')}</th><th>${translate('thPrice')}</th><th>${translate('thWallet')}</th><th>${translate('thYourTx')}</th><th>${translate('thPoolTx')}</th></tr></thead>
        <tbody>
          ${rows
            .map((t) => {
              if (t.kind === 'claim') {
                return `<tr>
                <td>${fmtTime(t.createdAt)}</td>
                <td><span class="badge badge-ok">${translate('claimBadge')}</span></td>
                <td class="muted">—</td>
                <td>${fmtSol(t.amountSol)}</td>
                <td class="muted">—</td>
                <td class="muted">—</td>
                <td>${creatorLink(t.wallet)}${t.wallet === state.wallet ? translate('youSuffix') : ''}</td>
                <td class="muted">—</td>
                <td>${txLink(t.txSignature)}</td>
              </tr>`;
              }
              return `<tr>
                <td>${fmtTime(t.createdAt)}</td>
                <td><span class="badge ${t.side === 'buy' ? 'badge-buy' : 'badge-sell'}">${
                  t.side === 'buy' ? translate('tabBuy') : translate('tabSell')
                }</span></td>
                <td>${fmtTokens(t.tokenAmount)}</td>
                <td>${fmtSol(t.solAmount)}</td>
                <td>${fmtSol(t.feeSol || 0)}</td>
                <td>${fmtPriceBoth(t.priceUsd, t.price)}</td>
                <td>${creatorLink(t.wallet)}${t.wallet === state.wallet ? translate('youSuffix') : ''}</td>
                <td>${txLink(t.userTxSignature)}</td>
                <td>${txLink(t.poolTxSignature)}</td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>`;
  }

  // Burn form: amount input + MAX from the live on-chain balance, a
  // price-effect preview (burning shrinks the token reserve, so the price
  // rises), and the burn button (real SPL burn via Phantom).
  function renderBurnForm() {
    const form = document.getElementById('burnForm');
    if (!state.wallet) {
      form.innerHTML = `<p class="muted">${translate('tradeConnectFirst')}</p>`;
      return;
    }
    const liveHoldings = state.onchainBalances[coin.mintAddress] || 0;
    form.innerHTML = `
      <div class="field">
        <label>${translate('burnAmountLabel')}</label>
        <input id="burnAmount" type="number" min="0" step="any" placeholder="1000000">
        <div class="quick">
          <button class="btn" id="maxBurn">${translate('burnMaxBtn', { bal: fmtTokens(liveHoldings) })}</button>
        </div>
        <div class="estimate" id="burnPreview"></div>
      </div>
      <button class="btn btn-sell" id="burnBtn">${translate('burnBtn')}</button>
      <p class="small muted" style="margin-top:8px">${translate('burnNote')}</p>`;
    const input = document.getElementById('burnAmount');
    const update = () => {
      const amount = Number(input.value);
      const est = document.getElementById('burnPreview');
      if (amount > 0 && amount < coin.tokenReserve) {
        const newPrice = coin.solReserve / (coin.tokenReserve - amount);
        const pct = ((newPrice - coin.price) / coin.price) * 100;
        const assetUsd = Number.isFinite(coin.pairAssetUsd) ? coin.pairAssetUsd : null;
        const newPriceUsd = assetUsd !== null ? newPrice * assetUsd : null;
        est.textContent = translate('burnPreview', {
          amount: fmtTokens(amount),
          price: fmtPriceBoth(newPriceUsd, newPrice),
          pct: fmtPct(pct),
        });
      } else est.textContent = '';
    };
    input.addEventListener('input', update);
    document.getElementById('maxBurn').addEventListener('click', () => {
      input.value = liveHoldings;
      update();
    });
    document.getElementById('burnBtn').addEventListener('click', async () => {
      const amount = Number(input.value);
      if (!(amount > 0)) return toast(translate('errBurnEnterAmount'));
      await submitBurn(amount);
    });
  }

  function renderBurnHistory() {
    const wrap = document.getElementById('burnHistory');
    const list = burns || [];
    if (!list.length) {
      wrap.innerHTML = `<p class="muted">${translate('burnEmpty')}</p>`;
      return;
    }
    wrap.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>${translate('thTime')}</th><th>${translate('burnHistoryWallet')}</th><th>${translate('burnHistoryAmount')}</th><th>${translate('burnHistoryPrice')}</th><th>${translate('burnHistoryTx')}</th></tr></thead>
        <tbody>
          ${list
            .map(
              (b) => `<tr>
                <td>${fmtTime(b.createdAt)}</td>
                <td>${creatorLink(b.wallet)}${b.wallet === state.wallet ? translate('youSuffix') : ''}</td>
                <td>${fmtTokens(b.amount)}</td>
                <td>${fmtPriceBoth(b.priceAfterUsd, b.priceAfter)}</td>
                <td>${txLink(b.txSignature)}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table></div>`;
  }

  // Real burn flow: validate against the LIVE on-chain balance (re-read
  // from devnet RPC, never the cached value) -> build -> simulate -> sign
  // in Phantom -> send + confirm -> server verifies the burn on-chain and
  // shrinks the curve reserve.
  async function submitBurn(amount) {
    const resEl = document.getElementById('burnResult');
    const btn = document.getElementById('burnBtn');
    const setBusy = (msg) => {
      if (btn) btn.disabled = true;
      resEl.innerHTML = `<p class="muted">${esc(msg)}</p>`;
    };
    const fail = (msg) => {
      if (btn) btn.disabled = false;
      resEl.innerHTML = `<div class="alert alert-error">${msg}</div>`;
    };
    try {
      if (!solanaLibsReady()) throw new Error(translate('errSolanaLibsReload'));
      const phantom = (await waitForPhantom(3000)) || getPhantom();
      if (!phantom) throw new Error(translate('errPhantomShort'));
      if (!(await syncWalletAccount())) {
        throw new Error(translate('errReadAccountShort'));
      }
      // Fresh on-chain balance: the burn fails on-chain when the user
      // holds less, so check first and give a clear error instead of a
      // doomed Phantom popup.
      const liveBalance = await getTokenBalance(coin.mintAddress, state.wallet);
      state.onchainBalances[coin.mintAddress] = liveBalance;
      if (liveBalance < amount) {
        throw new Error(
          translate('burnInsufficient', { bal: fmtTokens(liveBalance), ticker: coin.ticker })
        );
      }
      if (amount >= coin.tokenReserve) {
        throw new Error(
          translate('burnTooLarge', { reserve: fmtTokens(coin.tokenReserve), ticker: coin.ticker })
        );
      }
      setBusy(translate('burnBuilding'));
      const built = await buildBurnTransaction(state.wallet, coin.mintAddress, amount);
      const sim = await simulateTransaction(built.transaction);
      if (!sim.ok) throw new Error(`Simulasi gagal: ${sim.error}`);
      setBusy(translate('burnSigning'));
      const sig = await signAndSend(phantom, built.transaction);
      setBusy(translate('burnVerifying'));
      const res = await apiPost(`/api/coins/${coin.mintAddress}/burn`, {
        wallet: state.wallet,
        amount,
        txSignature: sig,
      });
      const assetUsd = Number.isFinite(res.coin.pairAssetUsd) ? res.coin.pairAssetUsd : null;
      const priceUsd = assetUsd !== null ? res.coin.price * assetUsd : null;
      resEl.innerHTML = `<div class="alert alert-success">${translate('burnSuccess', {
        amount: fmtTokens(amount),
        price: fmtPriceBoth(priceUsd, res.coin.price),
        tx: txLink(sig),
      })}</div>`;
      await refreshBalance();
      renderHeader();
      await refreshOnchainBalances();
      setTimeout(() => renderCoin(mintAddress), 800);
    } catch (err) {
      fail(esc(translate('burnFailed', { msg: friendlyError(err) })));
    }
  }

  // Transfer form on the coin detail page (for holders): recipient address
  // + amount + MAX from the live on-chain balance.
  function renderTransferForm() {
    const form = document.getElementById('transferForm');
    if (!state.wallet) {
      form.innerHTML = `<p class="muted">${translate('tradeConnectFirst')}</p>`;
      return;
    }
    const liveHoldings = state.onchainBalances[coin.mintAddress] || 0;
    form.innerHTML = `
      <div class="field">
        <label>${translate('transferRecipientLabel')}</label>
        <input id="transferTo" type="text" placeholder="${translate('transferRecipientPlaceholder')}" autocapitalize="off" autocomplete="off" spellcheck="false">
      </div>
      <div class="field">
        <label>${translate('transferAmountLabel', { ticker: esc(coin.ticker) })}</label>
        <input id="transferAmount" type="number" min="0" step="any" placeholder="1000000">
        <div class="quick">
          <button class="btn" id="maxTransfer">${translate('burnMaxBtn', { bal: fmtTokens(liveHoldings) })}</button>
        </div>
      </div>
      <button class="btn btn-primary" id="transferBtn">${translate('transferBtn', { ticker: esc(coin.ticker) })}</button>
      <p class="small muted" style="margin-top:8px">${translate('transferNote')}</p>`;
    const input = document.getElementById('transferAmount');
    document.getElementById('maxTransfer').addEventListener('click', () => {
      input.value = liveHoldings;
    });
    document.getElementById('transferBtn').addEventListener('click', async () => {
      const to = document.getElementById('transferTo').value.trim();
      const amount = Number(input.value);
      if (!to) return toast(translate('errTransferInvalidAddress'));
      if (!(amount > 0)) return toast(translate('errTransferEnterAmount'));
      await submitTransfer(coin, to, amount, document.getElementById('transferResult'));
    });
  }
}

// ---------- Follow / unfollow ----------
// Follow state is keyed by wallet address and stored server-side. The
// follower proves ownership by signing a canonical message with Phantom
// (no transaction, no fee) — the server verifies the Ed25519 signature.
async function toggleFollow(targetWallet, currentlyFollowing) {
  if (!state.wallet) {
    toast(translate('errFollowConnectFirst'));
    return;
  }
  if (targetWallet === state.wallet) {
    toast(translate('errFollowSelf'));
    return;
  }
  const phantom = (await waitForPhantom(3000)) || getPhantom();
  if (!phantom) {
    toast(translate('errPhantomShort'));
    return;
  }
  if (typeof phantom.signMessage !== 'function') {
    toast(translate('errNoSignMessage'));
    return;
  }
  const action = currentlyFollowing ? 'unfollow' : 'follow';
  try {
    const message = followMessage(action, targetWallet);
    toast(translate('toastSignFollow'));
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
        ? translate('toastFollowed', { addr: shortAddr(targetWallet) })
        : translate('toastUnfollowed', { addr: shortAddr(targetWallet) })
    );
  } catch (err) {
    toast(translate('errGeneric', { msg: friendlyError(err) }));
  }
}

// Claim accrued creator fees for one coin (from the creator's own profile).
async function claimFeesForCoin(mintAddress, btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await apiPost(`/api/coins/${mintAddress}/claim-fees`, { wallet: state.wallet });
    toast(
      translate('claimSuccessToast', {
        amount: fmtSol(res.claim.amountSol),
        asset: res.claim.assetSymbol || 'SOL',
      })
    );
    await refreshBalance();
    renderHeader();
    route();
  } catch (err) {
    toast(translate('claimFailed', { msg: friendlyError(err) }));
    if (btn) btn.disabled = false;
  }
}

// Shared transfer flow (coin detail page + portfolio): validate the
// recipient address format and the LIVE on-chain balance -> build ->
// simulate -> sign in Phantom -> send + confirm -> server verifies the
// SPL transfer on-chain and records it. `coin` is { mintAddress, ticker };
// `resEl` is the element for status messages (or null for toasts only).
async function submitTransfer(coin, toWallet, amount, resEl) {
  const fail = (msg) => {
    if (resEl) {
      resEl.innerHTML = `<div class="alert alert-error">${msg}</div>`;
    } else {
      toast(msg);
    }
  };
  const setBusy = (msg) => {
    if (resEl) resEl.innerHTML = `<p class="muted">${esc(msg)}</p>`;
  };
  try {
    if (!solanaLibsReady()) throw new Error(translate('errSolanaLibsReload'));
    const phantom = (await waitForPhantom(3000)) || getPhantom();
    if (!phantom) throw new Error(translate('errPhantomShort'));
    if (!(await syncWalletAccount())) {
      throw new Error(translate('errReadAccountShort'));
    }
    // Recipient address format (PublicKey parse) + self-transfer check.
    try {
      const recipient = new solanaWeb3.PublicKey(toWallet);
      if (recipient.toBase58() === state.wallet) {
        throw new Error(translate('errTransferInvalidAddress'));
      }
    } catch {
      throw new Error(translate('errTransferInvalidAddress'));
    }
    // Fresh on-chain balance — the transfer fails on-chain when the user
    // holds less, so check first instead of opening a doomed popup.
    const liveBalance = await getTokenBalance(coin.mintAddress, state.wallet);
    state.onchainBalances[coin.mintAddress] = liveBalance;
    if (liveBalance < amount) {
      throw new Error(
        translate('errTransferInsufficient', { bal: fmtTokens(liveBalance), ticker: coin.ticker })
      );
    }
    setBusy(translate('transferBuilding'));
    const built = await buildTransferTransaction(state.wallet, coin.mintAddress, toWallet, amount);
    const sim = await simulateTransaction(built.transaction);
    if (!sim.ok) throw new Error(`Simulasi gagal: ${sim.error}`);
    setBusy(translate('transferSigning'));
    const sig = await signAndSend(phantom, built.transaction);
    setBusy(translate('transferVerifying'));
    await apiPost('/api/transfers', {
      mintAddress: coin.mintAddress,
      fromWallet: state.wallet,
      toWallet,
      amount,
      txSignature: sig,
    });
    const successHtml = translate('transferSuccess', {
      amount: fmtTokens(amount),
      ticker: esc(coin.ticker),
      addr: esc(shortAddr(toWallet)),
      tx: txLink(sig),
    });
    if (resEl) {
      resEl.innerHTML = `<div class="alert alert-success">${successHtml}</div>`;
    } else {
      toast(successHtml.replace(/<[^>]*>/g, ''));
    }
    await refreshBalance();
    renderHeader();
    await refreshOnchainBalances();
    setTimeout(() => route(), 800);
  } catch (err) {
    fail(esc(translate('transferFailed', { msg: friendlyError(err) })));
  }
}

// ---------- Deposit section (shared: portfolio + own profile) ----------
// Shows the connected wallet's own Solana devnet address as the deposit
// address for SOL and any coin, with a copy button and a QR code (the QR
// library is vendored locally at /vendor/qrcode.js — no CDN). Recent
// incoming transfers are detected live via devnet RPC
// (GET /api/deposits) and labeled as on-chain devnet activity.
function depositSectionHtml(walletAddress) {
  return `
    <h2 style="margin-top:0">${translate('depositTitle')}</h2>
    <p class="small muted">${translate('depositIntro')}</p>
    <div class="deposit-box">
      <div class="deposit-qr" id="depositQr"></div>
      <div class="deposit-addr">
        <div class="label">${translate('depositAddressLabel')}</div>
        <div class="mono" style="word-break:break-all">${esc(walletAddress)}</div>
        <button class="btn btn-sm" id="copyDepositBtn" style="margin-top:8px">${translate('copyBtn')}</button>
      </div>
    </div>
    <p class="small muted" style="margin-top:10px">${translate('depositNote')}</p>
    <h3 style="margin-top:16px">${translate('depositRecentTitle')}</h3>
    <div id="depositList"><p class="muted">${translate('depositLoading')}</p></div>`;
}

function wireDepositSection(walletAddress) {
  // QR code of the deposit address (vendored qrcode-generator).
  const qrEl = document.getElementById('depositQr');
  if (qrEl && typeof window.qrcode === 'function') {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(walletAddress);
      qr.make();
      qrEl.innerHTML = `<img src="${qr.createDataURL(6, 8)}" alt="${translate('depositQrAlt')}" class="deposit-qr-img">`;
    } catch {
      qrEl.innerHTML = '';
    }
  }
  const copyBtn = document.getElementById('copyDepositBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(walletAddress).then(() => toast(translate('depositCopied')));
    });
  }
  // Recent incoming on-chain transfers (server scans devnet RPC).
  const list = document.getElementById('depositList');
  if (!list) return;
  apiGet(`/api/deposits?wallet=${encodeURIComponent(walletAddress)}`)
    .then((data) => {
      const deposits = data.deposits || [];
      if (!deposits.length) {
        list.innerHTML = `<p class="muted">${translate('depositEmpty')}</p>`;
        return;
      }
      list.innerHTML = `
        <div class="table-wrap"><table>
          <thead><tr><th>${translate('thTime')}</th><th>${translate('thType')}</th><th>${translate('thToken')}</th><th>${translate('thWallet')}</th><th>${translate('burnHistoryTx')}</th></tr></thead>
          <tbody>
            ${deposits
              .map(
                (d) => `<tr>
                  <td>${d.time ? fmtTime(d.time) : '—'}</td>
                  <td><span class="badge badge-ok">${translate('depositIncoming')}</span></td>
                  <td>${d.type === 'SOL' ? `${fmtSol(d.amount)} SOL` : `${fmtTokens(d.amount)} ${shortAddr(d.mint)}`}</td>
                  <td>${creatorLink(d.from)}</td>
                  <td>${txLink(d.signature)}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table></div>`;
    })
    .catch((err) => {
      list.innerHTML = `<div class="alert alert-error">${esc(translate('depositFailed', { msg: err.message }))}</div>`;
    });
}

// ---------- Creator profile ----------
async function renderCreator(walletAddress) {
  const view = document.getElementById('view');
  view.innerHTML = `<p class="muted">${translate('loadingProfile')}</p>`;
  let data;
  try {
    const params = state.wallet ? `?viewer=${encodeURIComponent(state.wallet)}` : '';
    data = await apiGet(`/api/creators/${encodeURIComponent(walletAddress)}${params}`);
  } catch (err) {
    view.innerHTML = `<div class="alert alert-error">${esc(translate('errLoadProfile', { msg: err.message }))}</div>
      <p><a href="#/">${translate('backHome')}</a></p>`;
    return;
  }
  const isSelf = data.isSelf;
  const profile = data.profile || null;
  const listProfiles = data.profiles || {};

  const followListHtml = (list, emptyText) => {
    if (!list.length) return `<p class="muted">${emptyText}</p>`;
    return `<ul class="follow-list">${list
      .map(
        (w) => `<li>${avatarHtml(listProfiles[w] || null, w, 24, true)} ${creatorLink(w, displayName(listProfiles[w] || null, w))}${w === state.wallet ? ` <span class="muted">${translate('youSuffix').trim()}</span>` : ''}</li>`
      )
      .join('')}</ul>`;
  };

  view.innerHTML = `
    ${profile && profile.coverUrl ? `<div class="profile-cover"><img src="${esc(profile.coverUrl)}" alt="${translate('profileCoverAlt')}"></div>` : ''}
    <div class="card">
      <div class="coin-head">
        ${avatarHtml(profile, walletAddress, 56)}
        <div>
          <div class="coin-name" style="font-size:1.3rem">${esc(displayName(profile, walletAddress))}</div>
          <div class="small muted mono" style="word-break:break-all">${esc(walletAddress)}</div>
        </div>
        <span class="badge ${isSelf ? 'badge-ok' : 'badge-live'}" style="margin-left:auto">${isSelf ? translate('profileSelf') : translate('profileCreatorTrader')}</span>
        ${isSelf ? `<button class="btn btn-sm" id="editProfileBtn">${translate('profileEditBtn')}</button>` : ''}
        ${state.wallet && !isSelf
          ? `<button class="btn btn-sm ${data.isFollowing ? '' : 'btn-primary'}" id="profileFollowBtn">${data.isFollowing ? translate('followFollowing') : translate('followBtn')}</button>`
          : ''}
      </div>
      <div class="stat-grid" style="margin-top:16px">
        <div class="stat"><div class="label">${translate('profileCoinsCreated')}</div><div class="value">${data.coins.length}</div></div>
        <div class="stat"><div class="label">${translate('profileVolume')}</div><div class="value">${fmtMoneyBoth(data.totalVolumeUsd, data.totalVolumeSol)}</div></div>
        <div class="stat"><div class="label">${translate('profileFeesEarned')}</div><div class="value">${fmtMoneyBoth(data.totalFeesEarnedUsd, data.totalFeesEarnedSol)}</div></div>
        <div class="stat"><div class="label">${translate('profileFeesClaimed')}</div><div class="value">${fmtSol(data.totalFeesClaimedSol)} SOL</div></div>
        <div class="stat"><div class="label">${translate('profileFeesClaimable')}</div><div class="value">${fmtSol(data.totalFeesUnclaimedSol)} SOL</div></div>
        <div class="stat"><div class="label">${translate('profileFollowers')}</div><div class="value">${data.followerCount}</div></div>
        <div class="stat"><div class="label">${translate('profileFollowing')}</div><div class="value">${data.followingCount}</div></div>
      </div>
      <p style="margin-top:12px"><a href="${EXPLORER}/address/${esc(walletAddress)}?cluster=devnet" target="_blank" rel="noopener">${translate('profileExplorer')}</a></p>
    </div>

    ${isSelf ? `<div class="card" id="editProfileCard" hidden>
      <h2 style="margin-top:0">${translate('profileEditTitle')}</h2>
      <div class="field">
        <label for="editUsername">${translate('profileUsernameLabel')}</label>
        <input id="editUsername" type="text" maxlength="20" placeholder="${translate('profileUsernamePlaceholder')}" value="${esc((profile && profile.username) || '')}" autocapitalize="off" autocomplete="off" spellcheck="false">
        <div class="hint">${translate('profileUsernameHint')}</div>
      </div>
      <div class="field">
        <label>${translate('profileBorderLabel')}</label>
        <div class="border-picker">
          ${BORDER_PRESETS.map(
            (p) => `<label class="border-option">
              <input type="radio" name="editBorder" value="${p.key}" ${((profile && profile.border) || 'none') === p.key ? 'checked' : ''}>
              <span class="border-swatch avatar-ring avatar-ring-${p.key}">${translate(p.labelKey)}</span>
            </label>`
          ).join('')}
        </div>
        <div class="hint">${translate('profileBorderHint')}</div>
      </div>
      <div class="field">
        <label for="editAvatar">${translate('profilePhotoLabel')}</label>
        ${profile && profile.avatarUrl ? `<div style="margin-bottom:8px">${avatarHtml(profile, walletAddress, 56)} <span class="small muted">${translate('profileCurrentPhoto')}</span></div>` : ''}
        <input id="editAvatar" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
        <div class="hint">${translate('profilePhotoHint')}</div>
        ${profile && profile.avatarUrl ? `<label class="check-row" style="margin-top:6px"><input type="checkbox" id="removeAvatar"> ${translate('profileRemovePhoto')}</label>` : ''}
      </div>
      <div class="field">
        <label for="editCover">${translate('profileCoverLabel')}</label>
        ${profile && profile.coverUrl ? `<div class="profile-cover profile-cover-small" style="margin-bottom:8px"><img src="${esc(profile.coverUrl)}" alt="${translate('profileCoverAlt')}"></div>` : ''}
        <input id="editCover" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
        <div class="hint">${translate('profileCoverHint')}</div>
        ${profile && profile.coverUrl ? `<label class="check-row" style="margin-top:6px"><input type="checkbox" id="removeCover"> ${translate('profileRemoveCover')}</label>` : ''}
      </div>
      <p class="small muted">${translate('profileEphemeralNote')}</p>
      <div class="row" style="justify-content:flex-start">
        <button class="btn btn-primary" id="saveProfileBtn">${translate('profileSaveBtn')}</button>
        <button class="btn" id="cancelEditBtn">${translate('profileCancelBtn')}</button>
      </div>
      <div id="editProfileResult" style="margin-top:8px"></div>
    </div>` : ''}

    ${isSelf ? `<div class="card" id="depositCard">${depositSectionHtml(walletAddress)}</div>` : ''}

    <div class="card">
      <h2 style="margin-top:0">${translate('profileCoinsTitle', { n: data.coins.length })}</h2>
      ${data.coins.length === 0
        ? `<p class="muted">${translate('profileNoCoins')}</p>`
        : `<div class="coin-grid">${data.coins.map(coinCard).join('')}</div>`}
    </div>

    <div class="card">
      <h2 style="margin-top:0">${translate('calloutsTitle', { n: (data.callouts || []).length })}</h2>
      ${(data.callouts || []).length === 0
        ? `<p class="muted">${translate('profileNoCallouts')}</p>`
        : (data.callouts || []).map((c) => calloutHtml(c, { showCoin: true })).join('')}
    </div>

    ${isSelf && data.coins.some((c) => c.feesUnclaimedSol > 0)
      ? `<div class="card">
          <h2 style="margin-top:0">${translate('profileClaimTitle')}</h2>
          <p class="small muted">${translate('feeClaimNoteShort')}</p>
          ${data.coins
            .filter((c) => c.feesUnclaimedSol > 0)
            .map(
              (c) => `<div class="row" style="margin-top:8px">
                <span>${translate('profileClaimRow', { ticker: esc(c.ticker), amount: fmtSol(c.feesUnclaimedSol), asset: esc((c.pairAsset && c.pairAsset.symbol) || 'SOL') })}</span>
                <button class="btn btn-sm btn-primary" data-claim="${esc(c.mintAddress)}">${translate('feeClaimBtn', { amount: fmtSol(c.feesUnclaimedSol), asset: esc((c.pairAsset && c.pairAsset.symbol) || 'SOL') })}</button>
              </div>`
            )
            .join('')}
        </div>`
      : ''}

    <div class="grid-2">
      <div class="card">
        <h2 style="margin-top:0">${translate('profileFollowersTitle', { n: data.followerCount })}</h2>
        ${followListHtml(data.followers, translate('followersEmpty'))}
      </div>
      <div class="card">
        <h2 style="margin-top:0">${translate('profileFollowingTitle', { n: data.followingCount })}</h2>
        ${followListHtml(data.following, translate('followingEmpty'))}
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
  if (isSelf) {
    wireDepositSection(walletAddress);
    wireEditProfile(walletAddress, profile);
  }

  // Edit-profile form (owner only). Saving proves wallet ownership with
  // a Phantom signMessage signature over the canonical profile message
  // (same scheme as follows) — the server rebuilds the message from the
  // submitted fields and verifies the signature before saving anything.
  function wireEditProfile(wallet, currentProfile) {
    const card = document.getElementById('editProfileCard');
    const toggleBtn = document.getElementById('editProfileBtn');
    if (!card || !toggleBtn) return;
    toggleBtn.addEventListener('click', () => {
      card.hidden = !card.hidden;
      if (!card.hidden) card.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
    document.getElementById('cancelEditBtn').addEventListener('click', () => {
      card.hidden = true;
    });
    document.getElementById('saveProfileBtn').addEventListener('click', async () => {
      const btn = document.getElementById('saveProfileBtn');
      const resEl = document.getElementById('editProfileResult');
      const fail = (msg) => {
        resEl.innerHTML = `<div class="alert alert-error">${esc(msg)}</div>`;
        btn.disabled = false;
      };
      btn.disabled = true;
      resEl.innerHTML = `<p class="muted">${translate('profileSaving')}</p>`;
      try {
        const usernameRaw = document.getElementById('editUsername').value.trim();
        const username = usernameRaw === '' ? null : usernameRaw;
        if (username !== null && !/^[A-Za-z0-9_]{3,20}$/.test(username)) {
          fail(translate('errUsernameInvalid'));
          return;
        }
        const border =
          document.querySelector('input[name="editBorder"]:checked')?.value || 'none';
        // New images (if any): read as base64, same as the coin-logo
        // upload. A checked "remove" box clears the image instead.
        const readImageFile = (file) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const dataUrl = reader.result;
              resolve({
                dataBase64: dataUrl.split(',')[1],
                mimeType: file.type,
              });
            };
            reader.onerror = () => reject(new Error('read'));
            reader.readAsDataURL(file);
          });
        let avatar;
        const avatarFile = document.getElementById('editAvatar').files[0];
        if (avatarFile) avatar = await readImageFile(avatarFile);
        else if (document.getElementById('removeAvatar')?.checked) avatar = null;
        let cover;
        const coverFile = document.getElementById('editCover').files[0];
        if (coverFile) cover = await readImageFile(coverFile);
        else if (document.getElementById('removeCover')?.checked) cover = null;

        const phantom = (await waitForPhantom(3000)) || getPhantom();
        if (!phantom) throw new Error(translate('errPhantomShort'));
        if (typeof phantom.signMessage !== 'function') {
          throw new Error(translate('errNoSignMessage'));
        }
        // The message binds the submitted fields (image content via its
        // sha256) — the server rebuilds it identically and verifies.
        const message = profileMessage({
          wallet,
          username: username || '',
          border,
          avatarHash: avatar ? await sha256Hex(avatar.dataBase64) : '',
          coverHash: cover ? await sha256Hex(cover.dataBase64) : '',
        });
        toast(translate('profileSigning'));
        const signature = await signWalletMessage(phantom, message);
        await apiPost(`/api/profiles/${wallet}`, {
          username,
          border,
          avatar,
          cover,
          message,
          signature,
        });
        toast(translate('profileSaved'));
        renderCreator(wallet);
      } catch (err) {
        fail(translate('profileSaveFailed', { msg: friendlyError(err) }));
      }
    });
  }
}

// ---------- Chart (SVG area chart with time axis + tooltip) ----------
function renderChartEl(wrap, points, range) {
  let pts = points;
  if (range > 0 && points.length > range + 1) {
    pts = [points[0], ...points.slice(points.length - range)];
  }
  if (pts.length < 2) {
    wrap.innerHTML =
      `<p class="muted" style="padding:40px 0;text-align:center">${translate('chartEmpty')}</p>`;
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
  const color = up ? '#5ddf6c' : '#f87171'; // pump.fun gain/loss
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
      <text x="${PAD_L}" y="${H - 6}" fill="#a1a1aa" font-size="13">${esc(fmtAxisTime(t0))}</text>
      <text x="${W - PAD_R}" y="${H - 6}" fill="#a1a1aa" font-size="13" text-anchor="end">${esc(fmtAxisTime(t1))}</text>
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
    const sideLabel = !best.side
      ? translate('chartLaunch')
      : best.side === 'burn'
        ? translate('chartBurn')
        : best.side === 'buy'
          ? translate('chartBuy')
          : translate('chartSell');
    tip.innerHTML = `${esc(fmtTime(best.t))}<br><b>${fmtPriceBoth(best.priceUsd, best.price)}</b> • ${sideLabel}`;
  });
  svg.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
  });
}

// ---------- Candlestick chart (SVG, OHLC per time bucket + volume bars) ----------
// Candles come from the server (GET /api/coins/:mint/candles) — one
// implementation, shared with the tests. Green/red use the pump.fun
// gain/loss colors; empty buckets produce no candle (gaps, never zeroes).
async function renderCandleChartEl(wrap, mintAddress, timeframe) {
  let data;
  try {
    data = await apiGet(`/api/coins/${mintAddress}/candles?timeframe=${timeframe}`);
  } catch (err) {
    wrap.innerHTML = `<div class="alert alert-error">${esc(translate('errLoadCoin', { msg: err.message }))}</div>`;
    return;
  }
  const candles = data.candles || [];
  if (!candles.length) {
    wrap.innerHTML =
      `<p class="muted" style="padding:40px 0;text-align:center">${translate('candlesEmpty')}</p>`;
    return;
  }
  const W = 1000;
  const H = 300;
  const PAD_L = 8;
  const PAD_R = 8;
  const PAD_T = 12;
  const PAD_B = 24;
  const CHART_H = H - PAD_T - PAD_B - 40; // leave 40px at the bottom for volume bars
  const t0 = candles[0].t;
  const t1 = candles[candles.length - 1].t;
  const span = Math.max(1, t1 - t0);
  let min = Infinity;
  let max = -Infinity;
  let maxVol = 0;
  for (const c of candles) {
    if (c.low < min) min = c.low;
    if (c.high > max) max = c.high;
    if (c.volume > maxVol) maxVol = c.volume;
  }
  if (max === min) {
    max = min * 1.1 || 1;
    min = min * 0.9;
  }
  const padY = (max - min) * 0.1;
  min -= padY;
  max += padY;
  const x = (t) => PAD_L + ((t - t0) / span) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - min) / (max - min)) * CHART_H;
  // Candle width from the spacing between bucket starts (bounded so one
  // candle doesn't fill the chart).
  const spacing = candles.length > 1 ? (x(candles[1].t) - x(candles[0].t)) : 40;
  const bodyW = Math.max(2, Math.min(24, spacing * 0.6));
  const fmtAxisTime = (t) =>
    new Date(t).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const priceLabel = (c) => {
    const usd = (v) => (Number.isFinite(c.openUsd) ? fmtPriceUsd(v) : null);
    return translate('candleTooltip', {
      open: usd(c.openUsd) || fmtPrice(c.open),
      high: usd(c.highUsd) || fmtPrice(c.high),
      low: usd(c.lowUsd) || fmtPrice(c.low),
      close: usd(c.closeUsd) || fmtPrice(c.close),
      volume: fmtSol(c.volume),
    });
  };
  const bodies = candles
    .map((c) => {
      const up = c.close >= c.open;
      const color = up ? '#5ddf6c' : '#f87171'; // pump.fun gain/loss
      const cx = x(c.t);
      const top = y(Math.max(c.open, c.close));
      const bottom = y(Math.min(c.open, c.close));
      const h = Math.max(1, bottom - top);
      const volH = maxVol > 0 ? (c.volume / maxVol) * 36 : 0;
      return `<g data-candle="${c.t}" data-tip="${esc(priceLabel(c))}">
        <line x1="${cx}" y1="${y(c.high)}" x2="${cx}" y2="${y(c.low)}" stroke="${color}" stroke-width="1.5"/>
        <rect x="${cx - bodyW / 2}" y="${top}" width="${bodyW}" height="${h}" fill="${color}"/>
        <rect x="${cx - bodyW / 2}" y="${PAD_T + CHART_H + 40 - volH}" width="${bodyW}" height="${volH}" fill="${color}" opacity="0.45"/>
      </g>`;
    })
    .join('');
  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" id="chartSvg">
      ${bodies}
      <text x="${PAD_L}" y="${H - 6}" fill="#a1a1aa" font-size="13">${esc(fmtAxisTime(t0))}</text>
      <text x="${W - PAD_R}" y="${H - 6}" fill="#a1a1aa" font-size="13" text-anchor="end">${esc(fmtAxisTime(t1))}</text>
    </svg>
    <div class="chart-tip" id="chartTip"></div>`;
  const svg = document.getElementById('chartSvg');
  const tip = document.getElementById('chartTip');
  svg.addEventListener('mousemove', (e) => {
    const g = e.target.closest('[data-candle]');
    if (!g) {
      tip.style.display = 'none';
      return;
    }
    const rect = svg.getBoundingClientRect();
    tip.style.display = 'block';
    tip.style.left = `${Math.min(Math.max(e.clientX - rect.left + 12, 0), rect.width - 220)}px`;
    tip.style.top = `${Math.max(e.clientY - rect.top - 40, 0)}px`;
    tip.innerHTML = `${esc(fmtTime(Number(g.dataset.candle)))}<br>${g.dataset.tip}`;
  });
  svg.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
  });
}

// ---------- Portfolio ----------
async function renderPortfolio() {
  const view = document.getElementById('view');
  view.innerHTML = `<h1>${translate('navPortfolio')}</h1>`;
  if (!state.wallet) {
    view.innerHTML += `
      <div class="card empty">
        <h2>${translate('portfolioConnectTitle')}</h2>
        <p>${translate('portfolioConnectBody')}</p>
        <p><button class="btn btn-primary" id="connectPf">${translate('headerConnect')}</button></p>
      </div>`;
    document.getElementById('connectPf').onclick = connectWallet;
    return;
  }
  view.innerHTML += `<p class="muted">${translate('loadingPortfolio')}</p>`;
  let data;
  try {
    [data] = await Promise.all([
      apiGet(`/api/portfolio?wallet=${encodeURIComponent(state.wallet)}`),
      refreshOnchainBalances(),
    ]);
  } catch (err) {
    view.innerHTML += `<div class="alert alert-error">${esc(translate('errLoadPortfolio', { msg: err.message }))}</div>`;
    return;
  }
  const s = data.summary;
  const cls = s.totalPnlSol >= 0 ? 'profit' : 'loss';
  view.innerHTML = `
    <h1>${translate('navPortfolio')}</h1>
    <p class="muted">${translate('portfolioIntro', { wallet: esc(state.wallet) })}</p>
    <div class="card">
      <div class="stat-grid">
        <div class="stat"><div class="label">${translate('pnlTotal')}</div><div class="value ${cls}">${fmtMoneyBoth(s.totalPnlUsd, s.totalPnlSol, true)} (${fmtPct(s.totalPnlPct)})</div></div>
        <div class="stat"><div class="label">${translate('pnlCurrentValue')}</div><div class="value">${fmtMoneyBoth(s.totalCurrentValueUsd, s.totalCurrentValueSol)}</div></div>
        <div class="stat"><div class="label">${translate('pnlCostBasis')}</div><div class="value">${fmtMoneyBoth(s.totalCostBasisUsd, s.totalCostBasisSol)}</div></div>
        <div class="stat"><div class="label">${translate('pnlRealized')}</div><div class="value ${s.totalRealizedPnlSol >= 0 ? 'profit' : 'loss'}">${fmtMoneyBoth(s.totalRealizedPnlUsd, s.totalRealizedPnlSol, true)}</div></div>
        <div class="stat"><div class="label">${translate('pnlUnrealized')}</div><div class="value ${s.totalUnrealizedPnlSol >= 0 ? 'profit' : 'loss'}">${fmtMoneyBoth(s.totalUnrealizedPnlUsd, s.totalUnrealizedPnlSol, true)}</div></div>
        <div class="stat"><div class="label">${translate('portfolioTotalBuy')}</div><div class="value">${fmtSol(s.totalBuySol)} SOL</div></div>
        <div class="stat"><div class="label">${translate('portfolioTotalSell')}</div><div class="value">${fmtSol(s.totalSellSol)} SOL</div></div>
        <div class="stat"><div class="label">${translate('portfolioCoinsTrades')}</div><div class="value">${s.coinCount} • ${s.totalTrades}</div></div>
      </div>
    </div>
    <div class="card" id="depositCard">${depositSectionHtml(state.wallet)}</div>
    <div class="card">
      <h2 style="margin-top:0">${translate('portfolioPositionsTitle')}</h2>
      ${
        data.positions.length === 0
          ? `<p class="muted">${translate('portfolioEmpty')}</p>`
          : `<div class="table-wrap"><table>
              <thead><tr><th>${translate('pfCoin')}</th><th>${translate('pfHoldings')}</th><th>${translate('pfOnchain')}</th><th>${translate('pfAvgPrice')}</th><th>${translate('pfCurrentPrice')}</th><th>${translate('pfMarketCap')}</th><th>${translate('pfValue')}</th><th>${translate('pfPnl')}</th><th>${translate('pfRoi')}</th><th></th></tr></thead>
              <tbody>
                ${data.positions
                  .map(
                    (p) => {
                      const asset = (p.pairAsset && p.pairAsset.symbol) || 'SOL';
                      return `<tr>
                      <td><a href="#/coin/${esc(p.mintAddress)}"><b>${esc(p.name)}</b> <span class="muted">$${esc(p.ticker)}</span></a><div class="small muted">${esc(p.pairLabel || '')}</div></td>
                      <td>${fmtTokens(p.holdings)}</td>
                      <td>${fmtTokens(state.onchainBalances[p.mintAddress] || 0)}</td>
                      <td>${fmtPriceBoth(p.avgBuyPriceUsd, p.avgBuyPrice)}</td>
                      <td>${fmtPriceBoth(p.priceUsd, p.price)}</td>
                      <td>${fmtMarketCap(p)}</td>
                      <td>${fmtMoneyBoth(p.currentValueUsd, p.currentValueSol, false, asset)}</td>
                      <td class="${p.totalPnlSol >= 0 ? 'profit' : 'loss'}">${fmtMoneyBoth(p.totalPnlUsd, p.totalPnlSol, true, asset)}</td>
                      <td class="${p.totalPnlSol >= 0 ? 'profit' : 'loss'}">${fmtPct(p.roiPct)}</td>
                      <td><a class="btn btn-sm" href="#/coin/${esc(p.mintAddress)}">${translate('viewBtn')}</a> <button class="btn btn-sm" data-transfer="${esc(p.mintAddress)}" data-ticker="${esc(p.ticker)}">${translate('transferSendBtn')}</button></td>
                    </tr>`;
                    }
                  )
                  .join('')}
              </tbody>
            </table></div>`
      }
    </div>
    <div class="card" id="portfolioTransferCard" hidden>
      <h2 style="margin-top:0">${translate('transferTitle')}</h2>
      <div id="portfolioTransferForm"></div>
      <div id="portfolioTransferResult" style="margin-top:8px"></div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">${translate('transferHistoryTitle')}</h2>
      <div id="transferHistory"></div>
    </div>`;

  wireDepositSection(state.wallet);
  renderTransferHistory(data.transfers || []);

  // Per-holding transfer: clicking "Kirim" opens the transfer card below
  // the positions table, pre-filled with that coin.
  view.querySelectorAll('[data-transfer]').forEach((b) => {
    b.addEventListener('click', () => {
      const mint = b.dataset.transfer;
      const ticker = b.dataset.ticker;
      const card = document.getElementById('portfolioTransferCard');
      const form = document.getElementById('portfolioTransferForm');
      const liveHoldings = state.onchainBalances[mint] || 0;
      card.hidden = false;
      form.innerHTML = `
        <div class="field">
          <label>${translate('transferRecipientLabel')}</label>
          <input id="pfTransferTo" type="text" placeholder="${translate('transferRecipientPlaceholder')}" autocapitalize="off" autocomplete="off" spellcheck="false">
        </div>
        <div class="field">
          <label>${translate('transferAmountLabel', { ticker: esc(ticker) })}</label>
          <input id="pfTransferAmount" type="number" min="0" step="any" placeholder="1000000">
          <div class="quick">
            <button class="btn" id="pfMaxTransfer">${translate('burnMaxBtn', { bal: fmtTokens(liveHoldings) })}</button>
          </div>
        </div>
        <button class="btn btn-primary" id="pfTransferBtn">${translate('transferBtn', { ticker: esc(ticker) })}</button>
        <p class="small muted" style="margin-top:8px">${translate('transferNote')}</p>`;
      const input = document.getElementById('pfTransferAmount');
      document.getElementById('pfMaxTransfer').addEventListener('click', () => {
        input.value = liveHoldings;
      });
      document.getElementById('pfTransferBtn').addEventListener('click', async () => {
        const to = document.getElementById('pfTransferTo').value.trim();
        const amount = Number(input.value);
        if (!to) return toast(translate('errTransferInvalidAddress'));
        if (!(amount > 0)) return toast(translate('errTransferEnterAmount'));
        await submitTransfer(
          { mintAddress: mint, ticker },
          to,
          amount,
          document.getElementById('portfolioTransferResult')
        );
      });
      card.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
  });

  function renderTransferHistory(transfers) {
    const wrap = document.getElementById('transferHistory');
    if (!transfers.length) {
      wrap.innerHTML = `<p class="muted">${translate('transferEmpty')}</p>`;
      return;
    }
    wrap.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>${translate('thTime')}</th><th>${translate('thType')}</th><th>${translate('pfCoin')}</th><th>${translate('thToken')}</th><th>${translate('thWallet')}</th><th>${translate('burnHistoryTx')}</th></tr></thead>
        <tbody>
          ${transfers
            .map((tr) => {
              const sent = tr.fromWallet === state.wallet;
              const other = sent ? tr.toWallet : tr.fromWallet;
              return `<tr>
                <td>${fmtTime(tr.createdAt)}</td>
                <td><span class="badge ${sent ? 'badge-sell' : 'badge-buy'}">${sent ? translate('transferSent') : translate('transferReceived')}</span></td>
                <td><a href="#/coin/${esc(tr.mintAddress)}"><b>${esc(tr.coinName || tr.coinTicker || shortAddr(tr.mintAddress))}</b> <span class="muted">$${esc(tr.coinTicker || '')}</span></a></td>
                <td>${fmtTokens(tr.amount)}</td>
                <td>${creatorLink(other)}${other === state.wallet ? translate('youSuffix') : ''}</td>
                <td>${txLink(tr.txSignature)}</td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table></div>`;
  }
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
      toast(translate('toastAccountChanged', { addr: shortAddr(state.wallet) }));
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

// Fill the footer pool-address slot. Re-run after a language switch:
// applyStaticI18n rebuilds the footer's innerHTML (the pool address link
// is inside the translated footer text), so the link must be restored.
function fillPoolAddress() {
  const el = document.getElementById('poolAddress');
  if (el && state.poolAddress) {
    el.innerHTML = `<a class="mono" href="${EXPLORER}/address/${esc(state.poolAddress)}?cluster=devnet" target="_blank" rel="noopener">${esc(shortAddr(state.poolAddress))} ↗</a>`;
  }
}

loadPoolAddress().then(fillPoolAddress);
wirePhantom();
window.addEventListener('load', wirePhantom);

renderHeader();
route();
