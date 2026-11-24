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

// ---------- Theme Management ----------
const THEME_KEY = 'solpump-theme';
const THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)';

function getStoredTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function getSystemTheme() {
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(THEME_MEDIA_QUERY).matches ? 'dark' : 'light';
  }
  return 'light';
}

function getEffectiveTheme() {
  const stored = getStoredTheme();
  if (stored === 'light' || stored === 'dark') return stored;
  return getSystemTheme();
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', theme === 'dark');
    toggle.setAttribute('data-tooltip', translate(theme === 'dark' ? 'themeLight' : 'themeDark'));
  }
  // Update meta theme-color
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', theme === 'dark' ? '#86efac' : '#00c805');
  }
}

function initTheme() {
  const theme = getEffectiveTheme();
  applyTheme(theme);

  // Listen for system theme changes
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia(THEME_MEDIA_QUERY);
    mq.addEventListener?.('change', (e) => {
      const stored = getStoredTheme();
      if (!stored) {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    });
  }

  // Theme toggle button
  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const current = getStoredTheme() || getSystemTheme();
      const next = current === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* storage unavailable */
      }
      applyTheme(next);
    });
  }
}

// ---------- State ----------
// Coin-detail render sequence: renderCoin is async, and a second render
// (fast navigation, a double hashchange) can start while the first is
// still awaiting. Each render captures its sequence number and bails
// after every await when a newer render has begun — otherwise the stale
// render writes into DOM the newer one already replaced (or wiped with
// the loading state), crashing on missing elements.
let coinRenderSeq = 0;
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
  isAdmin: false, // is the connected wallet in ADMIN_WALLETS? (server check)
  adminCheckedWallet: null, // wallet the cached isAdmin applies to
  // UI state
  sidebarOpen: false,
  onboardingShown: false,
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

function fmtHolderSharePct(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return '0%';
  if (n < 0.0001) return '<0,0001%';
  return `${n.toLocaleString('id-ID', { maximumFractionDigits: 4 })}%`;
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

// ---------- Toast System (new) ----------
let toastId = 0;
const toastContainer = document.getElementById('toastContainer');

function toast(msg, type = 'info', duration = 3500) {
  if (!toastContainer) return;

  const id = ++toastId;
  const toastEl = document.createElement('div');
  toastEl.className = `toast toast-${type}`;
  toastEl.setAttribute('role', 'alert');
  toastEl.setAttribute('aria-live', 'polite');
  toastEl.dataset.toastId = id;

  // Icon based on type
  const icons = {
    success: '✓',
    danger: '✕',
    warning: '⚠',
    info: 'ℹ'
  };

  toastEl.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${icons[type] || icons.info}</span>
    <span class="toast-message">${esc(msg)}</span>
    <button class="toast-dismiss" aria-label="${translate('toastDismiss')}" aria-hidden="true">✕</button>
  `;

  toastContainer.appendChild(toastEl);

  // Trigger animation
  requestAnimationFrame(() => {
    toastEl.classList.add('show');
  });

  // Dismiss button
  toastEl.querySelector('.toast-dismiss').addEventListener('click', () => {
    dismissToast(toastEl);
  });

  // Auto dismiss
  if (duration > 0) {
    setTimeout(() => dismissToast(toastEl), duration);
  }

  return id;
}

function dismissToast(toastEl) {
  if (!toastEl || toastEl.classList.contains('hiding')) return;
  toastEl.classList.add('hiding');
  toastEl.addEventListener('animationend', () => {
    toastEl.remove();
  }, { once: true });
}

function dismissAllToasts() {
  if (!toastContainer) return;
  toastContainer.querySelectorAll('.toast').forEach(dismissToast);
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

async function apiPut(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(translateError(data.error || `HTTP ${res.status}`));
  return data;
}

async function apiDelete(url, body) {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
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

// Verified checkmark (✓) next to a name, when the profile carries
// verified: true (earned automatically: one of their coins graduated or
// reached $100K market cap). `profile` may be null.
function verifiedBadgeHtml(profile) {
  if (!profile || !profile.verified) return '';
  return `<span class="verified-badge" title="${translate('verifiedRuleShort')}">✓</span>`;
}

// Community badge icons next to a username (Creator, Early Bird, Top
// Trader, Callout Star, Whale). Each badge carries its i18n name/desc
// keys; the icon is an emoji from the server. Empty string when none.
function badgesHtml(badges) {
  if (!badges || !badges.length) return '';
  return `<span class="badges">${badges
    .map(
      (b) =>
        `<span class="badge-icon" title="${esc(translate(b.nameKey))} — ${esc(translate(b.descKey))}">${esc(b.icon)}</span>`
    )
    .join('')}</span>`;
}

// Category badge for coin cards and the detail page (translated label).
function categoryBadgeHtml(category) {
  if (!category) return '';
  return `<span class="badge badge-category">${esc(categoryLabel(category))}</span>`;
}

// ---------- Generic modal ----------
// A single reusable modal overlay, created lazily on first use. Content
// is HTML; the caller wires any buttons inside after showing it.
function ensureModal() {
  let overlay = document.getElementById('modalOverlay');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'modalOverlay';
  overlay.className = 'modal-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <button class="btn btn-sm modal-close" id="modalCloseBtn" aria-label="${translate('closeBtn')}">✕</button>
    <div id="modalBody"></div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideModal();
  });
  document.getElementById('modalCloseBtn').addEventListener('click', hideModal);
  return overlay;
}

function showModal(html) {
  const overlay = ensureModal();
  document.getElementById('modalBody').innerHTML = html;
  overlay.hidden = false;
}

function hideModal() {
  const overlay = document.getElementById('modalOverlay');
  if (overlay) overlay.hidden = true;
}

// ---------- 18+ age confirmation ----------
// One-time, client-side only: the API just exposes is_adult. Stored in
// localStorage so the viewer is asked once per browser.
const AGE_CONFIRM_KEY = 'solpump-age-confirmed';

function isAgeConfirmed() {
  try {
    return localStorage.getItem(AGE_CONFIRM_KEY) === 'yes';
  } catch {
    return false;
  }
}

// Shows the age-confirm modal; `onConfirm` runs after the viewer confirms
// (and is persisted). The "leave" button just closes the modal.
function showAgeConfirmModal(onConfirm) {
  showModal(`
    <h2 style="margin-top:0">${translate('adultConfirmTitle')}</h2>
    <p>${translate('adultConfirmBody')}</p>
    <div class="row" style="justify-content:flex-start">
      <button class="btn btn-primary" id="ageConfirmYes">${translate('adultConfirmYes')}</button>
      <button class="btn" id="ageConfirmNo">${translate('adultConfirmNo')}</button>
    </div>`);
  document.getElementById('ageConfirmYes').addEventListener('click', () => {
    try {
      localStorage.setItem(AGE_CONFIRM_KEY, 'yes');
    } catch {
      /* storage unavailable — confirmation lasts for this session only */
    }
    hideModal();
    if (onConfirm) onConfirm();
  });
  document.getElementById('ageConfirmNo').addEventListener('click', hideModal);
}

// ---------- Collapsible sidebar ----------
// Desktop: the header toggle collapses the sidebar to a slim icon-only
// rail (class `sidebar-collapsed` on .app-shell); the content column
// expands to fill the freed space (flex). The state persists in
// localStorage across reloads. Mobile (<=767px): the sidebar is an
// overlay drawer and the same toggle opens/closes it (class
// `sidebar-open`, transient — the drawer always starts closed); tapping
// the scrim or a nav link closes it.
const SIDEBAR_COLLAPSED_KEY = 'solpump-sidebar-collapsed';
const MOBILE_SIDEBAR_QUERY = '(max-width: 767px)';

function isMobileSidebar() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia(MOBILE_SIDEBAR_QUERY).matches
  );
}

function isSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function applySidebarState() {
  const shell = document.getElementById('appShell');
  const toggle = document.getElementById('sidebarToggle');
  const scrim = document.getElementById('sidebarScrim');
  if (!shell || !toggle) return;
  const mobile = isMobileSidebar();
  if (!mobile) {
    shell.classList.remove('sidebar-open');
  }
  const drawerOpen = shell.classList.contains('sidebar-open');
  state.sidebarOpen = drawerOpen;
  document.body.classList.toggle('sidebar-drawer-open', mobile && drawerOpen);
  shell.classList.toggle('sidebar-collapsed', !mobile && isSidebarCollapsed());
  if (scrim) {
    scrim.hidden = !mobile || !drawerOpen;
    scrim.setAttribute('aria-hidden', !drawerOpen);
  }
  // Icon + tooltip follow the mode: chevrons collapse/expand on desktop,
  // hamburger/X open/close the drawer on mobile.
  let icon;
  let labelKey;
  if (mobile) {
    icon = drawerOpen ? '✕' : '☰';
    labelKey = drawerOpen ? 'sidebarCloseMenu' : 'sidebarOpenMenu';
    toggle.setAttribute('aria-expanded', drawerOpen);
  } else if (isSidebarCollapsed()) {
    icon = '»';
    labelKey = 'sidebarExpand';
    toggle.setAttribute('aria-expanded', 'false');
  } else {
    icon = '«';
    labelKey = 'sidebarCollapse';
    toggle.setAttribute('aria-expanded', 'true');
  }
  toggle.innerHTML = `<span aria-hidden="true">${icon}</span><span class="sr-only">${translate(labelKey)}</span>`;
  toggle.title = translate(labelKey);
  toggle.setAttribute('aria-label', translate(labelKey));
}

function toggleSidebar() {
  const shell = document.getElementById('appShell');
  if (!shell) return;
  if (isMobileSidebar()) {
    shell.classList.toggle('sidebar-open');
  } else {
    const collapsed = !isSidebarCollapsed();
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      /* storage unavailable — the collapse lasts for this session only */
    }
  }
  applySidebarState();
}

function closeSidebarDrawer() {
  const shell = document.getElementById('appShell');
  if (!shell || !shell.classList.contains('sidebar-open')) return;
  shell.classList.remove('sidebar-open');
  applySidebarState();
  // Return focus to toggle button
  const toggle = document.getElementById('sidebarToggle');
  if (toggle) toggle.focus();
}

function wireSidebar() {
  const toggle = document.getElementById('sidebarToggle');
  if (toggle) toggle.addEventListener('click', toggleSidebar);
  const liveGroup = document.querySelector('.nav-group[data-nav-group="live"]');
  const liveToggle = liveGroup?.querySelector('.nav-group-toggle');
  if (liveToggle) {
    liveToggle.addEventListener('click', () => {
      const expanded = liveToggle.getAttribute('aria-expanded') === 'true';
      liveToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      liveGroup?.classList.toggle('open', !expanded);
    });
  }
  const scrim = document.getElementById('sidebarScrim');
  if (scrim) scrim.addEventListener('click', closeSidebarDrawer);
  // Tapping a nav link closes the mobile drawer (harmless on desktop).
  document.querySelectorAll('.sidebar .nav a').forEach((a) => {
    a.addEventListener('click', closeSidebarDrawer);
  });
  // Keep the toggle icon in sync when the viewport crosses the breakpoint.
  window.addEventListener('resize', applySidebarState);
  applySidebarState();

  // Keyboard support: Escape closes drawer on mobile
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isMobileSidebar() && state.sidebarOpen) {
      closeSidebarDrawer();
    }
  });

  // Touch swipe support for mobile drawer
  let touchStartX = 0;
  let touchStartY = 0;
  const shell = document.getElementById('appShell');

  document.addEventListener('touchstart', (e) => {
    if (!isMobileSidebar()) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!isMobileSidebar() || !state.sidebarOpen) return;
    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    const deltaX = touchEndX - touchStartX;
    const deltaY = touchEndY - touchStartY;

    // Swipe right to open (from left edge), swipe left to close
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
      if (deltaX < -50 && touchStartX < 100) {
        // Swipe left from near left edge - close drawer
        closeSidebarDrawer();
      } else if (deltaX > 50 && touchStartX < 24) {
        shell.classList.add('sidebar-open');
        applySidebarState();
      }
    }
  }, { passive: true });

  // Pull-to-refresh for feed on mobile
  let pullStartY = 0;
  let pullCurrentY = 0;
  let isPulling = false;
  const pullThreshold = 80;
  const pullIndicator = document.createElement('div');
  pullIndicator.className = 'pull-to-refresh-indicator';
  pullIndicator.innerHTML = `
    <div class="pull-icon" aria-hidden="true">↓</div>
    <span class="pull-text">${translate('pullToRefresh')}</span>
  `;
  pullIndicator.style.cssText = `
    position: fixed;
    top: -60px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px;
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border-default);
    border-radius: var(--radius-full);
    box-shadow: var(--shadow-md);
    z-index: var(--z-toast);
    opacity: 0;
    transition: top 0.2s ease, opacity 0.2s ease;
    pointer-events: none;
    font-size: var(--text-sm);
    color: var(--color-text-tertiary);
  `;
  document.body.appendChild(pullIndicator);

  document.addEventListener('touchstart', (e) => {
    if (!isMobileSidebar()) return;
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    if (scrollTop === 0 && location.hash === '#/' || location.hash === '') {
      pullStartY = e.touches[0].clientY;
      isPulling = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!isPulling) return;
    pullCurrentY = e.touches[0].clientY;
    const deltaY = pullCurrentY - pullStartY;
    if (deltaY > 0) {
      e.preventDefault();
      const progress = Math.min(deltaY / pullThreshold, 1);
      pullIndicator.style.top = `${-60 + deltaY * 0.5}px`;
      pullIndicator.style.opacity = progress;
      pullIndicator.querySelector('.pull-icon').style.transform = `rotate(${progress * 180}deg)`;
      if (progress === 1) {
        pullIndicator.querySelector('.pull-text').textContent = translate('releaseToRefresh');
      }
    }
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!isPulling) return;
    isPulling = false;
    const deltaY = pullCurrentY - pullStartY;
    if (deltaY >= pullThreshold) {
      pullIndicator.querySelector('.pull-text').textContent = translate('refreshing');
      pullIndicator.querySelector('.pull-icon').style.animation = 'spin 1s linear infinite';
      // Trigger feed reload
      loadCoins().finally(() => {
        pullIndicator.style.top = '-60px';
        pullIndicator.style.opacity = '0';
        pullIndicator.querySelector('.pull-icon').style.animation = '';
        pullIndicator.querySelector('.pull-text').textContent = translate('pullToRefresh');
      });
    } else {
      pullIndicator.style.top = '-60px';
      pullIndicator.style.opacity = '0';
    }
  }, { passive: true });
}

// ---------- Keyboard Shortcuts & Command Palette ----------
const KEYBOARD_SHORTCUTS = [
  { keys: ['/'], action: 'focusSearch', description: 'focusSearchDesc' },
  { keys: ['k', 'meta'], action: 'openCommandPalette', description: 'commandPaletteDesc' },
  { keys: ['?', 'shift'], action: 'showShortcutsHelp', description: 'shortcutsHelpDesc' },
  { keys: ['t', 'meta'], action: 'toggleTheme', description: 'toggleThemeDesc' },
  { keys: ['m', 'meta'], action: 'toggleSidebar', description: 'toggleSidebarDesc' },
  { keys: ['Escape'], action: 'closeModals', description: 'closeModalsDesc' },
  { keys: ['1', 'meta'], action: 'navFeed', description: 'navFeedDesc' },
  { keys: ['2', 'meta'], action: 'navCreate', description: 'navCreateDesc' },
  { keys: ['3', 'meta'], action: 'navPortfolio', description: 'navPortfolioDesc' },
];

let commandPaletteOpen = false;
let shortcutsHelpOpen = false;

function initKeyboardShortcuts() {
  document.addEventListener('keydown', handleGlobalKeydown);
}

function handleGlobalKeydown(e) {
  // Don't trigger shortcuts when typing in inputs
  const active = document.activeElement;
  const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
  if (isInput && e.key !== 'Escape') return;

  // Escape closes modals, dropdowns, drawers
  if (e.key === 'Escape') {
    closeAllOverlays();
    return;
  }

  // Check shortcuts
  for (const shortcut of KEYBOARD_SHORTCUTS) {
    const [key, modifier] = shortcut.keys;
    const matchesKey = e.key.toLowerCase() === key.toLowerCase();
    const matchesModifier = !modifier || (modifier === 'meta' && (e.metaKey || e.ctrlKey)) || (modifier === 'shift' && e.shiftKey);

    if (matchesKey && matchesModifier) {
      e.preventDefault();
      executeShortcut(shortcut.action);
      return;
    }
  }
}

function executeShortcut(action) {
  switch (action) {
    case 'focusSearch':
      const searchInput = document.getElementById('searchInput');
      if (searchInput) searchInput.focus();
      break;
    case 'openCommandPalette':
      toggleCommandPalette();
      break;
    case 'showShortcutsHelp':
      toggleShortcutsHelp();
      break;
    case 'toggleTheme':
      toggleTheme();
      break;
    case 'toggleSidebar':
      toggleSidebar();
      break;
    case 'closeModals':
      closeAllOverlays();
      break;
    case 'navFeed':
      location.hash = '#/';
      break;
    case 'navCreate':
      location.hash = '#/create';
      break;
    case 'navPortfolio':
      location.hash = '#/portfolio';
      break;
  }
}

function closeAllOverlays() {
  // Close mobile sidebar
  if (state.sidebarOpen) closeSidebarDrawer();

  // Close modals
  const modalOverlay = document.getElementById('modalOverlay');
  if (modalOverlay && !modalOverlay.hidden) hideModal();

  // Close command palette
  if (commandPaletteOpen) toggleCommandPalette();

  // Close shortcuts help
  if (shortcutsHelpOpen) toggleShortcutsHelp();

  // Close dropdowns
  document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
}

function toggleCommandPalette() {
  if (commandPaletteOpen) {
    hideCommandPalette();
  } else {
    showCommandPalette();
  }
}

function showCommandPalette() {
  if (commandPaletteOpen) return;
  commandPaletteOpen = true;

  const commands = [
    { keys: ['⌘', 'K'], label: translate('cmdSearch'), action: 'focusSearch' },
    { keys: ['⌘', '1'], label: translate('cmdFeed'), action: 'navFeed' },
    { keys: ['⌘', '2'], label: translate('cmdCreate'), action: 'navCreate' },
    { keys: ['⌘', '3'], label: translate('cmdPortfolio'), action: 'navPortfolio' },
    { keys: ['⌘', 'T'], label: translate('cmdToggleTheme'), action: 'toggleTheme' },
    { keys: ['⌘', 'M'], label: translate('cmdToggleSidebar'), action: 'toggleSidebar' },
    { keys: ['⌘', '/'], label: translate('cmdShortcuts'), action: 'showShortcutsHelp' },
    { keys: ['Esc'], label: translate('cmdClose'), action: 'closeModals' },
  ];

  const isMac = navigator.platform.includes('Mac');
  const mod = isMac ? '⌘' : 'Ctrl';

  const html = `
    <div class="command-palette" role="dialog" aria-modal="true" aria-label="${translate('commandPaletteTitle')}">
      <div class="command-palette-input-wrapper">
        <span class="command-palette-icon" aria-hidden="true">⌘</span>
        <input type="text" id="commandPaletteInput" placeholder="${translate('commandPalettePlaceholder')}" autocomplete="off" spellcheck="false">
        <span class="command-palette-hint">${translate('commandPaletteHint')}</span>
      </div>
      <div class="command-palette-list" role="listbox">
        ${commands.map(cmd => `
          <button class="command-palette-item" data-action="${cmd.action}" role="option">
            <span class="command-palette-label">${esc(cmd.label)}</span>
            <span class="command-palette-keys">${cmd.keys.map(k => k === '⌘' ? mod : k).join(' + ')}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;

  showModal(html);

  const input = document.getElementById('commandPaletteInput');
  const items = document.querySelectorAll('.command-palette-item');
  let selectedIndex = 0;

  function updateSelection() {
    items.forEach((item, i) => {
      item.classList.toggle('selected', i === selectedIndex);
      if (i === selectedIndex) item.scrollIntoView({ block: 'nearest' });
    });
  }

  input.addEventListener('input', () => {
    const query = input.value.toLowerCase();
    items.forEach(item => {
      const label = item.querySelector('.command-palette-label').textContent.toLowerCase();
      const keys = item.querySelector('.command-palette-keys').textContent.toLowerCase();
      item.style.display = label.includes(query) || keys.includes(query) ? '' : 'none';
    });
    selectedIndex = 0;
    updateSelection();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      updateSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      updateSelection();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const visibleItems = Array.from(items).filter(i => i.style.display !== 'none');
      if (visibleItems[selectedIndex]) {
        executeShortcut(visibleItems[selectedIndex].dataset.action);
        hideCommandPalette();
      }
    } else if (e.key === 'Escape') {
      hideCommandPalette();
    }
  });

  items.forEach((item, i) => {
    item.addEventListener('click', () => {
      executeShortcut(item.dataset.action);
      hideCommandPalette();
    });
    item.addEventListener('mouseenter', () => {
      selectedIndex = i;
      updateSelection();
    });
  });

  input.focus();
  updateSelection();
}

function hideCommandPalette() {
  if (!commandPaletteOpen) return;
  commandPaletteOpen = false;
  hideModal();
}

function toggleShortcutsHelp() {
  if (shortcutsHelpOpen) {
    hideShortcutsHelp();
  } else {
    showShortcutsHelp();
  }
}

function showShortcutsHelp() {
  if (shortcutsHelpOpen) return;
  shortcutsHelpOpen = true;

  const isMac = navigator.platform.includes('Mac');
  const mod = isMac ? '⌘' : 'Ctrl';

  const shortcuts = [
    { keys: [mod, 'K'], desc: translate('shortcutCommandPalette') },
    { keys: ['/'], desc: translate('shortcutFocusSearch') },
    { keys: [mod, '1'], desc: translate('shortcutFeed') },
    { keys: [mod, '2'], desc: translate('shortcutCreate') },
    { keys: [mod, '3'], desc: translate('shortcutPortfolio') },
    { keys: [mod, 'T'], desc: translate('shortcutToggleTheme') },
    { keys: [mod, 'M'], desc: translate('shortcutToggleSidebar') },
    { keys: ['Esc'], desc: translate('shortcutCloseModals') },
    { keys: ['?'], desc: translate('shortcutShowHelp') },
  ];

  const html = `
    <div class="shortcuts-help">
      <h3 style="margin-top:0;margin-bottom:16px">${translate('shortcutsTitle')}</h3>
      <div class="shortcuts-list">
        ${shortcuts.map(s => `
          <div class="shortcut-item">
            <kbd class="shortcut-keys">${s.keys.map(k => `<span>${k}</span>`).join('<span>+</span>')}</kbd>
            <span class="shortcut-desc">${s.desc}</span>
          </div>
        `).join('')}
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:24px">
        <button class="btn btn-primary" id="shortcutsCloseBtn">${translate('closeBtn')}</button>
      </div>
    </div>
  `;

  showModal(html);
  document.getElementById('shortcutsCloseBtn').addEventListener('click', hideShortcutsHelp);

  // Focus trap
  const modal = document.querySelector('.modal');
  if (modal) trapFocus(modal);
}

function hideShortcutsHelp() {
  if (!shortcutsHelpOpen) return;
  shortcutsHelpOpen = false;
  hideModal();
}

function toggleTheme() {
  const current = getStoredTheme() || getSystemTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage unavailable */
  }
  applyTheme(next);
  toast(translate(next === 'dark' ? 'toastThemeDark' : 'toastThemeLight'));
}

// Focus trap utility for modals
let lastFocusedElement = null;
function trapFocus(element) {
  lastFocusedElement = document.activeElement;
  const focusableElements = element.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  const firstElement = focusableElements[0];
  const lastElement = focusableElements[focusableElements.length - 1];

  element.addEventListener('keydown', function trap(e) {
    if (e.key !== 'Tab') return;
    if (e.shiftKey) {
      if (document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      }
    } else {
      if (document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    }
  });

  firstElement?.focus();
}

function releaseFocus() {
  lastFocusedElement?.focus();
  lastFocusedElement = null;
}

// Override hideModal to release focus
const originalHideModal = hideModal;
function hideModal() {
  releaseFocus();
  originalHideModal();
}

// ---------- Onboarding ----------
const ONBOARDING_KEY = 'solpump-onboarding-complete';
const ONBOARDING_STEPS = [
  { key: 'welcome', titleKey: 'onboardingWelcomeTitle', bodyKey: 'onboardingWelcomeBody', illustration: '🚀' },
  { key: 'wallet', titleKey: 'onboardingWalletTitle', bodyKey: 'onboardingWalletBody', illustration: '👛' },
  { key: 'create', titleKey: 'onboardingCreateTitle', bodyKey: 'onboardingCreateBody', illustration: '✨' },
  { key: 'trade', titleKey: 'onboardingTradeTitle', bodyKey: 'onboardingTradeBody', illustration: '📈' },
  { key: 'devnet', titleKey: 'onboardingDevnetTitle', bodyKey: 'onboardingDevnetBody', illustration: '🧪' },
];

function isOnboardingComplete() {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === 'true';
  } catch {
    return false;
  }
}

function showOnboarding() {
  if (isOnboardingComplete()) return;
  state.onboardingShown = true;

  let currentStep = 0;

  function renderStep() {
    const step = ONBOARDING_STEPS[currentStep];
    const isLast = currentStep === ONBOARDING_STEPS.length - 1;

    showModal(`
      <div class="onboarding-modal" style="text-align:center;max-width:480px">
        <div class="onboarding-illustration" style="font-size:4rem;margin-bottom:24px">${step.illustration}</div>
        <h2 style="margin:0 0 12px">${translate(step.titleKey)}</h2>
        <p style="color:var(--color-text-tertiary);margin-bottom:32px">${translate(step.bodyKey)}</p>
        <div class="onboarding-progress" style="display:flex;gap:4px;justify-content:center;margin-bottom:24px">
          ${ONBOARDING_STEPS.map((_, i) => `
            <div class="onboarding-dot" style="width:8px;height:8px;border-radius:50%;background:${i <= currentStep ? 'var(--color-brand-primary)' : 'var(--color-border-default)'};transition:all 0.2s"></div>
          `).join('')}
        </div>
        <div class="row" style="justify-content:center">
          ${currentStep > 0 ? `<button class="btn btn-ghost" id="onboardingPrev">${translate('onboardingPrev')}</button>` : ''}
          <button class="btn btn-primary" id="onboardingNext">${translate(isLast ? 'onboardingFinish' : 'onboardingNext')}</button>
          ${currentStep === 0 ? `<button class="btn btn-ghost" id="onboardingSkip">${translate('onboardingSkip')}</button>` : ''}
        </div>
      </div>
    `);

    if (currentStep > 0) {
      document.getElementById('onboardingPrev').addEventListener('click', () => {
        currentStep--;
        renderStep();
      });
    }
    document.getElementById('onboardingNext').addEventListener('click', () => {
      if (isLast) {
        completeOnboarding();
      } else {
        currentStep++;
        renderStep();
      }
    });
    if (currentStep === 0) {
      document.getElementById('onboardingSkip').addEventListener('click', completeOnboarding);
    }
  }

  function completeOnboarding() {
    try {
      localStorage.setItem(ONBOARDING_KEY, 'true');
    } catch {
      /* storage unavailable */
    }
    state.onboardingShown = false;
    hideModal();
  }

  renderStep();
}

// Initialize onboarding check
function initOnboarding() {
  // Show onboarding after a short delay on first visit
  if (!isOnboardingComplete() && !state.onboardingShown) {
    setTimeout(showOnboarding, 1000);
  }
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

// Canonical dev-burn message (pool source only — holdings burns are
// authenticated by the on-chain burn transaction itself). Must match
// src/signverify.js exactly.
function devBurnMessage({ wallet, mint, amount, source }) {
  return [
    `solpump:dev-burn:${wallet}`,
    `mint:${mint}`,
    `amount:${amount}`,
    `source:${source}`,
  ].join('\n');
}

// Canonical buyback message — `amount` is the spend, or 'all' for a full
// buyback of whatever is unclaimed at execution time. Must match
// src/signverify.js exactly.
function buybackMessage({ wallet, mint, amount }) {
  return [`solpump:buyback:${wallet}`, `mint:${mint}`, `amount:${amount}`].join('\n');
}

// Canonical re-register message — must match src/signverify.js exactly.
function reRegisterMessage({ wallet, mint }) {
  return [`solpump:re-register:${wallet}`, `mint:${mint}`].join('\n');
}

// Canonical reward-claim message — `calloutId` is the callout's numeric id
// (as a string), `tier` is the claimed tier percent (10, 25, or 50).
// Must match src/signverify.js exactly.
function rewardClaimMessage({ wallet, mint, calloutId, tier }) {
  return [
    `solpump:reward-claim:${wallet}`,
    `mint:${mint}`,
    `callout:${calloutId}`,
    `tier:${tier}`,
  ].join('\n');
}

// Canonical livestream messages — must match src/signverify.js exactly.
// stream-start: the creator proves they may go live for the coin.
// stream-join: a viewer signs once per session to chat as their wallet.
function streamStartMessage({ wallet, mint }) {
  return [`solpump:stream-start:${wallet}`, `mint:${mint}`].join('\n');
}

function streamJoinMessage({ wallet, mint }) {
  return [`solpump:stream-join:${wallet}`, `mint:${mint}`].join('\n');
}

// Canonical contact-book messages — must match src/signverify.js exactly.
function contactAddMessage({ owner, name, wallet }) {
  return [`solpump:contact-add:${owner}`, `name:${name}`, `wallet:${wallet}`].join('\n');
}

function contactEditMessage({ owner, contactId, name, wallet }) {
  return [
    `solpump:contact-edit:${owner}`,
    `contact:${contactId}`,
    `name:${name}`,
    `wallet:${wallet}`,
  ].join('\n');
}

function contactDeleteMessage({ owner, contactId }) {
  return [`solpump:contact-delete:${owner}`, `contact:${contactId}`].join('\n');
}

// Canonical admin message — ONE format for all admin actions (grant,
// revoke, list). Must match src/signverify.js exactly.
function adminMessage({ admin, action, wallet, badge }) {
  const lines = [`solpump:admin:${admin}`, `action:${action}`];
  if (wallet) lines.push(`wallet:${wallet}`);
  if (badge) lines.push(`badge:${badge}`);
  return lines.join('\n');
}

// Fixed coin categories — must match COIN_CATEGORIES in src/routes.js.
const COIN_CATEGORIES = ['Meme', 'AI', 'Gaming', 'DeFi', 'Animals', 'Art', 'Sports', 'Music', 'Lainnya'];

async function sha256Hex(text) {
  // WebCrypto only recognizes the hyphenated name 'SHA-256' — the bare
  // 'sha256' throws "Unrecognized name" in browsers (and Node's WebCrypto).
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
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
// `showClaim`: on the coin detail page, the callout's author sees a claim
// button for each eligible, unclaimed reward tier.
function calloutHtml(c, { showCoin = false, showClaim = false } = {}) {
  const cls = c.pnlSol >= 0 ? 'profit' : 'loss';
  const asset = c.assetSymbol || 'SOL';
  const pnlUsd = Number.isFinite(c.pnlUsd)
    ? `${fmtSignedUsd(c.pnlUsd)} <span class="muted">(${fmtSignedSol(c.pnlSol, asset)})</span>`
    : fmtSignedSol(c.pnlSol, asset);
  const rewards = c.rewards || [];
  const isAuthor = state.wallet && state.wallet === c.wallet;
  const rewardChips = rewards.length
    ? `<div class="reward-chips">
        ${rewards
          .map((r) => {
            const stateClass = r.claimed ? 'claimed' : r.eligible ? 'eligible' : 'locked';
            const stateLabel = r.claimed
              ? translate('rewardTierClaimed')
              : r.eligible
                ? translate('rewardTierEligible')
                : translate('rewardTierLocked');
            return `<span class="reward-chip ${stateClass}" title="${translate('rewardTierTitle', { pct: r.pct, amount: fmtSol(r.amountSol) })}">+${r.pct}% · ${fmtSol(r.amountSol)} SOL · ${stateLabel}</span>`;
          })
          .join('')}
      </div>`
    : '';
  const claimButtons =
    showClaim && isAuthor
      ? rewards
          .filter((r) => r.eligible && !r.claimed)
          .map(
            (r) =>
              `<button class="btn btn-sm btn-primary" data-claim-reward="${c.id}" data-tier="${r.pct}">${translate('rewardClaimBtn', { pct: r.pct, amount: fmtSol(r.amountSol) })}</button>`
          )
          .join(' ')
      : '';
  return `
    <div class="callout">
      <div class="callout-head">
        ${avatarHtml(c.authorProfile, c.wallet, 28, true)}
        ${creatorLink(c.wallet, displayName(c.authorProfile, c.wallet))}${verifiedBadgeHtml(c.authorProfile)}${badgesHtml(c.authorProfile && c.authorProfile.badges)}
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
      ${rewardChips}
      ${claimButtons ? `<div class="row" style="justify-content:flex-start;margin-top:8px">${claimButtons}</div>` : ''}
    </div>`;
}

// Claim one callout reward tier (author only, signature-proven). The
// server re-verifies the live PnL threshold and pays real SOL from the
// pool wallet. Called from the coin detail page's claim buttons.
async function claimCalloutReward(mintAddress, calloutId, tier, btn) {
  if (btn) btn.disabled = true;
  try {
    const phantom = (await waitForPhantom(3000)) || getPhantom();
    if (!phantom) throw new Error(translate('errPhantomShort'));
    if (typeof phantom.signMessage !== 'function') {
      throw new Error(translate('errNoSignMessage'));
    }
    const message = rewardClaimMessage({
      wallet: state.wallet,
      mint: mintAddress,
      calloutId: String(calloutId),
      tier: String(tier),
    });
    toast(translate('toastSignRewardClaim'));
    const signature = await signWalletMessage(phantom, message);
    const res = await apiPost(`/api/coins/${mintAddress}/callouts/${calloutId}/claim-reward`, {
      wallet: state.wallet,
      tier,
      message,
      signature,
    });
    toast(
      translate('rewardClaimSuccess', {
        amount: fmtSol(res.claim.amountSol),
        tx: res.claim.txSignature ? shortAddr(res.claim.txSignature) : '',
      })
    );
    await refreshBalance();
    renderHeader();
    route();
  } catch (err) {
    toast(translate('rewardClaimFailed', { msg: friendlyError(err) }));
    if (btn) btn.disabled = false;
  }
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
  const liveRoute = hash === '#/live-streaming' || hash.startsWith('#/live-streaming/');
  const creatorRoute = hash === '#/live-streaming-creator';
  const liveGroup = document.querySelector('.nav-group[data-nav-group="live"]');
  if (liveGroup) {
    liveGroup.classList.toggle('open', liveRoute || creatorRoute);
    const liveToggle = liveGroup.querySelector('.nav-group-toggle');
    liveToggle?.setAttribute('aria-expanded', liveRoute || creatorRoute ? 'true' : 'false');
  }
  // Admin nav link (cached state renders immediately; the server check
  // refreshes it once per connected wallet).
  renderAdminNavLink();
  refreshAdminStatus();
}

// Admin status: the server decides (ADMIN_WALLETS); the client only
// shows/hides the sidebar link. Cached per wallet — one check per
// connect, re-checked when the wallet changes.
async function refreshAdminStatus() {
  if (!state.wallet) {
    state.isAdmin = false;
    state.adminCheckedWallet = null;
    renderAdminNavLink();
    return;
  }
  if (state.adminCheckedWallet === state.wallet) return;
  try {
    const data = await apiGet(`/api/admin/status?wallet=${encodeURIComponent(state.wallet)}`);
    state.isAdmin = !!data.isAdmin;
  } catch {
    state.isAdmin = false;
  }
  state.adminCheckedWallet = state.wallet;
  renderAdminNavLink();
}

// The Admin sidebar link exists only for admin wallets (added/removed
// dynamically — the static shell has no admin link).
function renderAdminNavLink() {
  const nav = document.querySelector('.sidebar .nav');
  if (!nav) return;
  const existing = nav.querySelector('[data-nav="admin"]');
  if (existing) existing.remove();
  if (!state.isAdmin) return;
  const a = document.createElement('a');
  a.href = '#/admin';
  a.dataset.nav = 'admin';
  a.innerHTML = `<span class="nav-ic">⚙</span><span class="nav-label">${translate('navAdmin')}</span>`;
  a.addEventListener('click', closeSidebarDrawer);
  const hash = location.hash || '#/';
  if (hash === '#/admin') a.classList.add('active');
  nav.appendChild(a);
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
      applyTheme(getEffectiveTheme()); // Update theme toggle tooltip
      renderHeader();
      route();
    });
  });
}

// ---------- Router ----------
function route() {
  const hash = location.hash || '#/';
  document.getElementById('view')?.classList.remove('coin-terminal-view');
  // Leaving a coin page ends any livestream the viewer is watching (or
  // broadcasting) — the stream panel unmounts with the view.
  stopStream();
  renderHeader();
  if (hash === '#/' || hash === '') return renderFeed();
  if (hash === '#/create') return renderCreate();
  if (hash === '#/re-register') return renderReRegister();
  if (hash === '#/portfolio') return renderPortfolio();
  if (hash === '#/admin') return renderAdmin();
  if (hash === '#/live-streaming-creator') return renderLiveStreamingCreator();
  const live = hash.match(/^#\/live-streaming(?:\/([1-9A-HJ-NP-Za-km-z]{32,44}))?$/);
  if (live) return renderLiveStreaming(live[1] || null);
  const m = hash.match(/^#\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (m) return renderCoin(m[1]);
  const c = hash.match(/^#\/creator\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (c) return renderCreator(c[1]);
  const r = hash.match(/^#\/receipt\/(\d+)$/);
  if (r) return renderReceipt(Number(r[1]));
  document.getElementById('view').innerHTML =
    `<div class="card"><p>${translate('notFoundTitle')}</p><a href="#/">${translate('backHome')}</a></div>`;
}

window.addEventListener('hashchange', route);

// ---------- Feed ----------
let feedSearch = '';
let feedSort = 'newest';
let feedCategory = null; // null = all categories
let feedHideAdult = false; // default: show 18+ coins, blurred + badged

// Translated category label ('Lainnya' -> 'Other' / '其他'); unknown
// values fall back to the raw stored string.
function categoryLabel(cat) {
  if (!cat) return '';
  const key = `category${cat}`;
  const t = translate(key);
  return t === key ? cat : t;
}

async function renderFeed() {
  const view = document.getElementById('view');
  // Launchpad header, trending coins, then filters and the coin list.
  const sortPills = [
    ['newest', translate('sortNewest')],
    ['marketcap', translate('sortMarketCap')],
    ['volume', translate('sortVolume')],
    ['price', translate('sortPrice')],
    ['change', translate('sortChange')],
  ];
  view.innerHTML = `
    <div class="launchpad-heading">
      <div>
        <p class="launchpad-eyebrow">SOLANA DEVNET</p>
        <h1>${translate('launchpadTitle')}</h1>
      </div>
      <a class="btn btn-primary launchpad-create" href="#/create">${translate('navCreate')}</a>
    </div>
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
      <button class="pill ${feedHideAdult ? 'active' : ''}" id="adultToggle" title="${translate('adultToggleTitle')}">${translate('adultToggleHide')}</button>
    </div>
    <div class="cat-pills" role="tablist" aria-label="${translate('categoryFilterLabel')}">
      <button class="pill ${!feedCategory ? 'active' : ''}" data-category="" role="tab">${translate('categoryAll')}</button>
      ${COIN_CATEGORIES.map(
        (cat) =>
          `<button class="pill ${feedCategory === cat ? 'active' : ''}" data-category="${esc(cat)}" role="tab">${esc(categoryLabel(cat))}</button>`
      ).join('')}
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
  const adultToggle = document.getElementById('adultToggle');
  if (adultToggle) {
    adultToggle.addEventListener('click', () => {
      feedHideAdult = !feedHideAdult;
      adultToggle.classList.toggle('active', feedHideAdult);
      loadCoins();
    });
  }
  view.querySelectorAll('[data-category]').forEach((b) => {
    b.addEventListener('click', () => {
      feedCategory = b.dataset.category || null;
      view.querySelectorAll('[data-category]').forEach((x) =>
        x.classList.toggle('active', (x.dataset.category || null) === feedCategory)
      );
      loadCoins();
    });
  });
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
                <div class="tc-name">${esc(c.ticker)}${i < 3 ? '<span class="hot">HOT</span>' : ''}${c.isLive ? `<span class="badge badge-live-stream">● ${translate('liveBadge')}</span>` : ''}${c.isAdult ? '<span class="badge badge-adult">18+</span>' : ''}</div>
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
    // Show skeleton loaders immediately
    list.innerHTML = `
      <div class="coin-grid">
        ${Array(6).fill(0).map(() => `
          <div class="card skeleton-card">
            <div class="skeleton skeleton-avatar"></div>
            <div style="margin-top:12px">
              <div class="skeleton skeleton-title" style="width:60%"></div>
              <div class="skeleton skeleton-text" style="width:80%;margin-top:8px"></div>
              <div class="skeleton skeleton-text" style="width:40%;margin-top:8px"></div>
            </div>
            <div class="skeleton skeleton-text" style="width:100%;height:8px;margin-top:16px;border-radius:4px"></div>
          </div>
        `).join('')}
      </div>`;
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
      if (feedCategory) params.set('category', feedCategory);
      if (state.feedFollowingOnly && state.wallet) {
        params.set('following', state.wallet);
      }
      const data = await apiGet(`/api/coins?${params}`);
      // The 18+ hide toggle filters client-side (the API has no
      // hide-adult parameter); hidden coins never render.
      const coins = feedHideAdult ? data.coins.filter((c) => !c.isAdult) : data.coins;
      if (!coins.length) {
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
            <p class="small muted">${translate('emptyFeedReRegisterNote')} <a href="#/re-register">${translate('emptyFeedReRegisterLink')}</a></p>
          </div>`;
        return;
      }
      list.innerHTML = `<div class="coin-grid">${coins.map(coinCard).join('')}</div>`;
      list.querySelectorAll('.coin-card').forEach((card) => {
        card.addEventListener('click', () => {
          location.hash = `#/coin/${card.dataset.mint}`;
        });
      });
      // Creator links inside cards must not trigger the card's navigation.
      list.querySelectorAll('.coin-card .addr-link').forEach((a) => {
        a.addEventListener('click', (e) => e.stopPropagation());
      });
      wireAdultReveals(list);
    } catch (err) {
      list.innerHTML = `<div class="alert alert-error">${esc(translate('errLoadCoins', { msg: err.message }))}</div>`;
    }
  }
}

// Wire the 18+ click-to-reveal buttons inside `container`: confirming the
// age modal re-renders the current view with the coin unblurred.
function wireAdultReveals(container) {
  container.querySelectorAll('[data-adult-reveal]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      showAgeConfirmModal(() => route());
    });
  });
}

function coinCard(c) {
  const chg = c.changePct >= 0 ? 'profit' : 'loss';
  const pairAsset = (c.pairAsset && c.pairAsset.symbol) || 'SOL';
  const pairLabel = c.pairLabel || `${c.ticker}/SOL`;
  // 18+ coins are blurred for viewers who have not confirmed their age;
  // the veil button opens the one-time age confirmation.
  const adultBlurred = c.isAdult && !isAgeConfirmed();
  return `
    <div class="card coin-card${adultBlurred ? ' adult-blurred' : ''}" data-mint="${esc(c.mintAddress)}">
      <div class="coin-head">
        ${logoHtml(c)}
        <div class="coin-id">
          <div class="coin-name">${esc(c.name)} <span class="coin-ticker">$${esc(c.ticker)}</span>${c.isAdult ? '<span class="badge badge-adult">18+</span>' : ''}${c.isLive ? `<span class="badge badge-live-stream">● ${translate('liveBadge')}${c.viewerCount ? ` ${c.viewerCount}` : ''}</span>` : ''}</div>
          <div class="coin-pair">${esc(pairLabel)} • ${fmtAgo(c.createdAt)}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="small muted">${translate('cardMarketCap')}</div>
          <div><b>${fmtMarketCap(c)}</b></div>
        </div>
        ${c.tradingEnabled ? '' : `<span class="badge badge-warn">${translate('badgeTradingOff')}</span>`}
      </div>
      <div class="coin-badges">${categoryBadgeHtml(c.category)}</div>
      ${c.description ? `<p class="coin-desc">${esc(c.description)}</p>` : ''}
      <div class="coin-price-row">
        <span class="coin-price"><b>${fmtPriceBoth(c.priceUsd, c.price)}</b> <span class="${chg}">${fmtPct(c.changePct)}</span></span>
        <span class="small muted">${translate('cardVolume')} <b style="color:var(--text)">${fmtSol(c.volumeSol)} ${esc(pairAsset)}</b></span>
      </div>
      <div class="progress" title="${translate('cardProgressTitle', { pct: c.progressPct.toFixed(1) })}">
        <div style="width:${c.progressPct.toFixed(1)}%"></div>
      </div>
      <div class="coin-foot">${translate('cardFoot', { pct: c.progressPct.toFixed(1), n: c.txCount, creator: creatorLink(c.creatorWallet, displayName(c.creatorProfile, c.creatorWallet)) + verifiedBadgeHtml(c.creatorProfile) + badgesHtml(c.creatorProfile && c.creatorProfile.badges) })}</div>
      ${adultBlurred ? `<button class="adult-veil" data-adult-reveal="${esc(c.mintAddress)}">🔞 ${translate('adultRevealBtn')}</button>` : ''}
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
    <p class="small muted">${translate('createReRegisterNote')} <a href="#/re-register">${translate('createReRegisterLink')}</a></p>
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
      <div class="field">
        <label for="coinCategory">${translate('categoryLabel')}</label>
        <select id="coinCategory">
          ${COIN_CATEGORIES.map((cat) => `<option value="${esc(cat)}" ${cat === 'Lainnya' ? 'selected' : ''}>${esc(categoryLabel(cat))}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="coinTax">${translate('taxLabel')}</label>
        <select id="coinTax">
          <option value="0">0%</option>
          <option value="50">0.5%</option>
          <option value="100" selected>1% ${translate('taxDefaultSuffix')}</option>
          <option value="200">2%</option>
          <option value="300">3%</option>
          <option value="500">5%</option>
          <option value="1000">10%</option>
        </select>
        <div class="hint">${translate('taxHint')}</div>
      </div>
      <div class="field">
        <label for="coinReferralWallet">${translate('referralLabel')}</label>
        <input id="coinReferralWallet" type="text" placeholder="Alamat dompet trader rujukan…" autocapitalize="off" autocomplete="off" spellcheck="false">
        <div class="hint">${translate('referralHint')}</div>
      </div>
      <div class="field">
        <label for="coinReferralFee">${translate('referralFeeLabel')}</label>
        <select id="coinReferralFee">
          <option value="0">0% ${translate('taxDefaultSuffix')}</option>
          <option value="10">0.1%</option>
          <option value="20">0.2%</option>
          <option value="50">0.5%</option>
          <option value="100">1%</option>
        </select>
        <div class="hint">${translate('referralFeeHint')}</div>
      </div>
      <label class="check-row">
        <input type="checkbox" id="coinAdult">
        <span>${translate('adultCheckboxLabel')}</span>
      </label>
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
          <div class="coin-badges"><span id="pvCategory"></span> <span id="pvAdult"></span></div>
          <div class="coin-price-row">
            <span class="coin-price"><b>~$0.000005</b></span>
            <span class="small muted">${translate('cardVolume')} <b style="color:var(--text)" id="pvVol">0 SOL</b></span>
          </div>
          <div class="progress"><div style="width:0%"></div></div>
          <div class="coin-foot">${translate('previewFoot')}</div>
        </div>
        <p class="preview-note">${translate('previewNote')}</p>
        <p class="preview-note" id="pvPairNote">${translate('pairPreviewNote', { pair: 'SOL' })}</p>
        <p class="preview-note" id="pvTaxNote"></p>
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
  document.getElementById('coinCategory').addEventListener('change', renderPreview);
  document.getElementById('coinTax').addEventListener('change', renderPreview);
  document.getElementById('coinAdult').addEventListener('change', renderPreview);

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
    // Category + 18+ badges and the creator tax shown in the preview so
    // the creator sees exactly what traders will see.
    const pvCategory = document.getElementById('pvCategory');
    if (pvCategory) {
      const cat = document.getElementById('coinCategory')?.value || 'Lainnya';
      pvCategory.innerHTML = categoryBadgeHtml(cat);
    }
    const pvAdult = document.getElementById('pvAdult');
    if (pvAdult) {
      pvAdult.innerHTML = document.getElementById('coinAdult')?.checked
        ? '<span class="badge badge-adult">18+</span>'
        : '';
    }
    const pvTax = document.getElementById('pvTaxNote');
    if (pvTax) {
      const bps = Number(document.getElementById('coinTax')?.value || 100);
      pvTax.textContent = translate('previewTaxNote', { pct: (bps / 100).toLocaleString('id-ID') });
    }
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
  // Initial preview render (must run AFTER `let logoData` above — the
  // preview reads it): the panel reflects the default form state
  // (category, tax note, 18+ badge) before the user types anything.
  renderPreview();
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
          category: pending.category || undefined,
          feeBps: pending.feeBps ?? undefined,
          isAdult: pending.isAdult || undefined,
          referralWallet: pending.referralWallet || undefined,
          referralFeeBps: pending.referralFeeBps || undefined,
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
    const category = document.getElementById('coinCategory').value || 'Lainnya';
    const feeBps = Number(document.getElementById('coinTax').value || 100);
    const referralWallet = document.getElementById('coinReferralWallet')?.value.trim() || null;
    const referralFeeBps = Number(document.getElementById('coinReferralFee')?.value || 0);
    const isAdult = document.getElementById('coinAdult').checked;
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
              category,
              feeBps,
              isAdult,
              referralWallet,
              referralFeeBps,
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
          category,
          feeBps,
          isAdult,
          referralWallet,
          referralFeeBps,
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
          category,
          feeBps,
          isAdult,
          referralWallet,
          referralFeeBps,
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

// ---------- Re-register an existing mint ----------
// Restores a coin that vanished from the feed after a database reset
// (every Render redeploy wipes the ephemeral SQLite DB) — the token and
// its pool funding are still on-chain. The creator re-enters the registry
// data (name, ticker, description, logo, pair, category, tax, 18+ flag)
// and proves creatorship by signing a canonical message; the server
// verifies the mint profile + pool balance on-chain and reconstructs the
// curve from the pool's on-chain state. Trades, burns, callouts and
// follows start empty — the form says so plainly.
async function renderReRegister() {
  const view = document.getElementById('view');
  view.innerHTML = `
    <h1>${translate('reregisterTitle')}</h1>
    <p class="muted">${translate('reregisterIntro')}</p>
    <div class="alert alert-info">${translate('reregisterFreshHistory')}</div>
    <div class="card">
      <div class="field">
        <label for="rrMint">${translate('reregisterMintLabel')}</label>
        <input id="rrMint" type="text" placeholder="${translate('reregisterMintPlaceholder')}" autocapitalize="off" autocomplete="off" spellcheck="false">
        <div class="hint">${translate('reregisterMintHint')}</div>
      </div>
      <div class="field">
        <label for="rrName">${translate('createNameLabel')}</label>
        <input id="rrName" maxlength="32" placeholder="${translate('createNamePlaceholder')}">
      </div>
      <div class="field">
        <label for="rrTicker">${translate('createTickerLabel')}</label>
        <input id="rrTicker" maxlength="10" placeholder="${translate('createTickerPlaceholder')}">
        <div class="hint">${translate('createTickerHint')}</div>
      </div>
      <div class="field">
        <label for="rrDesc">${translate('createDescLabel')}</label>
        <textarea id="rrDesc" rows="3" maxlength="500" placeholder="${translate('createDescPlaceholder')}"></textarea>
      </div>
      <div class="field">
        <label for="rrLogo">${translate('createLogoLabel')}</label>
        <input id="rrLogo" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
      </div>
      <div class="field">
        <label for="rrPair">${translate('pairPickerTitle')}</label>
        <select id="rrPair">
          <option value="">SOL</option>
        </select>
        <div class="hint">${translate('reregisterPairHint')}</div>
      </div>
      <div class="field">
        <label for="rrCategory">${translate('categoryLabel')}</label>
        <select id="rrCategory">
          ${COIN_CATEGORIES.map((cat) => `<option value="${esc(cat)}" ${cat === 'Lainnya' ? 'selected' : ''}>${esc(categoryLabel(cat))}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="rrTax">${translate('taxLabel')}</label>
        <select id="rrTax">
          <option value="0">0%</option>
          <option value="50">0.5%</option>
          <option value="100" selected>1% ${translate('taxDefaultSuffix')}</option>
          <option value="200">2%</option>
          <option value="300">3%</option>
          <option value="500">5%</option>
          <option value="1000">10%</option>
        </select>
        <div class="hint">${translate('taxHint')}</div>
      </div>
      <div class="field">
        <label for="rrReferralWallet">${translate('referralLabel')}</label>
        <input id="rrReferralWallet" type="text" placeholder="Alamat dompet trader rujukan…" autocapitalize="off" autocomplete="off" spellcheck="false">
        <div class="hint">${translate('referralHint')}</div>
      </div>
      <div class="field">
        <label for="rrReferralFee">${translate('referralFeeLabel')}</label>
        <select id="rrReferralFee">
          <option value="0">0% ${translate('taxDefaultSuffix')}</option>
          <option value="10">0.1%</option>
          <option value="20">0.2%</option>
          <option value="50">0.5%</option>
          <option value="100">1%</option>
        </select>
        <div class="hint">${translate('referralFeeHint')}</div>
      </div>
      <label class="check-row">
        <input type="checkbox" id="rrAdult">
        <span>${translate('adultCheckboxLabel')}</span>
      </label>
      <div id="rrWalletStatus"></div>
      <div id="rrResult" style="margin-top:8px"></div>
      <button class="btn btn-primary" id="rrSubmitBtn" style="margin-top:8px">${translate('reregisterSubmitBtn')}</button>
    </div>`;

  const tickerInput = document.getElementById('rrTicker');
  tickerInput.addEventListener('input', () => {
    tickerInput.value = tickerInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  // Pair options: SOL + every listed site coin.
  const pairSelect = document.getElementById('rrPair');
  apiGet('/api/pairs')
    .then((data) => {
      (data.pairs || [])
        .filter((p) => p.type === 'COIN')
        .forEach((p) => {
          const opt = document.createElement('option');
          opt.value = p.mint;
          opt.textContent = `$${p.symbol}${p.name ? ` — ${p.name}` : ''}`;
          pairSelect.appendChild(opt);
        });
    })
    .catch(() => {
      /* pairs unavailable — SOL stays the only option */
    });

  let logoData = null;
  document.getElementById('rrLogo').addEventListener('change', (e) => {
    const file = e.target.files[0];
    logoData = null;
    if (!file) return;
    if (file.size > 675000) {
      toast(translate('errFileTooBig'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const [meta, base64] = String(reader.result).split(',');
      logoData = { dataBase64: base64, mimeType: file.type };
    };
    reader.readAsDataURL(file);
  });

  const walletEl = document.getElementById('rrWalletStatus');
  if (!state.wallet) {
    walletEl.innerHTML = `<div class="alert alert-info">${translate('reregisterConnectFirst')} <button class="btn btn-sm btn-primary" id="rrConnectBtn">${translate('headerConnect')}</button></div>`;
    document.getElementById('rrConnectBtn').onclick = connectWallet;
  } else {
    walletEl.innerHTML = `<p class="small muted">${translate('reregisterWalletAs', { addr: esc(shortAddr(state.wallet)) })}</p>`;
  }

  document.getElementById('rrSubmitBtn').addEventListener('click', async () => {
    const btn = document.getElementById('rrSubmitBtn');
    const resEl = document.getElementById('rrResult');
    const mintAddress = document.getElementById('rrMint').value.trim();
    const name = document.getElementById('rrName').value.trim();
    const ticker = document.getElementById('rrTicker').value.trim();
    const description = document.getElementById('rrDesc').value.trim();
    const fail = (msg) => {
      resEl.innerHTML = `<div class="alert alert-error">${msg}</div>`;
      btn.disabled = false;
    };
    if (!mintAddress || !name || !ticker) {
      fail(translate('errReregisterFields'));
      return;
    }
    if (!state.wallet) {
      fail(translate('errConnectFirst'));
      return;
    }
    btn.disabled = true;
    resEl.innerHTML = `<p class="muted">${translate('reregisterVerifying')}</p>`;
    try {
      const phantom = (await waitForPhantom(3000)) || getPhantom();
      if (!phantom) throw new Error(translate('errPhantomShort'));
      if (typeof phantom.signMessage !== 'function') {
        throw new Error(translate('errNoSignMessage'));
      }
      if (!(await syncWalletAccount())) {
        throw new Error(translate('errReadAccountShort'));
      }
      const message = reRegisterMessage({ wallet: state.wallet, mint: mintAddress });
      toast(translate('toastSignReregister'));
      const signature = await signWalletMessage(phantom, message);
      const res = await apiPost('/api/coins/re-register', {
        mintAddress,
        name,
        ticker,
        description,
        creatorWallet: state.wallet,
        pairMint: pairSelect.value || undefined,
        category: document.getElementById('rrCategory').value,
        feeBps: Number(document.getElementById('rrTax').value || 100),
        isAdult: document.getElementById('rrAdult').checked,
        referralWallet: document.getElementById('rrReferralWallet')?.value.trim() || undefined,
        referralFeeBps: Number(document.getElementById('rrReferralFee')?.value || 0),
        image: logoData || undefined,
        message,
        signature,
      });
      resEl.innerHTML = `<div class="alert alert-success">${translate('reregisterSuccess', {
        ticker: esc(res.coin.ticker),
        price: fmtPriceBoth(res.coin.priceUsd, res.coin.price),
      })}</div>`;
      toast(translate('toastCoinRegistered', { ticker: res.coin.ticker }));
      setTimeout(() => {
        location.hash = `#/coin/${mintAddress}`;
      }, 800);
    } catch (err) {
      fail(esc(translate('reregisterFailed', { msg: friendlyError(err) })));
    }
  });
}

// ---------- Coin detail ----------
async function renderCoin(mintAddress) {
  const mySeq = ++coinRenderSeq;
  const view = document.getElementById('view');
  view.classList.add('coin-terminal-view');
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
  if (mySeq !== coinRenderSeq) return; // a newer coin render started
  const { coin, stats, chart, trades, feeClaims, creatorFees, creatorFeePct, referralFees, viewerFollowsCreator, callouts, burns, burnStats, walletPnl, walletTrades, solUsd, rewardPool, stream, pairCoin, solBuyAvailable, solBuyUnavailableReason, topHolders } = data;
  const chg = stats.changePct >= 0 ? 'profit' : 'loss';
  const isCreator = state.wallet && state.wallet === coin.creatorWallet;
  // Pair asset: SOL for SOL pairs, the pair coin's ticker for coin pairs.
  const pairAsset = (coin.pairAsset && coin.pairAsset.symbol) || 'SOL';
  const pairAvailable = !coin.pairAsset || coin.pairAsset.available !== false;
  const pairLabel = coin.pairLabel || `${coin.ticker}/SOL`;

  // 18+ gate: viewers who have not confirmed their age see a gate card
  // instead of the coin detail (same one-time confirmation as the feed).
  if (coin.isAdult && !isAgeConfirmed()) {
    view.innerHTML = `
      <div class="card empty">
        <h2>${esc(coin.name)} <span class="muted">$${esc(coin.ticker)}</span> <span class="badge badge-adult">18+</span></h2>
        <p>${translate('adultGateBody')}</p>
        <p><button class="btn btn-primary" id="adultGateBtn">${translate('adultRevealBtn')}</button></p>
        <p><a href="#/">${translate('backHome')}</a></p>
      </div>`;
    document.getElementById('adultGateBtn').addEventListener('click', () => {
      showAgeConfirmModal(() => renderCoin(mintAddress));
    });
    return;
  }

  view.innerHTML = `
    <div class="card terminal-asset-header">
      <div class="coin-head">
        ${logoHtml(coin, 'coin-logo detail-head-logo')}
        <div>
          <div class="coin-name" style="font-size:1.3rem">${esc(coin.name)} <span class="muted">$${esc(coin.ticker)}</span>${coin.isAdult ? '<span class="badge badge-adult">18+</span>' : ''}${coin.isLive ? `<span class="badge badge-live-stream">● ${translate('liveBadge')}${coin.viewerCount ? ` · ${coin.viewerCount}` : ''}</span>` : ''}</div>
          <div class="small muted">${esc(pairLabel)} • ${translate('coinCreatedBy', { ago: fmtAgo(coin.createdAt), creator: creatorLink(coin.creatorWallet) + verifiedBadgeHtml(coin.creatorProfile) + badgesHtml(coin.creatorProfile && coin.creatorProfile.badges) })}</div>
          <div class="coin-badges" style="margin-top:6px">${categoryBadgeHtml(coin.category)}<span class="badge badge-tax">${translate('taxBadge', { pct: creatorFeePct })}</span></div>
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

    <div class="terminal-market-strip">
      <div class="terminal-market-stat terminal-last-price">
        <span>${translate('chartTitle')}</span>
        <strong>${fmtPriceBoth(stats.priceUsd, stats.price)}</strong>
        <small class="${chg}">${fmtPct(stats.changePct)}</small>
      </div>
      <div class="terminal-market-stat"><span>${translate('statMarketCap')}</span><strong>${fmtMarketCap(coin)}</strong></div>
      <div class="terminal-market-stat"><span>${translate('statVolume')}</span><strong>${fmtSol(stats.volumeSol)} ${esc(pairAsset)}</strong></div>
      <div class="terminal-market-stat"><span>${translate('statUniqueTraders')}</span><strong>${stats.uniqueTraders}</strong></div>
      <div class="terminal-market-stat"><span>${translate('statTxCount')}</span><strong>${stats.txCount}</strong></div>
    </div>

    <div class="detail-layout terminal-layout">
    <div class="detail-main">
    <div class="card terminal-chart-card">
      <div class="terminal-section-head">
        <div>
          <h2>${translate('chartTitle')}</h2>
          <span class="small muted">${esc(pairLabel)} · ${translate('statHigh')} ${fmtPriceBoth(stats.highUsd, stats.high)} · ${translate('statLow')} ${fmtPriceBoth(stats.lowUsd, stats.low)}</span>
        </div>
        <span class="terminal-chart-live"><i></i> DEVNET</span>
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

    <div class="card terminal-activity-card">
      <div class="terminal-section-head">
        <h2>${translate('tradesTitle')}</h2>
        <span class="small muted">${stats.txCount} ${translate('statTxCount')}</span>
      </div>
      <div class="tabs">
        ${[['Semua', 'tabAll'], ['Beli', 'tabBuy'], ['Jual', 'tabSell'], ['Punyaku', 'tabMine']]
          .map(([key, labelKey]) => `<button class="btn btn-sm ${state.tradeTab === key ? 'active' : ''}" data-tab="${key}">${translate(labelKey)}</button>`)
          .join('')}
      </div>
      <div class="table-wrap" id="tradesTable"></div>
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

    <div class="card" id="holdersCard">
      <h2 style="margin-top:0">${translate('topHoldersTitle')}</h2>
      <p class="small muted">${translate('topHoldersNote')}</p>
      ${(topHolders || []).length
        ? `<div class="table-wrap">
            <table id="holdersTable">
              <thead><tr><th>#</th><th>${translate('topHoldersWallet')}</th><th>${translate('topHoldersBalance')}</th><th>${translate('topHoldersSupplyShare')}</th></tr></thead>
              <tbody>${topHolders
                .map(
                  (holder, index) => `<tr>
                    <td class="muted">${String(index + 1).padStart(2, '0')}</td>
                    <td>${creatorLink(holder.wallet)}</td>
                    <td>${fmtTokens(holder.tokenAmount)}</td>
                    <td>${fmtHolderSharePct(holder.supplySharePct)}</td>
                  </tr>`
                )
                .join('')}</tbody>
            </table>
          </div>`
        : `<p id="holdersEmpty" class="muted">${translate('topHoldersEmpty')}</p>`}
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

    ${isCreator ? `
    <div class="card" id="devBurnCard">
      <h2 style="margin-top:0">${translate('devBurnTitle')}</h2>
      <p class="small muted">${translate('devBurnIntro')}</p>
      <div id="devBurnForm" style="margin-top:12px"></div>
      <div id="devBurnCalc" style="margin-top:12px"></div>
      <div id="devBurnResult" style="margin-top:8px"></div>
    </div>` : ''}

    <div class="card" id="calloutsCard">
      <h2 style="margin-top:0">${translate('calloutsTitle', { n: (callouts || []).length })}</h2>
      <p class="small muted">${translate('calloutsIntro')}</p>
      <div id="calloutForm"></div>
      <div id="calloutList">
        ${(callouts || []).length === 0
          ? `<p class="muted">${translate('calloutsEmpty')}</p>`
          : (callouts || []).map((c) => calloutHtml(c, { showClaim: true })).join('')}
      </div>
    </div>

    <div class="card" id="rewardCard"></div>
    </div>
    <aside class="detail-side">
      <div class="card trade-box terminal-order-panel">
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
              <div id="buybackBox" style="margin-top:16px">
                <h3 style="margin:0 0 4px">${translate('buybackTitle')}</h3>
                <p class="small muted">${translate('buybackIntro')}</p>
                <div class="field">
                  <label>${translate('buybackAmountLabel', { asset: esc(pairAsset) })}</label>
                  <input id="buybackAmount" type="number" min="0" step="any" placeholder="0.01" ${creatorFees.unclaimedSol > 0 ? '' : 'disabled'}>
                  <div class="quick">
                    <button class="btn" id="buybackAllBtn" ${creatorFees.unclaimedSol > 0 ? '' : 'disabled'}>${translate('buybackAllBtn', { amount: fmtSol(creatorFees.unclaimedSol), asset: esc(pairAsset) })}</button>
                  </div>
                  <div class="estimate" id="buybackPreview"></div>
                </div>
                <button class="btn btn-buy" id="buybackBtn" ${creatorFees.unclaimedSol > 0 ? '' : 'disabled'}>${translate('buybackBtn')}</button>
                <div id="buybackResult" style="margin-top:8px"></div>
              </div>
            </div>`
          : `<p class="small muted" style="margin-top:12px">${translate('feeNonCreatorNote', { asset: esc(pairAsset), creator: creatorLink(coin.creatorWallet) })}</p>`}
        ${coin.referralWallet
          ? `<div style="margin-top:16px">
              <h3 style="margin:0 0 4px">${translate('referralTrader')}</div>
              <div class="stat-grid" style="grid-template-columns:1fr 1fr">
                <div class="stat"><div class="label">${translate('referralEarned')}</div><div class="value">${fmtSol(referralFees.totalEarnedSol)} ${esc(pairAsset)}</div></div>
                <div class="stat"><div class="label">${translate('referralClaimed')}</div><div class="value">${fmtSol(referralFees.totalClaimedSol)} ${esc(pairAsset)}</div></div>
                <div class="stat"><div class="label">${translate('referralUnclaimed')}</div><div class="value">${fmtSol(referralFees.unclaimedSol)} ${esc(pairAsset)}</div></div>
                <div class="stat"><div class="label">${translate('referralFeeLabel')}</div><div class="value">${(coin.referralFeeBps / 100).toFixed(2)}%</div></div>
              </div>
              ${state.wallet === coin.referralWallet
                ? `<div style="margin-top:8px">
                    <button class="btn btn-primary" id="claimReferralBtn" ${referralFees.unclaimedSol > 0 ? '' : 'disabled'}>${translate('referralClaimBtn')}</button>
                    <div id="referralClaimResult" style="margin-top:8px"></div>
                    <p class="small muted">${translate('toastSignReferralClaim')}</p>
                  </div>`
                : `<p class="small muted" style="margin-top:8px">${translate('errReferralNotAuthorized')}</p>`
              }
            </div>`
          : ''
        }
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

  // Referral trader claims accrued referral fees from the pool wallet.
  const claimReferralBtn = document.getElementById('claimReferralBtn');
  if (claimReferralBtn) {
    claimReferralBtn.addEventListener('click', async () => {
      const resEl = document.getElementById('referralClaimResult');
      claimReferralBtn.disabled = true;
      resEl.innerHTML = `<p class="muted">${translate('claimSending')}</p>`;
      try {
        const res = await apiPost(`/api/coins/${coin.mintAddress}/claim-referral-fees`, {
          wallet: state.wallet,
        });
        resEl.innerHTML = `<div class="alert alert-success">${translate('referralClaimSuccess', { amount: fmtSol(res.claim.amountSol), asset: esc(res.claim.assetSymbol || pairAsset) })}</div>`;
        await refreshBalance();
        renderHeader();
        setTimeout(() => renderCoin(mintAddress), 1200);
      } catch (err) {
        resEl.innerHTML = `<div class="alert alert-error">${esc(translate('referralClaimFailed', { msg: friendlyError(err) }))}</div>`;
        claimReferralBtn.disabled = false;
      }
    });
  }

  // Creator buyback: spend unclaimed creator fees buying the coin back
  // from the curve. Preview comes from the server (single source of
  // truth for the quote); the creator signs the canonical buyback message
  // in Phantom to authorize the server-signed token payout.
  const buybackBtn = document.getElementById('buybackBtn');
  if (buybackBtn) {
    const buybackInput = document.getElementById('buybackAmount');
    const buybackPreview = document.getElementById('buybackPreview');
    const buybackResult = document.getElementById('buybackResult');
    let buybackAll = false;
    let previewTimer = null;
    const updateBuybackPreview = () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        const amount = buybackAll ? 'all' : Number(buybackInput.value);
        if (!buybackAll && !(amount > 0)) {
          buybackPreview.textContent = '';
          return;
        }
        try {
          const prev = await apiGet(
            `/api/coins/${coin.mintAddress}/buyback-preview?amount=${encodeURIComponent(amount)}`
          );
          buybackPreview.textContent = translate('buybackPreview', {
            tokens: fmtTokens(prev.tokenAmount),
            ticker: coin.ticker,
            price: fmtPriceBoth(prev.newPriceUsd, prev.newPrice),
          });
        } catch {
          buybackPreview.textContent = '';
        }
      }, 300);
    };
    buybackInput.addEventListener('input', () => {
      buybackAll = false;
      updateBuybackPreview();
    });
    document.getElementById('buybackAllBtn').addEventListener('click', () => {
      buybackAll = true;
      buybackInput.value = '';
      buybackInput.placeholder = translate('buybackAllPlaceholder', {
        amount: fmtSol(creatorFees.unclaimedSol),
        asset: pairAsset,
      });
      updateBuybackPreview();
    });
    buybackBtn.addEventListener('click', async () => {
      const amount = buybackAll ? 'all' : Number(buybackInput.value);
      if (!buybackAll && !(amount > 0)) return toast(translate('errBuybackEnterAmount'));
      buybackBtn.disabled = true;
      buybackResult.innerHTML = `<p class="muted">${translate('buybackSigning')}</p>`;
      try {
        if (!solanaLibsReady()) throw new Error(translate('errSolanaLibsReload'));
        const phantom = (await waitForPhantom(3000)) || getPhantom();
        if (!phantom) throw new Error(translate('errPhantomShort'));
        if (typeof phantom.signMessage !== 'function') {
          throw new Error(translate('errNoSignMessage'));
        }
        if (!(await syncWalletAccount())) {
          throw new Error(translate('errReadAccountShort'));
        }
        const message = buybackMessage({
          wallet: state.wallet,
          mint: coin.mintAddress,
          amount: buybackAll ? 'all' : String(amount),
        });
        const signature = await signWalletMessage(phantom, message);
        buybackResult.innerHTML = `<p class="muted">${translate('buybackSending')}</p>`;
        const res = await apiPost(`/api/coins/${coin.mintAddress}/buyback`, {
          wallet: state.wallet,
          amount,
          message,
          signature,
        });
        buybackResult.innerHTML = `<div class="alert alert-success">${translate('buybackSuccess', {
          tokens: fmtTokens(res.buyback.tokenAmount),
          ticker: coin.ticker,
          tx: txLink(res.buyback.txSignature),
        })}</div>`;
        buybackAll = false;
        buybackInput.value = '';
        await refreshBalance();
        renderHeader();
        await refreshOnchainBalances();
        setTimeout(() => renderCoin(mintAddress), 1200);
      } catch (err) {
        buybackResult.innerHTML = `<div class="alert alert-error">${esc(translate('buybackFailed', { msg: friendlyError(err) }))}</div>`;
        buybackBtn.disabled = false;
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
  if (mySeq !== coinRenderSeq) return; // a newer coin render started
  renderTradeForm();
  renderPnlCard();
  renderBurnForm();
  renderDevBurnForm();
  renderBurnHistory();
  renderTransferForm();
  renderTradesTable();
  renderCalloutForm();
  renderStreamPanel();
  renderRewardCard();

  // Callout reward claims (author only — the buttons render only for the
  // author, on eligible unclaimed tiers).
  view.querySelectorAll('[data-claim-reward]').forEach((b) => {
    b.addEventListener('click', () => {
      claimCalloutReward(mintAddress, Number(b.dataset.claimReward), Number(b.dataset.tier), b);
    });
  });

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

  // Livestream panel: the creator's go-live controls, or the viewer
  // (video + live chat) when the coin is live. Re-renders are safe while
  // streaming — an active broadcaster/viewer session re-attaches its
  // stream to the new video element instead of re-joining.
  function renderStreamPanel() {
    const card = document.getElementById('streamCard');
    if (!card) return;
    const isActiveBroadcaster =
      streamState.mint === mintAddress && streamState.role === 'broadcaster';
    const isActiveGuest =
      streamState.mint === mintAddress && streamState.role === 'guest';
    const isActiveViewer = streamState.mint === mintAddress && streamState.role === 'viewer';
    const isActivePublisher = isActiveBroadcaster || isActiveGuest;
    const live = !!stream || isActivePublisher;
    if (!live && !isActiveViewer) {
      const mediaOk =
        typeof navigator !== 'undefined' &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function';
      card.innerHTML = `
        <h2 style="margin-top:0">🔴 ${translate('streamTitle')}</h2>
        <p class="muted">${translate('streamNotLive')}</p>
        <p class="small muted">${translate('streamMeshNote')}</p>
        ${isCreator
          ? `<div id="streamControls">
              <button class="btn btn-primary" id="streamStartBtn" ${mediaOk ? '' : 'disabled'}>${translate('streamGoLiveBtn')}</button>
              ${mediaOk ? '' : `<p class="small muted">${translate('streamNoMedia')}</p>`}
            </div>
            <p class="small muted">${translate('streamCreatorNote')}</p>`
          : ''}
        <div id="streamStatus" class="small muted"></div>`;
      const startBtn = document.getElementById('streamStartBtn');
      if (startBtn) startBtn.addEventListener('click', () => openStreamSetup(mintAddress));
      return;
    }
    card.innerHTML = `
      <h2 style="margin-top:0">🔴 ${translate('streamTitle')} <span class="badge badge-live-stream">● ${translate('liveBadge')}</span> <span class="small muted" id="streamViewerCount"></span></h2>
      <div class="stream-stage" id="streamStage"></div>
      <p class="small muted" id="streamStatus">${translate('streamConnecting')}</p>
      <div id="streamControls"></div>
      <div class="stream-chat">
        <h3>${translate('streamChatTitle')}</h3>
        <div class="stream-chat-log" id="streamChatLog"><p class="muted small stream-chat-empty">${translate('streamChatEmpty')}</p></div>
        <div id="streamChatAuth"></div>
      </div>
      <p class="small muted">${translate('streamMeshNote')}</p>`;
    if (isActivePublisher && streamState.localStream) {
      attachStreamVideo('local', streamState.localStream, true);
    }
    for (const [peerId, remoteStream] of streamState.remoteStreams) {
      attachStreamVideo(peerId, remoteStream, false);
    }
    if (isActivePublisher || isActiveViewer) {
      refreshStreamControls();
      refreshStreamChatAuth();
      updateStreamViewerCount(streamState.viewerCount);
    }
    if (isActiveBroadcaster) {
      setStreamStatus(streamState.audioEnabled ? 'streamLiveNow' : 'streamAudioOnly');
    } else if (isActiveGuest) {
      setStreamStatus(streamState.audioEnabled ? 'streamGuestLive' : 'streamAudioOnly');
    } else if (isActiveViewer) {
      setStreamStatus(streamState.ended ? 'streamEnded' : 'streamWatching');
    } else {
      // Live but not connected yet (fresh page load): join as a viewer.
      joinStreamAsViewer(mintAddress);
      updateStreamViewerCount((stream && stream.viewerCount) || 0);
    }
  }

  // Callout reward pool: creator-funded SOL, tiered claims for callout
  // authors (+10% / +25% / +50% live PnL -> 0.01 / 0.025 / 0.05 SOL).
  // The creator funds the pool with a real SOL transfer to the pool
  // wallet (verified on-chain); claims pay out real SOL from the pool.
  function renderRewardCard() {
    const card = document.getElementById('rewardCard');
    if (!card) return;
    const pool = rewardPool || { balanceSol: 0, totalFundedSol: 0, totalClaimedSol: 0, tiers: [] };
    const tiers = pool.tiers && pool.tiers.length ? pool.tiers : [];
    card.innerHTML = `
      <h2 style="margin-top:0">⭐ ${translate('rewardTitle')}</h2>
      <p class="small muted">${translate('rewardIntro')}</p>
      <div class="stat-grid" style="grid-template-columns:1fr 1fr 1fr">
        <div class="stat"><div class="label">${translate('rewardPoolBalance')}</div><div class="value">${fmtSol(pool.balanceSol)} SOL</div></div>
        <div class="stat"><div class="label">${translate('rewardTotalFunded')}</div><div class="value">${fmtSol(pool.totalFundedSol)} SOL</div></div>
        <div class="stat"><div class="label">${translate('rewardTotalClaimed')}</div><div class="value">${fmtSol(pool.totalClaimedSol)} SOL</div></div>
      </div>
      <div class="reward-tiers">
        ${tiers
          .map(
            (t) =>
              `<span class="reward-chip" title="${translate('rewardTierTitle', { pct: t.pct, amount: fmtSol(t.amountSol) })}">+${t.pct}% → ${fmtSol(t.amountSol)} SOL</span>`
          )
          .join('')}
      </div>
      ${isCreator
        ? `<div style="margin-top:12px">
            <h3 style="margin:0 0 4px">${translate('rewardFundTitle')}</h3>
            <p class="small muted">${translate('rewardFundIntro')}</p>
            <div class="field">
              <label>${translate('rewardFundAmountLabel')}</label>
              <input id="rewardFundAmount" type="number" min="0" step="any" placeholder="0.1">
            </div>
            <button class="btn btn-primary" id="rewardFundBtn">${translate('rewardFundBtn')}</button>
            <div id="rewardFundResult" style="margin-top:8px"></div>
          </div>`
        : ''}`;
    const fundBtn = document.getElementById('rewardFundBtn');
    if (!fundBtn) return;
    fundBtn.addEventListener('click', async () => {
      const amount = Number(document.getElementById('rewardFundAmount').value);
      const resEl = document.getElementById('rewardFundResult');
      if (!(amount > 0)) {
        toast(translate('errRewardFundAmount'));
        return;
      }
      fundBtn.disabled = true;
      resEl.innerHTML = `<p class="muted">${translate('rewardFunding')}</p>`;
      try {
        if (!solanaLibsReady()) throw new Error(translate('errSolanaLibsReload'));
        const phantom = (await waitForPhantom(3000)) || getPhantom();
        if (!phantom) throw new Error(translate('errPhantomShort'));
        if (!(await syncWalletAccount())) {
          throw new Error(translate('errReadAccountShort'));
        }
        const poolAddress = await loadPoolAddress();
        if (!poolAddress) throw new Error(translate('errPoolUnavailable'));
        const built = await buildSolTransferTransaction(state.wallet, poolAddress, amount);
        const sim = await simulateTransaction(built.transaction);
        if (!sim.ok) throw new Error(`Simulasi gagal: ${sim.error}`);
        const sig = await signAndSend(phantom, built.transaction);
        resEl.innerHTML = `<p class="muted">${translate('rewardVerifying')}</p>`;
        await apiPost(`/api/coins/${coin.mintAddress}/reward-fund`, {
          wallet: state.wallet,
          amountSol: amount,
          txSignature: sig,
        });
        resEl.innerHTML = `<div class="alert alert-success">${translate('rewardFundSuccess', {
          amount: fmtSol(amount),
          tx: txLink(sig),
        })}</div>`;
        await refreshBalance();
        renderHeader();
        setTimeout(() => renderCoin(mintAddress), 1200);
      } catch (err) {
        resEl.innerHTML = `<div class="alert alert-error">${esc(translate('rewardFundFailed', { msg: friendlyError(err) }))}</div>`;
        fundBtn.disabled = false;
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
      // Payment choice (custom-pair coins only): pay with SOL (default —
      // routed SOL -> pair tokens -> target tokens, one hop) or directly
      // with the pair asset. SOL pairs have no choice (SOL is the pair).
      const isCoinPair = !!coin.pairMint;
      const solBuyOk = isCoinPair ? solBuyAvailable !== false : true;
      let payWith = isCoinPair && solBuyOk ? 'sol' : 'pair';
      const payChoiceHtml = isCoinPair
        ? `<div class="field">
          <label>${translate('payWithLabel')}</label>
          <div class="pay-choice">
            <label class="pay-option"><input type="radio" name="payWith" value="sol" ${payWith === 'sol' ? 'checked' : ''} ${solBuyOk ? '' : 'disabled'}> ${translate('payWithSol')}</label>
            <label class="pay-option"><input type="radio" name="payWith" value="pair" ${payWith === 'pair' ? 'checked' : ''}> ${translate('payWithPair', { asset: esc(pairAsset) })}</label>
          </div>
          ${solBuyOk
            ? `<p class="small muted">${translate('payWithSolHint', { pair: esc(pairAsset), ticker: esc(coin.ticker) })}</p>`
            : `<p class="small muted">${translate(solBuyUnavailableReason === 'deep-chain' ? 'payWithSolDeepChain' : 'payWithSolUnavailable', { pair: esc(pairAsset) })}</p>`}
        </div>`
        : '';
      // Quick amounts + labels follow the selected payment asset.
      const renderAmountField = () => {
        const useSol = !isCoinPair || payWith === 'sol';
        const asset = useSol ? 'SOL' : pairAsset;
        const quickAmounts = useSol ? [0.1, 0.5, 1, 5] : [1000, 100000, 1000000, 10000000];
        return `
        <div class="field">
          <label>${translate('buyAmountLabel', { asset: esc(asset) })}</label>
          <input id="buySol" type="number" min="0" step="any" placeholder="${useSol ? '0.5' : '100000'}">
          <div class="quick">
            ${quickAmounts.map((v) => `<button class="btn" data-quick="${v}">${fmtTokens(v)} ${esc(asset)}</button>`).join('')}
          </div>
          <div class="estimate" id="buyEstimate"></div>
        </div>`;
      };
      form.innerHTML = `
        ${payChoiceHtml}
        <div id="buyAmountWrap">${renderAmountField()}</div>
        <button class="btn btn-buy" id="buyBtn">${translate('buyBtnLabel', { ticker: esc(coin.ticker) })}</button>
        <p class="small muted" style="margin-top:8px">${translate('buyNote', { asset: esc(payWith === 'sol' || !isCoinPair ? 'SOL' : pairAsset) })}</p>`;
      const wireAmountField = () => {
        const input = document.getElementById('buySol');
        const update = () => {
          const amount = Number(input.value);
          const est = document.getElementById('buyEstimate');
          if (!(amount > 0)) {
            est.innerHTML = '';
            return;
          }
          if (payWith === 'sol' && isCoinPair && pairCoin) {
            // Two-hop local estimate (mirrors bonding.quoteRoutedBuy):
            // SOL -> pair tokens through the pair coin's curve, then
            // pair tokens -> target tokens through this coin's curve.
            const pairFeePct = (pairCoin.feeBps ?? 100) / 100;
            const pairOut = (pairCoin.tokenReserve * amount) / (pairCoin.solReserve + amount);
            const tokens = (coin.tokenReserve * pairOut) / (coin.solReserve + pairOut);
            const feePair = (amount * pairFeePct) / 100;
            const feeTarget = (pairOut * creatorFeePct) / 100;
            const execSol = amount / tokens;
            const execUsd = Number.isFinite(solUsd) && solUsd > 0 ? execSol * solUsd : null;
            const usdPaid =
              Number.isFinite(solUsd) && solUsd > 0 ? ` (≈${fmtUsd(amount * solUsd)})` : '';
            est.innerHTML = translate('routeBuyEstimate', {
              sol: fmtSol(amount),
              usd: usdPaid || '',
              pairAmount: fmtTokens(pairOut),
              pairSymbol: pairAsset,
              tokens: fmtTokens(tokens),
              ticker: coin.ticker,
              price: fmtPriceBoth(execUsd, execSol),
              feePair: fmtSol(feePair),
              feeTarget: fmtTokens(feeTarget),
            });
          } else {
            const tokens = (coin.tokenReserve * amount) / (coin.solReserve + amount);
            const fee = (amount * creatorFeePct) / 100;
            const execSol = amount / tokens;
            const execUsd = assetUsd !== null ? execSol * assetUsd : null;
            est.textContent = translate('buyEstimate', {
              tokens: fmtTokens(tokens),
              ticker: coin.ticker,
              price: fmtPriceBoth(execUsd, execSol),
              pct: creatorFeePct,
              fee: fmtSol(fee),
              asset: pairAsset,
            });
          }
        };
        input.addEventListener('input', update);
        form.querySelectorAll('[data-quick]').forEach((b) => {
          b.addEventListener('click', () => {
            input.value = b.dataset.quick;
            update();
          });
        });
      };
      wireAmountField();
      form.querySelectorAll('input[name="payWith"]').forEach((r) => {
        r.addEventListener('change', () => {
          payWith = r.value;
          document.getElementById('buyAmountWrap').innerHTML = renderAmountField();
          wireAmountField();
        });
      });
      document.getElementById('buyBtn').addEventListener('click', async () => {
        const amount = Number(document.getElementById('buySol').value);
        const asset = payWith === 'sol' || !isCoinPair ? 'SOL' : pairAsset;
        if (!(amount > 0)) return toast(translate('errEnterSol', { asset }));
        await submitTrade('buy', { solAmount: amount, payWith: isCoinPair ? payWith : undefined });
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
        ${isCreator
          ? `<button class="btn btn-ghost sell-all-creator-btn" id="sellAllCreatorBtn" ${liveHoldings > 0 ? '' : 'disabled'}>${translate('sellAllCreatorBtn')}</button>`
          : ''}
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
      const sellAllBtn = document.getElementById('sellAllCreatorBtn');
      if (sellAllBtn) {
        sellAllBtn.addEventListener('click', async () => {
          const tokens = Number(state.onchainBalances[coin.mintAddress] || 0);
          if (!(tokens > 0)) return toast(translate('errEnterTokens'));
          if (!window.confirm(translate('sellAllCreatorConfirm', { amount: fmtTokens(tokens), ticker: coin.ticker }))) return;
          await submitTrade('sell', { tokenAmount: tokens }, sellAllBtn);
        });
      }
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
  async function submitTrade(side, amounts, actionButton = null) {
    const resEl = document.getElementById('tradeResult');
    const buttons = [
      ...new Set([
        document.getElementById(side === 'buy' ? 'buyBtn' : 'sellBtn'),
        actionButton,
        side === 'sell' ? document.getElementById('sellAllCreatorBtn') : null,
      ].filter(Boolean)),
    ];
    const setBusy = (msg) => {
      buttons.forEach((btn) => { btn.disabled = true; });
      resEl.innerHTML = `<p class="muted">${esc(msg)}</p>`;
    };
    const fail = (msg) => {
      buttons.forEach((btn) => { btn.disabled = false; });
      resEl.innerHTML = `<div class="alert alert-error">${msg}</div>`;
    };
    buttons.forEach((btn) => { btn.disabled = true; });
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
      // Routed SOL buys (payWith 'sol' on a coin-paired coin) pay SOL,
      // so their leg is the plain SOL transfer like a SOL-pair buy.
      setBusy(translate('tradeBuilding'));
      let built;
      if (side === 'buy' && coin.pairMint && amounts.payWith !== 'sol') {
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
        ...(side === 'buy' && amounts.payWith ? { payWith: amounts.payWith } : {}),
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
      // Routed buy: show the route the SOL took (SOL -> PAIR -> TICKER).
      const routeNote = res.route
        ? `<br>${translate('tradeSuccessRoute', {
            sol: fmtSol(res.route.solAmount),
            pairAmount: fmtTokens(res.route.via.amount),
            pairSymbol: esc(res.route.via.symbol),
            feePair: fmtSol(res.route.via.feeSol),
          })}`
        : '';
      resEl.innerHTML = `<div class="alert alert-success">${successMsg}${receivedNote}${routeNote}<br>
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

  // Dev burn panel (creator-only — the card is only rendered for the
  // creator): full calculation before confirming. Two sources: the
  // creator's own holdings (a real SPL BurnChecked signed in Phantom,
  // verified on-chain exactly like a holder burn) or the pool reserve
  // (server-signed; the creator signs the canonical dev-burn message to
  // authorize it). Both reduce the curve's token reserve, so the price
  // rises. The preview comes from the server (single source of truth).
  function renderDevBurnForm() {
    const form = document.getElementById('devBurnForm');
    if (!form) return;
    const calcEl = document.getElementById('devBurnCalc');
    const resultEl = document.getElementById('devBurnResult');
    const maxHoldings = state.onchainBalances[coin.mintAddress] || 0;
    form.innerHTML = `
      <div class="field">
        <label>${translate('devBurnSourceLabel')}</label>
        <select id="devBurnSource">
          <option value="holdings">${translate('devBurnSourceHoldings')}</option>
          <option value="pool">${translate('devBurnSourcePool')}</option>
        </select>
      </div>
      <div class="field">
        <label>${translate('devBurnAmountLabel', { ticker: esc(coin.ticker) })}</label>
        <div style="display:flex;gap:8px">
          <input id="devBurnAmount" type="number" min="0" step="any" placeholder="1000000" style="flex:1">
          <button class="btn" id="devBurnMax">${translate('maxBtn')}</button>
        </div>
        <p class="small muted" id="devBurnMaxHint"></p>
      </div>
      <button class="btn btn-sell" id="devBurnBtn">${translate('devBurnBtn')}</button>`;
    const sourceEl = document.getElementById('devBurnSource');
    const amountEl = document.getElementById('devBurnAmount');
    let calcTimer = null;
    let poolBalance = null;
    const updateMaxHint = async () => {
      if (sourceEl.value === 'holdings') {
        document.getElementById('devBurnMaxHint').textContent = translate('devBurnMaxHoldings', {
          amount: fmtTokens(maxHoldings),
          ticker: coin.ticker,
        });
        return;
      }
      if (poolBalance === null) {
        document.getElementById('devBurnMaxHint').textContent = translate('loadingGeneric');
        try {
          const poolAddress = await loadPoolAddress();
          poolBalance = await getTokenBalance(coin.mintAddress, poolAddress);
        } catch {
          poolBalance = 0;
        }
      }
      document.getElementById('devBurnMaxHint').textContent = translate('devBurnMaxPool', {
        amount: fmtTokens(poolBalance),
        ticker: coin.ticker,
      });
    };
    const updateCalc = () => {
      clearTimeout(calcTimer);
      calcTimer = setTimeout(async () => {
        const amount = Number(amountEl.value);
        if (!(amount > 0)) {
          calcEl.innerHTML = '';
          return;
        }
        try {
          const prev = await apiGet(
            `/api/coins/${coin.mintAddress}/burn-preview?amount=${encodeURIComponent(amount)}`
          );
          calcEl.innerHTML = `
            <div class="table-wrap"><table>
              <thead><tr><th></th><th>${translate('devBurnCurrent')}</th><th>${translate('devBurnProjected')}</th></tr></thead>
              <tbody>
                <tr><td>${translate('thPrice')}</td><td>${fmtPriceBoth(prev.current.priceUsd, prev.current.price)}</td><td><strong>${fmtPriceBoth(prev.projected.priceUsd, prev.projected.price)}</strong></td></tr>
                <tr><td>${translate('devBurnSupply')}</td><td>${fmtTokens(prev.current.circulatingSupply)}</td><td><strong>${fmtTokens(prev.projected.circulatingSupply)}</strong></td></tr>
                <tr><td>${translate('cardMarketCap')}</td><td>${fmtUsd(prev.current.marketCapUsd)}</td><td><strong>${fmtUsd(prev.projected.marketCapUsd)}</strong></td></tr>
                <tr><td>${translate('devBurnPctBurned')}</td><td colspan="2"><strong>${prev.pctSupplyBurned.toFixed(2)}%</strong></td></tr>
                <tr><td>${translate('devBurnPriceGain')}</td><td colspan="2"><strong class="positive">${fmtPct(prev.priceIncreasePct)}</strong></td></tr>
              </tbody>
            </table></div>`;
        } catch {
          calcEl.innerHTML = '';
        }
      }, 300);
    };
    sourceEl.addEventListener('change', () => {
      updateMaxHint();
      updateCalc();
    });
    amountEl.addEventListener('input', updateCalc);
    document.getElementById('devBurnMax').addEventListener('click', async () => {
      if (sourceEl.value === 'holdings') {
        amountEl.value = maxHoldings;
      } else {
        if (poolBalance === null) await updateMaxHint();
        amountEl.value = poolBalance || 0;
      }
      updateCalc();
    });
    updateMaxHint();
    document.getElementById('devBurnBtn').addEventListener('click', async () => {
      const amount = Number(amountEl.value);
      const source = sourceEl.value;
      if (!(amount > 0)) return toast(translate('errDevBurnEnterAmount'));
      const btn = document.getElementById('devBurnBtn');
      btn.disabled = true;
      const fail = (msg) => {
        btn.disabled = false;
        resultEl.innerHTML = `<div class="alert alert-error">${esc(msg)}</div>`;
      };
      try {
        if (!solanaLibsReady()) throw new Error(translate('errSolanaLibsReload'));
        const phantom = (await waitForPhantom(3000)) || getPhantom();
        if (!phantom) throw new Error(translate('errPhantomShort'));
        if (!(await syncWalletAccount())) {
          throw new Error(translate('errReadAccountShort'));
        }
        const body = { wallet: state.wallet, amount, source };
        if (source === 'holdings') {
          // Fresh on-chain balance first: the burn fails on-chain when
          // the creator holds less, so check before opening Phantom.
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
          resultEl.innerHTML = `<p class="muted">${translate('burnBuilding')}</p>`;
          const built = await buildBurnTransaction(state.wallet, coin.mintAddress, amount);
          const sim = await simulateTransaction(built.transaction);
          if (!sim.ok) throw new Error(`Simulasi gagal: ${sim.error}`);
          resultEl.innerHTML = `<p class="muted">${translate('burnSigning')}</p>`;
          const sig = await signAndSend(phantom, built.transaction);
          resultEl.innerHTML = `<p class="muted">${translate('burnVerifying')}</p>`;
          body.txSignature = sig;
        } else {
          // Pool reserve: the pool burns its own tokens, server-signed —
          // the creator's signature over the canonical message is the
          // only proof of authorization.
          if (typeof phantom.signMessage !== 'function') {
            throw new Error(translate('errNoSignMessage'));
          }
          resultEl.innerHTML = `<p class="muted">${translate('devBurnSigning')}</p>`;
          const message = devBurnMessage({
            wallet: state.wallet,
            mint: coin.mintAddress,
            amount: String(amount),
            source: 'pool',
          });
          body.message = message;
          body.signature = await signWalletMessage(phantom, message);
          resultEl.innerHTML = `<p class="muted">${translate('devBurnSending')}</p>`;
        }
        const res = await apiPost(`/api/coins/${coin.mintAddress}/dev-burn`, body);
        resultEl.innerHTML = `<div class="alert alert-success">${translate('devBurnSuccess', {
          amount: fmtTokens(amount),
          ticker: coin.ticker,
          price: fmtPriceBoth(res.burn.priceAfterUsd, res.burn.priceAfter),
          tx: txLink(res.burn.txSignature),
        })}</div>`;
        amountEl.value = '';
        calcEl.innerHTML = '';
        await refreshBalance();
        renderHeader();
        await refreshOnchainBalances();
        setTimeout(() => renderCoin(mintAddress), 1200);
      } catch (err) {
        fail(translate('devBurnFailed', { msg: friendlyError(err) }));
      }
    });
  }

  function renderBurnHistory() {
    const wrap = document.getElementById('burnHistory');
    const list = burns || [];
    if (!list.length) {
      wrap.innerHTML = `<p class="muted">${translate('burnEmpty')}</p>`;
      return;
    }
    const sourceLabel = (s) =>
      s === 'dev' ? translate('burnSourceDev') : s === 'pool' ? translate('burnSourcePool') : translate('burnSourceHolder');
    wrap.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>${translate('thTime')}</th><th>${translate('burnHistoryWallet')}</th><th>${translate('burnHistorySource')}</th><th>${translate('burnHistoryAmount')}</th><th>${translate('burnHistoryPrice')}</th><th>${translate('burnHistoryTx')}</th></tr></thead>
        <tbody>
          ${list
            .map(
              (b) => `<tr>
                <td>${fmtTime(b.createdAt)}</td>
                <td>${creatorLink(b.wallet)}${b.wallet === state.wallet ? translate('youSuffix') : ''}</td>
                <td>${esc(sourceLabel(b.source))}</td>
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
        <select id="transferContact" hidden>
          <option value="">${translate('contactPickerPlaceholder')}</option>
        </select>
        <input id="transferTo" type="text" placeholder="${translate('transferRecipientPlaceholder')}" autocapitalize="off" autocomplete="off" spellcheck="false" style="margin-top:6px">
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
    loadContactPicker(document.getElementById('transferContact'), document.getElementById('transferTo'));
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

// ---------- Livestream client (WebRTC mesh) ----------
// The server only relays signaling + chat; media flows directly between
// the broadcaster and each viewer (mesh). See src/stream.js for the
// protocol and the honest limits: the broadcaster uploads one stream per
// viewer (~10 is the practical max, 25 is the server cap), public STUN
// only (no TURN — strict symmetric NATs may fail), no recording, chat is
// in-memory only.
const streamState = {
  mint: null,
  creatorMint: null,
  role: null, // 'broadcaster' | 'guest' | 'viewer' | null
  joined: false,
  ws: null,
  viewerId: null,
  localStream: null, // broadcaster's camera/mic
  previewStream: null, // camera/mic while the go-live setup popup is open
  mirrorPreview: true,
  setupKeydown: null,
  remoteStreams: new Map(), // publisher ID -> received MediaStream
  peers: new Map(), // publisher: peer ID -> RTCPeerConnection
  viewerPeers: new Map(), // viewer/guest: publisher ID -> RTCPeerConnection
  pendingGuestStream: null,
  guestRequests: new Map(),
  pendingGuestRequest: false,
  authed: false,
  audioEnabled: true,
  viewerCount: 0,
  ended: false,
};

const STREAM_STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function streamWsUrl(mint) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/stream?mint=${encodeURIComponent(mint)}`;
}

// Full cleanup: close the socket + all peer connections + the camera/mic.
// Safe to call when nothing is active; route() calls it on every
// navigation so a stream never survives leaving the coin page.
function stopStream() {
  closeStreamSetup();
  if (streamState.ws) {
    try {
      if (streamState.ws.readyState === WebSocket.OPEN) {
        streamState.ws.send(JSON.stringify({ type: 'leave' }));
      }
      streamState.ws.close();
    } catch {
      /* already gone */
    }
  }
  for (const pc of streamState.peers.values()) {
    try {
      pc.close();
    } catch {
      /* already closed */
    }
  }
  for (const pc of streamState.viewerPeers.values()) {
    try {
      pc.close();
    } catch {
      /* already closed */
    }
  }
  if (streamState.localStream) {
    streamState.localStream.getTracks().forEach((t) => t.stop());
  }
  if (streamState.previewStream) {
    streamState.previewStream.getTracks().forEach((t) => t.stop());
  }
  if (streamState.pendingGuestStream) {
    streamState.pendingGuestStream.getTracks().forEach((t) => t.stop());
  }
  streamState.mint = null;
  streamState.role = null;
  streamState.joined = false;
  streamState.ws = null;
  streamState.viewerId = null;
  streamState.localStream = null;
  streamState.remoteStreams = new Map();
  streamState.peers = new Map();
  streamState.viewerPeers = new Map();
  streamState.pendingGuestStream = null;
  streamState.guestRequests = new Map();
  streamState.pendingGuestRequest = false;
  streamState.authed = false;
  streamState.audioEnabled = true;
  streamState.viewerCount = 0;
  streamState.ended = false;
}

function closeStreamSetup(stopPreview = true) {
  const modal = document.getElementById('streamSetupModal');
  if (modal) modal.remove();
  if (streamState.setupKeydown) {
    document.removeEventListener('keydown', streamState.setupKeydown);
    streamState.setupKeydown = null;
  }
  if (stopPreview && streamState.previewStream) {
    streamState.previewStream.getTracks().forEach((t) => t.stop());
    streamState.previewStream = null;
  }
}

function streamSend(obj) {
  if (streamState.ws && streamState.ws.readyState === WebSocket.OPEN) {
    streamState.ws.send(JSON.stringify(obj));
  }
}

function streamStatusEl() {
  return document.getElementById('streamStatus');
}

function setStreamStatus(key, vars) {
  const el = streamStatusEl();
  if (el) el.textContent = translate(key, vars || {});
}

function updateStreamViewerCount(n) {
  streamState.viewerCount = n;
  const el = document.getElementById('streamViewerCount');
  if (el) el.textContent = translate('streamViewers', { n });
}

// Append one chat message to the stream chat log (verified checkmark +
// community badges, same as callouts).
function appendStreamChat(msg) {
  const log = document.getElementById('streamChatLog');
  if (!log) return;
  const empty = log.querySelector('.stream-chat-empty');
  if (empty) empty.remove();
  const profile = {
    username: msg.username || null,
    avatarUrl: msg.avatarUrl || null,
    border: msg.border || 'none',
    verified: !!msg.verified,
    badges: msg.badges || [],
  };
  const div = document.createElement('div');
  div.className = 'stream-chat-msg';
  div.innerHTML = `${avatarHtml(profile, msg.wallet, 22, true)} ${creatorLink(msg.wallet, displayName(profile, msg.wallet))}${verifiedBadgeHtml(profile)}${badgesHtml(profile.badges)} <span class="stream-chat-text">${esc(msg.text)}</span> <span class="muted small">${fmtTime(msg.time)}</span>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// Shared WebSocket message handling for both roles.
function handleStreamMessage(msg) {
  switch (msg.type) {
    case 'joined': {
      streamState.joined = true;
      streamState.viewerId = msg.viewerId || null;
      streamState.authed = !!msg.chatAuthed;
      updateStreamViewerCount(msg.viewerCount || 0);
      if (streamState.role === 'broadcaster') {
        if (streamState.previewStream) {
          streamState.localStream = streamState.previewStream;
          streamState.previewStream = null;
          closeStreamSetup(false);
        }
        setStreamStatus(streamState.audioEnabled ? 'streamLiveNow' : 'streamAudioOnly');
        // The panel was rendered as "not live" before the join confirmed
        // (no video/chat elements) — re-render the coin page so it shows
        // the live broadcaster view; renderStreamPanel re-attaches the
        // local stream to the new video element.
        if (!document.getElementById('streamChatLog') && streamState.mint) {
          renderCoin(streamState.mint);
        } else {
          if (streamState.localStream) {
            attachStreamVideo('local', streamState.localStream, true);
          }
          refreshStreamControls();
          refreshStreamChatAuth();
        }
        // Waiting viewers who joined before the stream started.
        (msg.viewers || []).forEach((viewerId) => createViewerPeer(viewerId));
      } else if (streamState.role === 'guest') {
        setStreamStatus(streamState.audioEnabled ? 'streamGuestLive' : 'streamAudioOnly');
      } else if (msg.live) {
        setStreamStatus('streamConnecting');
      } else {
        setStreamStatus('streamWaiting');
      }
      refreshStreamChatAuth();
      break;
    }
    case 'viewer-joined':
      updateStreamViewerCount(msg.viewerCount || 0);
      if (streamState.role === 'broadcaster' || streamState.role === 'guest') {
        createViewerPeer(msg.viewerId);
      }
      break;
    case 'viewer-left':
      updateStreamViewerCount(msg.viewerCount || 0);
      if (streamState.role === 'broadcaster' || streamState.role === 'guest') {
        closeViewerPeer(msg.viewerId);
      }
      break;
    case 'viewer-count':
      updateStreamViewerCount(msg.viewerCount || 0);
      break;
    case 'stream-started':
      updateStreamViewerCount(msg.viewerCount || 0);
      setStreamStatus('streamConnecting');
      break;
    case 'guest-request':
      if (streamState.role === 'broadcaster') {
        streamState.guestRequests.set(msg.viewerId, msg);
        refreshStreamControls();
      }
      break;
    case 'guest-requested':
      streamState.pendingGuestRequest = true;
      refreshStreamControls();
      setStreamStatus('streamGuestRequestSent');
      break;
    case 'guest-approved':
      streamState.role = 'guest';
      streamState.pendingGuestRequest = false;
      streamState.localStream = streamState.pendingGuestStream;
      streamState.pendingGuestStream = null;
      (msg.viewers || []).forEach((viewerId) => createViewerPeer(viewerId));
      renderCoin(streamState.mint);
      break;
    case 'guest-denied':
      if (streamState.pendingGuestStream) {
        streamState.pendingGuestStream.getTracks().forEach((track) => track.stop());
        streamState.pendingGuestStream = null;
      }
      streamState.pendingGuestRequest = false;
      refreshStreamControls();
      setStreamStatus('streamGuestDenied');
      break;
    case 'guest-joined':
      if (streamState.role === 'broadcaster') {
        streamState.guestRequests.delete(msg.guestId);
        createViewerPeer(msg.guestId);
      }
      renderCoin(streamState.mint);
      break;
    case 'guest-left':
      updateStreamViewerCount(msg.viewerCount || 0);
      closeViewerPeer(msg.guestId);
      closeIncomingPublisher(msg.guestId);
      streamState.remoteStreams.delete(msg.guestId);
      removeStreamVideo(msg.guestId);
      refreshStreamControls();
      break;
    case 'stream-ended': {
      streamState.ended = true;
      if (streamState.pendingGuestStream) {
        streamState.pendingGuestStream.getTracks().forEach((track) => track.stop());
        streamState.pendingGuestStream = null;
        streamState.pendingGuestRequest = false;
      }
      if (streamState.role === 'guest' && streamState.localStream) {
        streamState.localStream.getTracks().forEach((track) => track.stop());
        streamState.localStream = null;
        streamState.role = 'viewer';
      }
      for (const pc of streamState.viewerPeers.values()) pc.close();
      streamState.viewerPeers.clear();
      for (const pc of streamState.peers.values()) pc.close();
      streamState.peers.clear();
      streamState.remoteStreams.clear();
      const stage = document.getElementById('streamStage');
      if (stage) stage.replaceChildren();
      setStreamStatus('streamEnded');
      break;
    }
    case 'offer':
      // Audience and approved co-hosts answer publisher offers.
      if (streamState.role !== 'viewer' && streamState.role !== 'guest') break;
      answerStreamOffer(msg.sdp, msg.from, msg.publisherId);
      break;
    case 'answer':
      // Publishers accept answers from their audience and co-hosts.
      if (streamState.role !== 'broadcaster' && streamState.role !== 'guest') break;
      {
        const pc = streamState.peers.get(msg.from);
        if (pc && pc.signalingState !== 'closed') {
          pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)).catch(() => {});
        }
      }
      break;
    case 'ice': {
      const pc = streamState.role === 'broadcaster' || streamState.role === 'guest'
        ? streamState.peers.get(msg.from)
        : streamState.viewerPeers.get(msg.from);
      if (pc && msg.candidate) {
        pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
      }
      break;
    }
    case 'chat':
      appendStreamChat(msg);
      break;
    case 'authed':
      streamState.authed = true;
      refreshStreamChatAuth();
      refreshStreamControls();
      toast(translate('streamChatEnabled'));
      break;
    case 'error':
      if (streamState.pendingGuestStream) {
        streamState.pendingGuestStream.getTracks().forEach((track) => track.stop());
        streamState.pendingGuestStream = null;
        streamState.pendingGuestRequest = false;
        refreshStreamControls();
      }
      if (streamState.role === 'broadcaster' && !streamState.joined) stopStream();
      setStreamStatus('streamErrorToast', { msg: msg.error || '' });
      toast(translate('streamErrorToast', { msg: msg.error || '' }));
      break;
    default:
      break;
  }
}

function openStreamSocket(mint, onOpen) {
  const ws = new WebSocket(streamWsUrl(mint));
  streamState.ws = ws;
  ws.onopen = onOpen;
  ws.onmessage = (e) => {
    try {
      handleStreamMessage(JSON.parse(e.data));
    } catch {
      /* ignore malformed frames */
    }
  };
  ws.onclose = () => {
    // The socket closing ends the stream for this tab (server restart,
    // network drop, or the broadcaster leaving). Keep the panel's
    // "stream ended" state instead of silently hanging.
    if (streamState.ws === ws && streamState.role) {
      const starting = streamState.role === 'broadcaster' && !streamState.joined;
      if (starting) {
        stopStream();
        setStreamStatus('streamError');
        toast(translate('streamError'));
        return;
      }
      streamState.ended = true;
      if (streamState.pendingGuestStream) {
        streamState.pendingGuestStream.getTracks().forEach((track) => track.stop());
        streamState.pendingGuestStream = null;
      }
      setStreamStatus('streamEnded');
    }
  };
  ws.onerror = () => {
    setStreamStatus('streamError');
  };
}

// Broadcaster: one peer connection per viewer, fed with the local stream.
async function createViewerPeer(viewerId) {
  if (!viewerId || streamState.peers.has(viewerId)) return;
  const pc = new RTCPeerConnection(STREAM_STUN);
  streamState.peers.set(viewerId, pc);
  if (streamState.localStream) {
    streamState.localStream.getTracks().forEach((t) => pc.addTrack(t, streamState.localStream));
  }
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      streamSend({ type: 'ice', to: viewerId, candidate: e.candidate.toJSON() });
    }
  };
  pc.ontrack = (e) => {
    const remoteStream = e.streams[0];
    if (!remoteStream) return;
    streamState.remoteStreams.set(viewerId, remoteStream);
    attachStreamVideo(viewerId, remoteStream, false);
  };
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    streamSend({ type: 'offer', to: viewerId, sdp: pc.localDescription });
  } catch {
    closeViewerPeer(viewerId);
  }
}

function closeViewerPeer(viewerId) {
  const pc = streamState.peers.get(viewerId);
  if (pc) {
    try {
      pc.close();
    } catch {
      /* already closed */
    }
    streamState.peers.delete(viewerId);
  }
  streamState.remoteStreams.delete(viewerId);
  removeStreamVideo(viewerId);
}

function closeIncomingPublisher(publisherId) {
  const pc = streamState.viewerPeers.get(publisherId);
  if (pc) {
    try {
      pc.close();
    } catch {
      /* already closed */
    }
    streamState.viewerPeers.delete(publisherId);
  }
}

function attachStreamVideo(peerId, mediaStream, muted) {
  const stage = document.getElementById('streamStage');
  if (!stage) return;
  const key = String(peerId);
  let video = stage.querySelector(`[data-stream-peer="${key}"]`);
  if (!video) {
    video = document.createElement('video');
    video.dataset.streamPeer = key;
    video.autoplay = true;
    video.playsInline = true;
    stage.appendChild(video);
  }
  video.srcObject = mediaStream;
  video.muted = !!muted;
  video.classList.toggle('is-mirrored', !!muted && streamState.mirrorPreview);
  video.play().catch(() => {});
}

function removeStreamVideo(peerId) {
  const stage = document.getElementById('streamStage');
  const video = stage && stage.querySelector(`[data-stream-peer="${String(peerId)}"]`);
  if (video) video.remove();
}

async function getStreamMedia() {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    const message = err && typeof err.message === 'string' ? err.message : '';
    const audioSourceUnavailable =
      (err && ['NotReadableError', 'NotFoundError', 'OverconstrainedError'].includes(err.name)) ||
      /audio source|microphone|audio input/i.test(message);
    if (!audioSourceUnavailable) throw err;
    try {
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (fallbackErr) {
      throw new Error(
        `${friendlyError(fallbackErr)} (audio capture also failed: ${friendlyError(err)})`
      );
    }
  }
}

function streamHasAudio(mediaStream) {
  if (typeof mediaStream.getAudioTracks === 'function') {
    return mediaStream.getAudioTracks().length > 0;
  }
  return mediaStream.getTracks().some((track) => track.kind === 'audio');
}

// Viewers and approved co-hosts answer publisher offers. Co-hosts include
// their own camera/mic in the answer to the creator's peer connection.
async function answerStreamOffer(sdp, publisherId, publisherConnId) {
  try {
    const peerId = publisherId || 'broadcaster';
    closeIncomingPublisher(peerId);
    const pc = new RTCPeerConnection(STREAM_STUN);
    streamState.viewerPeers.set(peerId, pc);
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        streamSend({ type: 'ice', to: peerId, candidate: e.candidate.toJSON() });
      }
    };
    pc.ontrack = (e) => {
      const remoteStream = e.streams[0];
      if (!remoteStream) return;
      streamState.remoteStreams.set(peerId, remoteStream);
      attachStreamVideo(peerId, remoteStream, false);
      if (streamState.role === 'viewer') setStreamStatus('streamWatching');
    };
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    if (streamState.role === 'guest' && streamState.localStream) {
      streamState.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, streamState.localStream);
      });
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    streamSend({
      type: 'answer',
      to: peerId === 'broadcaster' ? 'broadcaster' : (publisherConnId || peerId),
      sdp: pc.localDescription,
    });
  } catch {
    setStreamStatus('streamError');
  }
}

// Creator opens the camera preview before confirming the livestream.
async function openStreamSetup(mint) {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    setStreamStatus('streamNoMedia');
    toast(translate('streamNoMedia'));
    return;
  }
  if (!state.wallet) {
    toast(translate('errConnectFirst'));
    return;
  }
  try {
    const localStream = await getStreamMedia();
    if (!document.getElementById('streamCard')) {
      localStream.getTracks().forEach((t) => t.stop());
      return;
    }
    closeStreamSetup();
    streamState.previewStream = localStream;
    streamState.audioEnabled = streamHasAudio(localStream);
    streamState.mirrorPreview = true;
    const modal = document.createElement('div');
    modal.id = 'streamSetupModal';
    modal.className = 'modal-overlay stream-setup-overlay';
    modal.innerHTML = `
      <section class="modal stream-setup-modal" role="dialog" aria-modal="true" aria-labelledby="streamSetupTitle">
        <button class="modal-close" id="streamSetupClose" aria-label="${translate('streamSetupCancel')}">×</button>
        <h2 id="streamSetupTitle">${translate('streamSetupTitle')}</h2>
        <div class="stream-video-wrap stream-setup-video-wrap">
          <video id="streamSetupVideo" class="is-mirrored" autoplay muted playsinline></video>
        </div>
        <label class="stream-mirror-option"><input id="streamMirrorToggle" type="checkbox" checked> ${translate('streamMirrorCamera')}</label>
        <p class="small muted stream-setup-status" id="streamSetupStatus">${streamState.audioEnabled ? '' : translate('streamAudioOnly')}</p>
        <div class="stream-setup-actions">
          <button class="btn" id="streamSetupCancel">${translate('streamSetupCancel')}</button>
          <button class="btn btn-primary" id="streamSetupStart">${translate('streamGoLiveBtn')}</button>
        </div>
      </section>`;
    document.body.appendChild(modal);
    const video = document.getElementById('streamSetupVideo');
    video.srcObject = localStream;
    video.play().catch(() => {});
    const mirrorToggle = document.getElementById('streamMirrorToggle');
    mirrorToggle.addEventListener('change', () => {
      streamState.mirrorPreview = mirrorToggle.checked;
      video.classList.toggle('is-mirrored', streamState.mirrorPreview);
    });
    const cancel = () => {
      if (document.getElementById('streamSetupStart')?.disabled) return;
      closeStreamSetup();
    };
    modal.addEventListener('click', (event) => {
      if (event.target === modal) cancel();
    });
    document.getElementById('streamSetupClose').addEventListener('click', cancel);
    document.getElementById('streamSetupCancel').addEventListener('click', cancel);
    streamState.setupKeydown = (event) => {
      if (event.key === 'Escape' && !document.getElementById('streamSetupStart').disabled) cancel();
    };
    document.addEventListener('keydown', streamState.setupKeydown);
    document.getElementById('streamSetupStart').addEventListener('click', (event) => {
      event.currentTarget.disabled = true;
      document.getElementById('streamSetupCancel').disabled = true;
      document.getElementById('streamSetupClose').disabled = true;
      document.getElementById('streamSetupStatus').textContent = translate('streamConnecting');
      startStream(mint);
    });
  } catch (err) {
    const message = ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(err?.name)
      ? translate('streamCameraPermissionDenied')
      : friendlyError(err);
    setStreamStatus('streamStartFailed', { msg: message });
    toast(translate('streamStartFailed', { msg: message }));
  }
}

// Creator goes live: the preview stream -> signature-proven signaling join.
async function startStream(mint) {
  const localStream = streamState.previewStream;
  if (!localStream) return;
  try {
    const phantom = (await waitForPhantom(3000)) || getPhantom();
    if (!phantom) throw new Error(translate('errPhantomShort'));
    if (typeof phantom.signMessage !== 'function') {
      throw new Error(translate('errNoSignMessage'));
    }
    const message = streamStartMessage({ wallet: state.wallet, mint });
    toast(translate('toastSignStreamStart'));
    const signature = await signWalletMessage(phantom, message);
    if (streamState.previewStream !== localStream) return;
    streamState.audioEnabled = streamHasAudio(localStream);
    streamState.mint = mint;
    streamState.role = 'broadcaster';
    streamState.joined = false;
    streamState.ended = false;
    openStreamSocket(mint, () => {
      streamSend({
        type: 'join',
        role: 'broadcaster',
        wallet: state.wallet,
        message,
        signature,
      });
    });
    // The panel flips to the broadcaster view (stop button, live chat)
    // when the server confirms the join — see refreshStreamControls().
  } catch (err) {
    const message = friendlyError(err);
    stopStream();
    setStreamStatus('streamStartFailed', { msg: message });
    toast(translate('streamStartFailed', { msg: message }));
  }
}

// Viewer joins a live room (watch-only; chat needs a one-time signature).
function joinStreamAsViewer(mint) {
  if (streamState.ws && streamState.mint === mint && streamState.role === 'viewer') return;
  stopStream();
  streamState.mint = mint;
  streamState.role = 'viewer';
  streamState.ended = false;
  setStreamStatus('streamConnecting');
  openStreamSocket(mint, () => {
    streamSend({ type: 'join', role: 'viewer' });
  });
}

// One-time chat auth: sign the canonical stream-join message so the
// server knows the chat author is the wallet owner.
async function authStreamChat(mint) {
  if (!state.wallet) {
    toast(translate('errConnectFirst'));
    return;
  }
  try {
    const phantom = (await waitForPhantom(3000)) || getPhantom();
    if (!phantom) throw new Error(translate('errPhantomShort'));
    if (typeof phantom.signMessage !== 'function') {
      throw new Error(translate('errNoSignMessage'));
    }
    const message = streamJoinMessage({ wallet: state.wallet, mint });
    toast(translate('toastSignStreamJoin'));
    const signature = await signWalletMessage(phantom, message);
    streamSend({ type: 'auth', wallet: state.wallet, message, signature });
  } catch (err) {
    toast(translate('streamAuthFailed', { msg: friendlyError(err) }));
  }
}

function sendStreamChat() {
  const input = document.getElementById('streamChatInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  streamSend({ type: 'chat', text });
  input.value = '';
}

// Swap the stream controls to the broadcaster view (stop button) once the
// server confirms the join. Stopping ends the stream for every viewer.
function refreshStreamControls() {
  const box = document.getElementById('streamControls');
  if (!box) return;
  if (streamState.role === 'broadcaster' && !streamState.ended) {
    const requests = [...streamState.guestRequests.entries()];
    box.innerHTML = `
      <button class="btn btn-sell" id="streamStopBtn">${translate('streamStopBtn')}</button>
      ${requests.length ? `<div class="stream-guest-requests"><strong>${translate('streamGuestRequests')}</strong>
        ${requests.map(([viewerId, request]) => `
          <div class="stream-guest-request">
            <span>${esc(request.profile?.username || shortAddr(request.wallet))}</span>
            <button class="btn btn-sm btn-primary" data-guest-accept="${esc(viewerId)}">${translate('streamGuestAccept')}</button>
            <button class="btn btn-sm" data-guest-deny="${esc(viewerId)}">${translate('streamGuestDeny')}</button>
          </div>`).join('')}
      </div>` : ''}`;
    const btn = document.getElementById('streamStopBtn');
    if (btn) {
      btn.addEventListener('click', () => {
        stopStream();
        route();
      });
    }
    box.querySelectorAll('[data-guest-accept]').forEach((button) => {
      button.addEventListener('click', () => {
        const viewerId = button.dataset.guestAccept;
        streamState.guestRequests.delete(viewerId);
        streamSend({ type: 'guest-decision', viewerId, accept: true });
        refreshStreamControls();
      });
    });
    box.querySelectorAll('[data-guest-deny]').forEach((button) => {
      button.addEventListener('click', () => {
        const viewerId = button.dataset.guestDeny;
        streamState.guestRequests.delete(viewerId);
        streamSend({ type: 'guest-decision', viewerId, accept: false });
        refreshStreamControls();
      });
    });
  } else if (streamState.role === 'viewer' && !streamState.ended) {
    const mediaOk = navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
    box.innerHTML = `
      <button class="btn btn-primary" id="streamJoinStageBtn"
        ${!streamState.authed || !mediaOk || streamState.pendingGuestRequest ? 'disabled' : ''}>
        ${streamState.pendingGuestRequest ? translate('streamGuestRequestSent') : translate('streamJoinStage')}
      </button>
      ${!streamState.authed ? `<p class="small muted">${translate('streamGuestAuthNote')}</p>` : ''}
      ${!mediaOk ? `<p class="small muted">${translate('streamNoMedia')}</p>` : ''}`;
    const joinBtn = document.getElementById('streamJoinStageBtn');
    if (joinBtn) joinBtn.addEventListener('click', requestStreamGuest);
  } else if (streamState.role === 'guest' && !streamState.ended) {
    box.innerHTML = `<button class="btn" id="streamLeaveStageBtn">${translate('streamLeaveStage')}</button>`;
    const leaveBtn = document.getElementById('streamLeaveStageBtn');
    if (leaveBtn) {
      leaveBtn.addEventListener('click', () => {
        stopStream();
        route();
      });
    }
  }
}

async function requestStreamGuest() {
  if (!streamState.authed || streamState.role !== 'viewer' || streamState.pendingGuestRequest) return;
  try {
    const localStream = await getStreamMedia();
    if (streamState.role !== 'viewer' || !streamState.authed || !streamState.ws) {
      localStream.getTracks().forEach((track) => track.stop());
      return;
    }
    streamState.audioEnabled = streamHasAudio(localStream);
    if (!streamState.audioEnabled) toast(translate('streamAudioOnly'));
    streamState.pendingGuestStream = localStream;
    streamSend({ type: 'guest-request' });
  } catch (err) {
    toast(translate('streamGuestRequestFailed', { msg: friendlyError(err) }));
  }
}

// Show the chat input (authed) or the auth button (wallet connected but
// not authed) or the connect hint (no wallet).
function refreshStreamChatAuth() {
  const box = document.getElementById('streamChatAuth');
  if (!box) return;
  if (streamState.authed) {
    box.innerHTML = `
      <div class="stream-chat-input-row">
        <input id="streamChatInput" type="text" maxlength="280" placeholder="${translate('streamChatPlaceholder')}">
        <button class="btn btn-sm btn-primary" id="streamChatSendBtn">${translate('streamChatSend')}</button>
      </div>`;
    const input = document.getElementById('streamChatInput');
    const sendBtn = document.getElementById('streamChatSendBtn');
    if (sendBtn) sendBtn.addEventListener('click', sendStreamChat);
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendStreamChat();
      });
    }
  } else if (state.wallet) {
    box.innerHTML = `<button class="btn btn-sm" id="streamAuthBtn">${translate('streamAuthBtn')}</button>`;
    const btn = document.getElementById('streamAuthBtn');
    if (btn) {
      btn.addEventListener('click', () => authStreamChat(streamState.mint));
    }
  } else {
    box.innerHTML = `<p class="small muted">${translate('streamChatConnectFirst')}</p>`;
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

// Contact picker for transfer forms: loads the sender's address book
// (GET /api/contacts?owner=) into a <select>; picking a contact fills the
// recipient input. When the book is empty (or fails to load) the picker
// stays hidden and the manual input still works.
async function loadContactPicker(selectEl, inputEl) {
  if (!selectEl || !inputEl || !state.wallet) return;
  try {
    const data = await apiGet(`/api/contacts?owner=${encodeURIComponent(state.wallet)}`);
    const contacts = data.contacts || [];
    if (!contacts.length) return;
    selectEl.hidden = false;
    contacts.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.wallet;
      opt.textContent = `${c.name} (${shortAddr(c.wallet)})`;
      selectEl.appendChild(opt);
    });
    selectEl.addEventListener('change', () => {
      if (selectEl.value) inputEl.value = selectEl.value;
    });
  } catch {
    // Contacts unavailable — the manual address input still works.
  }
}

// ---------- Transfer receipt ----------
// Shared receipt markup (modal after a transfer + the permanent
// #/receipt/<id> page): sender, recipient, coin + logo, amount sent
// (tokens + the USD value snapshotted at transfer time), date/time, and
// the tx signature with an Explorer link.
function receiptHtml(transfer, coin) {
  const ticker = (coin && coin.ticker) || transfer.coinTicker || '';
  const name = (coin && coin.name) || transfer.coinName || '';
  const logoUrl = (coin && coin.logoUrl) || transfer.coinLogoUrl || null;
  const coinLabel = name ? `${name} ($${ticker})` : ticker ? `$${ticker}` : shortAddr(transfer.mintAddress);
  const logo = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="" class="coin-logo">`
    : `<div class="coin-avatar">${esc((ticker || '?').slice(0, 2).toUpperCase())}</div>`;
  return `
    <div class="receipt">
      <h2 style="margin-top:0">🧾 ${translate('receiptTitle')}</h2>
      <div class="receipt-coin">${logo} <b>${esc(coinLabel)}</b></div>
      <div class="receipt-rows">
        <div class="receipt-row"><span class="muted">${translate('receiptFrom')}</span><span>${creatorLink(transfer.fromWallet)}</span></div>
        <div class="receipt-row"><span class="muted">${translate('receiptTo')}</span><span>${creatorLink(transfer.toWallet)}</span></div>
        <div class="receipt-row"><span class="muted">${translate('receiptAmount')}</span><span><b>${fmtTokens(transfer.amount)} ${esc(ticker)}</b>${transfer.usdValue !== null && transfer.usdValue !== undefined ? ` <span class="muted">(${fmtUsd(transfer.usdValue)})</span>` : ''}</span></div>
        <div class="receipt-row"><span class="muted">${translate('receiptDate')}</span><span>${fmtDate(transfer.createdAt)} ${fmtTime(transfer.createdAt)}</span></div>
        <div class="receipt-row"><span class="muted">${translate('receiptTx')}</span><span>${txLink(transfer.txSignature)}</span></div>
      </div>
      <div class="row receipt-actions" style="justify-content:flex-start;margin-top:12px">
        <button class="btn btn-sm" id="receiptCopyBtn">${translate('copyBtn')}</button>
        <button class="btn btn-sm" id="receiptShareBtn">${translate('receiptShareBtn')}</button>
        <button class="btn btn-sm" id="receiptPrintBtn">${translate('receiptPrintBtn')}</button>
      </div>
      <p class="small muted"><a href="#/receipt/${transfer.id}">${translate('receiptPermalink')}</a></p>
    </div>`;
}

// Copy (receipt URL) / share (Web Share API, clipboard fallback) / print
// (opens the receipt page, then the print dialog — the print stylesheet
// hides the app chrome so only the receipt prints).
function wireReceiptActions(transfer) {
  const url = `${location.origin}${location.pathname}#/receipt/${transfer.id}`;
  const copyBtn = document.getElementById('receiptCopyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(url).then(() => toast(translate('receiptCopied')));
    });
  }
  const shareBtn = document.getElementById('receiptShareBtn');
  if (shareBtn) {
    shareBtn.addEventListener('click', async () => {
      const text = translate('receiptShareText', {
        amount: fmtTokens(transfer.amount),
        ticker: transfer.coinTicker || '',
      });
      if (navigator.share) {
        try {
          await navigator.share({ title: translate('receiptTitle'), text, url });
        } catch {
          /* share dismissed */
        }
      } else {
        navigator.clipboard.writeText(`${text} ${url}`).then(() => toast(translate('receiptCopied')));
      }
    });
  }
  const printBtn = document.getElementById('receiptPrintBtn');
  if (printBtn) {
    printBtn.addEventListener('click', () => {
      if (location.hash === `#/receipt/${transfer.id}`) {
        window.print();
      } else {
        hideModal();
        location.hash = `#/receipt/${transfer.id}`;
        setTimeout(() => window.print(), 1000);
      }
    });
  }
}

// Permanent receipt page (#/receipt/<id>).
async function renderReceipt(transferId) {
  const view = document.getElementById('view');
  view.innerHTML = `<p class="muted">${translate('loadingGeneric')}</p>`;
  let data;
  try {
    data = await apiGet(`/api/transfers/${transferId}`);
  } catch (err) {
    view.innerHTML = `<div class="alert alert-error">${esc(translate('errLoadReceipt', { msg: err.message }))}</div>
      <p><a href="#/">${translate('backHome')}</a></p>`;
    return;
  }
  view.innerHTML = `<div class="card">${receiptHtml(data.transfer, data.coin)}</div>`;
  wireReceiptActions(data.transfer);
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
    const recorded = await apiPost('/api/transfers', {
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
    // Receipt modal (with a permalink to the permanent receipt page).
    if (recorded && recorded.transfer) {
      showModal(receiptHtml(recorded.transfer, null));
      wireReceiptActions(recorded.transfer);
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
          <div class="coin-name" style="font-size:1.3rem">${esc(displayName(profile, walletAddress))}${verifiedBadgeHtml({ verified: data.verified })}${badgesHtml(data.badges || [])}</div>
          <div class="small muted mono" style="word-break:break-all">${esc(walletAddress)}</div>
        </div>
        <span class="badge ${isSelf ? 'badge-ok' : 'badge-live'}" style="margin-left:auto">${isSelf ? translate('profileSelf') : translate('profileCreatorTrader')}</span>
        ${isSelf ? `<button class="btn btn-sm" id="editProfileBtn">${translate('profileEditBtn')}</button>` : ''}
        ${state.wallet && !isSelf
          ? `<button class="btn btn-sm ${data.isFollowing ? '' : 'btn-primary'}" id="profileFollowBtn">${data.isFollowing ? translate('followFollowing') : translate('followBtn')}</button>`
          : ''}
      </div>
      <div class="badge-shelf">
        ${(data.badges || []).length
          ? (data.badges || [])
              .map(
                (b) => `<span class="badge-shelf-item" title="${esc(translate(b.descKey))}">${esc(b.icon)} ${esc(translate(b.nameKey))}</span>`
              )
              .join('')
          : `<span class="muted small">${translate('badgesEmpty')}</span>`}
      </div>
      <p class="small muted">${translate('verifiedRuleFull')}</p>
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
  wireAdultReveals(view);

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

// ---------- Livestream pages ----------
async function renderLiveStreaming(selectedMint) {
  const view = document.getElementById('view');
  view.innerHTML = `
    <div class="live-page-heading">
      <div>
        <p class="launchpad-eyebrow">SOLANA DEVNET</p>
        <h1>${translate('navLiveStreaming')}</h1>
      </div>
    </div>
    <p class="muted">${translate('livePageLoading')}</p>`;
  try {
    const [streamData, coinData] = await Promise.all([
      apiGet('/api/streams'),
      apiGet('/api/coins?limit=100'),
    ]);
    const streams = streamData.streams || [];
    if (!streams.length) {
      view.innerHTML = `
        <div class="live-page-heading"><div><p class="launchpad-eyebrow">SOLANA DEVNET</p><h1>${translate('navLiveStreaming')}</h1></div></div>
        <div class="card empty"><h2>${translate('liveNoStreamsTitle')}</h2><p>${translate('liveNoStreamsBody')}</p></div>`;
      return;
    }
    const coinByMint = new Map((coinData.coins || []).map((coin) => [coin.mintAddress, coin]));
    const mint = selectedMint && streams.some((s) => s.mintAddress === selectedMint)
      ? selectedMint
      : streams[0].mintAddress;
    const selected = streams.find((s) => s.mintAddress === mint);
    const coin = coinByMint.get(mint);
    view.innerHTML = `
      <div class="live-page-heading">
        <div><p class="launchpad-eyebrow">SOLANA DEVNET</p><h1>${translate('navLiveStreaming')}</h1></div>
        <span class="badge badge-live-stream">● ${translate('liveBadge')} ${streams.length}</span>
      </div>
      <div class="live-stream-layout">
        <aside class="live-stream-list card">
          <h2>${translate('liveCurrentStreams')}</h2>
          ${streams.map((stream) => {
            const item = coinByMint.get(stream.mintAddress);
            return `
              <a class="live-stream-item ${stream.mintAddress === mint ? 'active' : ''}" href="#/live-streaming/${esc(stream.mintAddress)}">
                ${item ? logoHtml(item) : '<span class="coin-avatar">S</span>'}
                <span class="live-stream-item-copy">
                  <strong>${esc(item ? item.name : shortAddr(stream.mintAddress))}</strong>
                  <span class="muted">${esc(item ? `$${item.ticker}` : shortAddr(stream.mintAddress))}</span>
                </span>
                <span class="live-viewer-count">${stream.viewerCount || 0} ●</span>
              </a>`;
          }).join('')}
        </aside>
        <section class="live-stream-main card">
          <div class="live-stream-title">
            ${coin ? logoHtml(coin) : '<span class="coin-avatar">S</span>'}
            <div><h2>${esc(coin ? coin.name : shortAddr(mint))}</h2><p class="muted">${esc(coin ? `$${coin.ticker}` : shortAddr(mint))}</p></div>
            <span class="badge badge-live-stream">● ${translate('liveBadge')} <span id="streamViewerCount">${selected.viewerCount || 0}</span></span>
          </div>
          <div id="streamCard" class="live-stream-card">
            <div class="stream-stage" id="streamStage"></div>
            <p class="small muted" id="streamStatus">${translate('streamConnecting')}</p>
            <div id="streamControls"></div>
          </div>
        </section>
        <aside class="live-stream-chat card">
          <h2>${translate('streamChatTitle')}</h2>
          <div class="stream-chat">
            <div class="stream-chat-log" id="streamChatLog"><p class="muted small stream-chat-empty">${translate('streamChatEmpty')}</p></div>
            <div id="streamChatAuth"></div>
          </div>
          <p class="small muted">${translate('streamMeshNote')}</p>
        </aside>
      </div>`;
    joinStreamAsViewer(mint);
  } catch (err) {
    view.innerHTML = `<div class="alert alert-error">${esc(translate('liveLoadError', { msg: err.message }))}</div>`;
  }
}

async function renderLiveStreamingCreator() {
  const view = document.getElementById('view');
  if (!state.wallet) {
    view.innerHTML = `
      <div class="live-page-heading"><div><p class="launchpad-eyebrow">CREATOR STUDIO</p><h1>${translate('navLiveCreator')}</h1></div></div>
      <div class="card empty"><h2>${translate('liveCreatorConnectTitle')}</h2><p>${translate('liveCreatorConnectBody')}</p></div>`;
    return;
  }
  view.innerHTML = `
    <div class="live-page-heading"><div><p class="launchpad-eyebrow">CREATOR STUDIO</p><h1>${translate('navLiveCreator')}</h1></div></div>
    <p class="muted">${translate('livePageLoading')}</p>`;
  try {
    const data = await apiGet(`/api/coins?creator=${encodeURIComponent(state.wallet)}&limit=100`);
    const coins = data.coins || [];
    if (!coins.length) {
      view.innerHTML = `
        <div class="live-page-heading"><div><p class="launchpad-eyebrow">CREATOR STUDIO</p><h1>${translate('navLiveCreator')}</h1></div></div>
        <div class="card empty"><h2>${translate('liveCreatorNoCoinsTitle')}</h2><p>${translate('liveCreatorNoCoinsBody')}</p></div>`;
      return;
    }
    const selected = coins.find((coin) => streamState.creatorMint === coin.mintAddress)
      || coins.find((coin) => streamState.mint === coin.mintAddress)
      || coins[0];
    view.innerHTML = `
      <div class="live-page-heading">
        <div><p class="launchpad-eyebrow">CREATOR STUDIO</p><h1>${translate('navLiveCreator')}</h1></div>
      </div>
      <div class="live-creator-layout">
        <aside class="live-creator-coins card">
          <h2>${translate('liveCreatorYourCoins')}</h2>
          ${coins.map((coin) => `
            <button class="live-creator-coin ${coin.mintAddress === selected.mintAddress ? 'active' : ''}" data-live-mint="${esc(coin.mintAddress)}">
              ${logoHtml(coin)}
              <span><strong>${esc(coin.name)}</strong><span class="muted">$${esc(coin.ticker)}</span></span>
            </button>`).join('')}
        </aside>
        <section class="live-stream-main card">
          <div class="live-stream-title">
            ${logoHtml(selected)}
            <div><h2>${esc(selected.name)}</h2><p class="muted">$${esc(selected.ticker)}</p></div>
          </div>
          <div id="streamCard" class="live-stream-card">
            <div class="stream-stage" id="streamStage"></div>
            <p class="small muted" id="streamStatus">${translate('streamNotLive')}</p>
            <div id="streamControls">
              <button class="btn btn-primary" id="streamStartBtn">${translate('streamGoLiveBtn')}</button>
              <p class="small muted">${translate('streamCreatorNote')}</p>
            </div>
          </div>
        </section>
        <aside class="live-stream-chat card">
          <h2>${translate('streamChatTitle')}</h2>
          <div class="stream-chat">
            <div class="stream-chat-log" id="streamChatLog"><p class="muted small stream-chat-empty">${translate('streamChatEmpty')}</p></div>
            <div id="streamChatAuth"></div>
          </div>
        </aside>
      </div>`;
    let activeMint = selected.mintAddress;
    document.querySelectorAll('[data-live-mint]').forEach((button) => {
      button.addEventListener('click', () => {
        if (streamState.role === 'broadcaster') return;
        activeMint = button.dataset.liveMint;
        streamState.creatorMint = activeMint;
        renderLiveStreamingCreator();
      });
    });
    document.getElementById('streamStartBtn')?.addEventListener('click', () => openStreamSetup(activeMint));
  } catch (err) {
    view.innerHTML = `<div class="alert alert-error">${esc(translate('liveLoadError', { msg: err.message }))}</div>`;
  }
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
    <div class="card" id="contactsCard">
      <h2 style="margin-top:0">${translate('contactsTitle')}</h2>
      <p class="small muted">${translate('contactsIntro')}</p>
      <div id="contactsList"><p class="muted">${translate('loadingGeneric')}</p></div>
      <div id="contactsForm" style="margin-top:12px"></div>
      <div id="contactsResult" style="margin-top:8px"></div>
    </div>
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
  renderContactsSection();
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
          <select id="pfTransferContact" hidden>
            <option value="">${translate('contactPickerPlaceholder')}</option>
          </select>
          <input id="pfTransferTo" type="text" placeholder="${translate('transferRecipientPlaceholder')}" autocapitalize="off" autocomplete="off" spellcheck="false" style="margin-top:6px">
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
      loadContactPicker(document.getElementById('pfTransferContact'), document.getElementById('pfTransferTo'));
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

  // Contacts (address book for transfers): add/edit/delete, all
  // signature-proved over the canonical contact messages (same pattern
  // as profile edits). The contact picker in both transfer forms reads
  // from this same book.
  async function renderContactsSection() {
    const list = document.getElementById('contactsList');
    const form = document.getElementById('contactsForm');
    const resEl = document.getElementById('contactsResult');
    const signContact = async (message) => {
      const phantom = (await waitForPhantom(3000)) || getPhantom();
      if (!phantom) throw new Error(translate('errPhantomShort'));
      if (typeof phantom.signMessage !== 'function') {
        throw new Error(translate('errNoSignMessage'));
      }
      toast(translate('toastSignContact'));
      return signWalletMessage(phantom, message);
    };
    const load = async () => {
      try {
        const data = await apiGet(`/api/contacts?owner=${encodeURIComponent(state.wallet)}`);
        const contacts = data.contacts || [];
        if (!contacts.length) {
          list.innerHTML = `<p class="muted">${translate('contactsEmpty')}</p>`;
        } else {
          list.innerHTML = `<ul class="contact-list">${contacts
            .map(
              (c) => `<li data-contact="${c.id}">
                <span><b>${esc(c.name)}</b> <span class="mono muted">${esc(shortAddr(c.wallet))}</span></span>
                <span>
                  <button class="btn btn-sm" data-edit-contact="${c.id}">${translate('contactsEditBtn')}</button>
                  <button class="btn btn-sm" data-delete-contact="${c.id}">${translate('contactsDeleteBtn')}</button>
                </span>
              </li>`
            )
            .join('')}</ul>`;
        }
        list.querySelectorAll('[data-delete-contact]').forEach((b) => {
          b.addEventListener('click', async () => {
            const id = Number(b.dataset.deleteContact);
            b.disabled = true;
            try {
              const message = contactDeleteMessage({ owner: state.wallet, contactId: String(id) });
              const signature = await signContact(message);
              await apiDelete(`/api/contacts/${id}`, {
                ownerWallet: state.wallet,
                message,
                signature,
              });
              toast(translate('contactsDeleted'));
              load();
            } catch (err) {
              toast(translate('contactsDeleteFailed', { msg: friendlyError(err) }));
              b.disabled = false;
            }
          });
        });
        list.querySelectorAll('[data-edit-contact]').forEach((b) => {
          b.addEventListener('click', () => {
            const id = Number(b.dataset.editContact);
            const contact = contacts.find((c) => c.id === id);
            if (!contact) return;
            const li = list.querySelector(`[data-contact="${id}"]`);
            li.innerHTML = `
              <span class="contact-edit">
                <input id="editContactName-${id}" type="text" maxlength="32" value="${esc(contact.name)}">
                <input id="editContactWallet-${id}" type="text" value="${esc(contact.wallet)}" autocapitalize="off" autocomplete="off" spellcheck="false">
              </span>
              <span>
                <button class="btn btn-sm btn-primary" data-save-contact="${id}">${translate('contactsSaveBtn')}</button>
                <button class="btn btn-sm" data-cancel-edit="${id}">${translate('contactsCancelBtn')}</button>
              </span>`;
            li.querySelector(`[data-cancel-edit="${id}"]`).addEventListener('click', load);
            li.querySelector(`[data-save-contact="${id}"]`).addEventListener('click', async (e) => {
              const btn = e.target;
              const name = document.getElementById(`editContactName-${id}`).value.trim();
              const wallet = document.getElementById(`editContactWallet-${id}`).value.trim();
              if (!name || !wallet) {
                toast(translate('errContactFields'));
                return;
              }
              btn.disabled = true;
              try {
                const message = contactEditMessage({
                  owner: state.wallet,
                  contactId: String(id),
                  name,
                  wallet,
                });
                const signature = await signContact(message);
                await apiPut(`/api/contacts/${id}`, {
                  ownerWallet: state.wallet,
                  name,
                  wallet,
                  message,
                  signature,
                });
                toast(translate('contactsSaved'));
                load();
              } catch (err) {
                toast(translate('contactsSaveFailed', { msg: friendlyError(err) }));
                btn.disabled = false;
              }
            });
          });
        });
      } catch (err) {
        list.innerHTML = `<div class="alert alert-error">${esc(translate('contactsLoadFailed', { msg: err.message }))}</div>`;
      }
    };
    form.innerHTML = `
      <div class="field">
        <label for="newContactName">${translate('contactsNameLabel')}</label>
        <input id="newContactName" type="text" maxlength="32" placeholder="${translate('contactsNamePlaceholder')}">
      </div>
      <div class="field">
        <label for="newContactWallet">${translate('contactsWalletLabel')}</label>
        <input id="newContactWallet" type="text" placeholder="${translate('contactsWalletPlaceholder')}" autocapitalize="off" autocomplete="off" spellcheck="false">
      </div>
      <button class="btn btn-primary" id="addContactBtn">${translate('contactsAddBtn')}</button>`;
    document.getElementById('addContactBtn').addEventListener('click', async () => {
      const btn = document.getElementById('addContactBtn');
      const name = document.getElementById('newContactName').value.trim();
      const wallet = document.getElementById('newContactWallet').value.trim();
      if (!name || !wallet) {
        resEl.innerHTML = `<div class="alert alert-error">${translate('errContactFields')}</div>`;
        return;
      }
      btn.disabled = true;
      resEl.innerHTML = `<p class="muted">${translate('contactsAdding')}</p>`;
      try {
        const message = contactAddMessage({ owner: state.wallet, name, wallet });
        const signature = await signContact(message);
        await apiPost('/api/contacts', {
          ownerWallet: state.wallet,
          name,
          wallet,
          message,
          signature,
        });
        resEl.innerHTML = `<div class="alert alert-success">${translate('contactsAdded', { name: esc(name) })}</div>`;
        document.getElementById('newContactName').value = '';
        document.getElementById('newContactWallet').value = '';
        load();
      } catch (err) {
        resEl.innerHTML = `<div class="alert alert-error">${esc(translate('contactsAddFailed', { msg: friendlyError(err) }))}</div>`;
      }
      btn.disabled = false;
    });
    load();
  }

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
                <td>${txLink(tr.txSignature)} <a class="btn btn-sm" href="#/receipt/${tr.id}">${translate('receiptLink')}</a></td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table></div>`;
  }
}

// ---------- Admin: grant trader badges ----------
// Admin-only panel (route #/admin, sidebar link shown only for wallets
// in ADMIN_WALLETS). Every action is signature-proved over the canonical
// admin message and enforced server-side — the client check only hides
// the UI. Granted badges display on profiles exactly like earned ones.
const ADMIN_BADGES = [
  ['creator', '🚀'],
  ['earlyBird', '🐦'],
  ['topTrader', '📈'],
  ['calloutStar', '⭐'],
  ['whale', '🐋'],
];

function adminBadgeNameKey(key) {
  return `badge${key[0].toUpperCase()}${key.slice(1)}`;
}

async function renderAdmin() {
  const view = document.getElementById('view');
  view.innerHTML = `<h1>${translate('navAdmin')}</h1>`;
  if (!state.wallet) {
    view.innerHTML += `
      <div class="card empty">
        <h2>${translate('adminConnectTitle')}</h2>
        <p>${translate('adminConnectBody')}</p>
        <p><button class="btn btn-primary" id="connectAdmin">${translate('headerConnect')}</button></p>
      </div>`;
    document.getElementById('connectAdmin').onclick = connectWallet;
    return;
  }
  view.innerHTML += `<p class="muted">${translate('loadingGeneric')}</p>`;
  // Fresh admin check (not the cached header state — the panel must not
  // render admin controls for a wallet that just lost admin status).
  let isAdmin = false;
  try {
    const data = await apiGet(`/api/admin/status?wallet=${encodeURIComponent(state.wallet)}`);
    isAdmin = !!data.isAdmin;
    state.isAdmin = isAdmin;
    state.adminCheckedWallet = state.wallet;
    renderAdminNavLink();
  } catch {
    isAdmin = false;
  }
  if (!isAdmin) {
    view.innerHTML = `
      <h1>${translate('navAdmin')}</h1>
      <div class="card empty">
        <h2>${translate('adminNotAdminTitle')}</h2>
        <p>${translate('adminNotAdminBody')}</p>
      </div>`;
    return;
  }
  view.innerHTML = `
    <h1>${translate('navAdmin')}</h1>
    <p class="muted">${translate('adminIntro')}</p>
    <div class="card">
      <h2 style="margin-top:0">${translate('adminGrantTitle')}</h2>
      <div class="field">
        <label for="adminWallet">${translate('adminWalletLabel')}</label>
        <input id="adminWallet" type="text" placeholder="${translate('adminWalletPlaceholder')}" autocapitalize="off" autocomplete="off" spellcheck="false">
      </div>
      <div class="field">
        <label for="adminBadge">${translate('adminBadgeLabel')}</label>
        <select id="adminBadge">
          ${ADMIN_BADGES.map(
            ([key, icon]) => `<option value="${key}">${icon} ${esc(translate(adminBadgeNameKey(key)))}</option>`
          ).join('')}
        </select>
      </div>
      <button class="btn btn-primary" id="adminGrantBtn">${translate('adminGrantBtn')}</button>
      <div id="adminGrantResult" style="margin-top:8px"></div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">${translate('adminListTitle')}</h2>
      <p class="small muted">${translate('adminListIntro')}</p>
      <p><button class="btn" id="adminLoadListBtn">${translate('adminLoadListBtn')}</button></p>
      <div id="adminGrantsList"></div>
    </div>`;

  async function signAdmin(action, wallet, badge) {
    const phantom = (await waitForPhantom(3000)) || getPhantom();
    if (!phantom) throw new Error(translate('errPhantomShort'));
    if (typeof phantom.signMessage !== 'function') {
      throw new Error(translate('errNoSignMessage'));
    }
    const message = adminMessage({ admin: state.wallet, action, wallet, badge });
    toast(translate('toastSignAdmin'));
    const signature = await signWalletMessage(phantom, message);
    return { message, signature };
  }

  async function loadGrants() {
    const list = document.getElementById('adminGrantsList');
    list.innerHTML = `<p class="muted">${translate('adminListLoading')}</p>`;
    try {
      const { message, signature } = await signAdmin('list');
      const data = await apiPost('/api/admin/badges/list', {
        adminWallet: state.wallet,
        message,
        signature,
      });
      const grants = data.grants || [];
      if (!grants.length) {
        list.innerHTML = `<p class="muted">${translate('adminListEmpty')}</p>`;
        return;
      }
      list.innerHTML = `
        <div class="table-wrap"><table>
          <thead><tr><th>${translate('adminThWallet')}</th><th>${translate('adminThBadge')}</th><th>${translate('adminThGrantedBy')}</th><th>${translate('adminThWhen')}</th><th></th></tr></thead>
          <tbody>
            ${grants
              .map((g) => {
                const icon = (ADMIN_BADGES.find(([k]) => k === g.badge) || [])[1] || '🏅';
                return `<tr>
                  <td>${creatorLink(g.wallet)}</td>
                  <td>${icon} ${esc(translate(adminBadgeNameKey(g.badge)))}</td>
                  <td>${creatorLink(g.grantedBy)}</td>
                  <td>${fmtTime(g.createdAt)}</td>
                  <td><button class="btn btn-sm" data-revoke="${esc(g.wallet)}" data-badge="${esc(g.badge)}">${translate('adminRevokeBtn')}</button></td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table></div>`;
      list.querySelectorAll('[data-revoke]').forEach((b) => {
        b.addEventListener('click', async () => {
          const wallet = b.dataset.revoke;
          const badge = b.dataset.badge;
          b.disabled = true;
          try {
            const { message, signature } = await signAdmin('revoke', wallet, badge);
            await apiPost('/api/admin/badges/revoke', {
              adminWallet: state.wallet,
              wallet,
              badge,
              message,
              signature,
            });
            toast(translate('adminRevokeSuccess', { badge: translate(adminBadgeNameKey(badge)) }));
            loadGrants();
          } catch (err) {
            toast(translate('adminRevokeFailed', { msg: friendlyError(err) }));
            b.disabled = false;
          }
        });
      });
    } catch (err) {
      list.innerHTML = `<div class="alert alert-error">${esc(translate('adminListFailed', { msg: friendlyError(err) }))}</div>`;
    }
  }

  document.getElementById('adminLoadListBtn').addEventListener('click', loadGrants);

  document.getElementById('adminGrantBtn').addEventListener('click', async () => {
    const btn = document.getElementById('adminGrantBtn');
    const resEl = document.getElementById('adminGrantResult');
    const wallet = document.getElementById('adminWallet').value.trim();
    const badge = document.getElementById('adminBadge').value;
    if (!wallet) {
      resEl.innerHTML = `<div class="alert alert-error">${translate('errAdminFields')}</div>`;
      return;
    }
    btn.disabled = true;
    resEl.innerHTML = `<p class="muted">${translate('adminGranting')}</p>`;
    try {
      const { message, signature } = await signAdmin('grant', wallet, badge);
      await apiPost('/api/admin/badges/grant', {
        adminWallet: state.wallet,
        wallet,
        badge,
        message,
        signature,
      });
      resEl.innerHTML = `<div class="alert alert-success">${translate('adminGrantSuccess', {
        badge: translate(adminBadgeNameKey(badge)),
        addr: esc(shortAddr(wallet)),
      })}</div>`;
      document.getElementById('adminWallet').value = '';
      // Refresh the list if it is already loaded.
      if (document.querySelector('#adminGrantsList table')) loadGrants();
    } catch (err) {
      resEl.innerHTML = `<div class="alert alert-error">${esc(translate('adminGrantFailed', { msg: friendlyError(err) }))}</div>`;
    }
    btn.disabled = false;
  });
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
wireSidebar();
initKeyboardShortcuts();
initTheme();
initOnboarding();
window.addEventListener('load', wirePhantom);

renderHeader();
route();
