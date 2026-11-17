'use strict';
// solpump frontend: hash-routed single-page app.
// Views: feed (#/), create (#/create), coin detail (#/coin/<mint>),
// portfolio (#/portfolio). All trading is SIMULATED; only minting is real
// (on Solana devnet, via Phantom).

const EXPLORER = 'https://explorer.solana.com';

// ---------- State ----------
const state = {
  wallet: localStorage.getItem('solpump-wallet') || null,
  balanceSol: null,
  coinCache: null, // last loaded coin detail
  chartRange: 0, // 0 = all, else last N trades
  tradeTab: 'Semua',
  tradeSide: 'buy',
};

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
function fmtPrice(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 0.0001) return n.toLocaleString('id-ID', { maximumFractionDigits: 6 });
  return n.toExponential(2).replace('e', '×10^');
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

async function connectWallet() {
  const phantom = getPhantom();
  if (!phantom) {
    toast('Phantom tidak ditemukan. Instal ekstensi Phantom dulu.');
    window.open('https://phantom.app/', '_blank', 'noopener');
    return;
  }
  try {
    const resp = await phantom.connect();
    state.wallet = resp.publicKey.toString();
    localStorage.setItem('solpump-wallet', state.wallet);
    await refreshBalance();
    renderHeader();
    route();
    toast('Dompet terhubung.');
  } catch (err) {
    toast(`Gagal menghubungkan dompet: ${err.message}`);
  }
}

function disconnectWallet() {
  const phantom = getPhantom();
  if (phantom) phantom.disconnect().catch(() => {});
  state.wallet = null;
  state.balanceSol = null;
  localStorage.removeItem('solpump-wallet');
  renderHeader();
  route();
}

function renderHeader() {
  const box = document.getElementById('walletBox');
  if (state.wallet) {
    box.innerHTML = `
      <span class="wallet-chip">
        <span class="mono">${esc(shortAddr(state.wallet))}</span>
        <span class="bal">${state.balanceSol === null ? '…' : `${fmtSol(state.balanceSol)} SOL`}</span>
      </span>
      <button class="btn btn-sm" id="disconnectBtn">Putuskan</button>`;
    document.getElementById('disconnectBtn').onclick = disconnectWallet;
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
      <div class="badge-sim">SIMULASI TRADING — MINTING ASLI DI DEVNET</div>
      <h1>Buat coin-mu sendiri di Solana devnet</h1>
      <p>Isi nama, ticker, dan logo — satu tanda tangan di Phantom me-mint token SPL beneran di devnet. Lalu perdagangkan di kurva bonding simulasi dan lacak untung-ruginya.</p>
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
    </div>
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
  loadCoins();

  async function loadCoins() {
    const list = document.getElementById('coinList');
    if (!list) return;
    try {
      const params = new URLSearchParams({ sort: feedSort });
      if (feedSearch.trim()) params.set('search', feedSearch.trim());
      const data = await apiGet(`/api/coins?${params}`);
      if (!data.coins.length) {
        list.innerHTML = `
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
        <div>
          <div class="coin-name">${esc(c.name)}</div>
          <div class="coin-ticker">$${esc(c.ticker)}</div>
        </div>
      </div>
      <div class="coin-stats">
        <span>Harga <b>${fmtPrice(c.price)} SOL</b></span>
        <span class="${chg}"><b>${fmtPct(c.changePct)}</b></span>
      </div>
      <div class="coin-stats">
        <span>Market cap <b>${fmtSol(c.marketCapSol)} SOL</b></span>
        <span>Vol <b>${fmtSol(c.volumeSol)}</b></span>
      </div>
      <div class="progress" title="Progres kurva bonding: ${c.progressPct.toFixed(1)}%">
        <div style="width:${c.progressPct.toFixed(1)}%"></div>
      </div>
      <div class="small muted" style="margin-top:4px">Kurva bonding ${c.progressPct.toFixed(1)}% • ${c.txCount} tx</div>
    </div>`;
}

// ---------- Create coin ----------
async function renderCreate() {
  const view = document.getElementById('view');
  const phantom = getPhantom();
  view.innerHTML = `
    <h1>Buat Coin</h1>
    <p class="muted">Minting asli di Solana devnet: suplai 1.000.000.000 token, 6 desimal, otoritas mint langsung dicabut. Nama, ticker, dan logo tersimpan di registry situs ini.</p>
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

  updateWalletStatus();
  document.getElementById('mintBtn').addEventListener('click', () => doMint(logoData));

  function updateWalletStatus() {
    const el = document.getElementById('walletStatus');
    if (!phantom) {
      el.innerHTML = `
        <div class="alert alert-info">
          <strong>Phantom tidak terdeteksi.</strong> Instal ekstensi Phantom di browser ini untuk membuat coin.
          <div style="margin-top:8px"><a class="btn btn-sm" href="https://phantom.app/" target="_blank" rel="noopener">Unduh Phantom</a></div>
        </div>`;
      return;
    }
    if (!state.wallet) {
      el.innerHTML = `
        <div class="alert alert-info">
          <strong>Dompet belum terhubung.</strong> Hubungkan Phantom dulu — pastikan jaringannya <strong>Devnet</strong>.
          <div style="margin-top:8px"><button class="btn btn-sm btn-primary" id="connectFromCreate">Hubungkan Phantom</button></div>
        </div>`;
      document.getElementById('connectFromCreate').onclick = connectWallet;
      return;
    }
    const bal = state.balanceSol;
    const low = bal !== null && bal < 0.01;
    el.innerHTML = `
      <div class="alert ${low ? 'alert-error' : 'alert-success'}">
        <strong>Dompet:</strong> <span class="mono">${esc(state.wallet)}</span><br>
        <strong>Saldo devnet:</strong> ${bal === null ? '…' : `${fmtSol(bal)} SOL`}
        ${low ? `<br>Saldo terlalu rendah untuk minting (butuh ~0,01 SOL untuk sewa akun + biaya). Ambil SOL devnet gratis di <a href="https://faucet.solana.com" target="_blank" rel="noopener">faucet.solana.com</a>.` : ''}
      </div>`;
  }

  async function doMint(logo) {
    const name = document.getElementById('coinName').value.trim();
    const ticker = document.getElementById('coinTicker').value.trim();
    const description = document.getElementById('coinDesc').value.trim();
    const errEl = document.getElementById('mintError');
    const stepsEl = document.getElementById('mintSteps');
    const btn = document.getElementById('mintBtn');
    errEl.innerHTML = '';

    if (!name || !ticker) {
      errEl.innerHTML = '<div class="alert alert-error">Nama dan ticker wajib diisi.</div>';
      return;
    }
    if (!state.wallet) {
      errEl.innerHTML = '<div class="alert alert-error">Hubungkan dompet Phantom dulu.</div>';
      return;
    }
    if (!solanaLibsReady()) {
      errEl.innerHTML =
        '<div class="alert alert-error">Library Solana gagal dimuat. Muat ulang halaman dan coba lagi.</div>';
      return;
    }
    if (state.balanceSol !== null && state.balanceSol < 0.01) {
      errEl.innerHTML =
        '<div class="alert alert-error">Saldo devnet terlalu rendah. Ambil SOL gratis dulu di <a href="https://faucet.solana.com" target="_blank" rel="noopener">faucet.solana.com</a>.</div>';
      return;
    }

    const steps = ['Membangun transaksi mint', 'Tanda tangan di Phantom', 'Mengirim ke devnet', 'Memverifikasi & mendaftarkan coin'];
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
    try {
      paint(0, -1);
      const { transaction, mintKeypair, mintAddress } = await buildMintTransaction(state.wallet);
      paint(1, 0);
      const signature = await signAndSendMint(getPhantom(), transaction, mintKeypair);
      paint(3, 2);
      await apiPost('/api/coins/register', {
        mintAddress,
        name,
        ticker,
        description,
        creatorWallet: state.wallet,
        txSignature: signature,
        image: logo,
      });
      paint(3, 3);
      toast(`Coin $${ticker} berhasil dibuat!`);
      location.hash = `#/coin/${mintAddress}`;
    } catch (err) {
      errEl.innerHTML = `<div class="alert alert-error">Mint gagal: ${esc(err.message)}</div>`;
      stepsEl.innerHTML = '';
      btn.disabled = false;
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
  const { coin, stats, chart, trades, walletPnl, walletTrades } = data;
  const chg = stats.changePct >= 0 ? 'profit' : 'loss';

  view.innerHTML = `
    <div class="card">
      <div class="coin-head">
        ${logoHtml(coin)}
        <div>
          <div class="coin-name" style="font-size:1.3rem">${esc(coin.name)} <span class="muted">$${esc(coin.ticker)}</span></div>
          <div class="small muted">Dibuat ${fmtDate(coin.createdAt)} oleh <span class="mono">${esc(shortAddr(coin.creatorWallet))}</span></div>
        </div>
        <span class="badge badge-ok" style="margin-left:auto">✓ Terverifikasi on-chain</span>
      </div>
      ${coin.description ? `<p>${esc(coin.description)}</p>` : ''}
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

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
        <h2 style="margin:0">Grafik Harga</h2>
        <div><span style="font-size:1.2rem;font-weight:800">${fmtPrice(stats.price)} SOL</span>
        <span class="${chg}"> ${fmtPct(stats.changePct)}</span></div>
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
        <div class="stat"><div class="label">Market Cap</div><div class="value">${fmtSol(stats.marketCapSol)} SOL</div></div>
        <div class="stat"><div class="label">Perubahan</div><div class="value ${chg}">${fmtPct(stats.changePct)}</div></div>
        <div class="stat"><div class="label">Tertinggi</div><div class="value">${fmtPrice(stats.high)} SOL</div></div>
        <div class="stat"><div class="label">Terendah</div><div class="value">${fmtPrice(stats.low)} SOL</div></div>
        <div class="stat"><div class="label">Volume</div><div class="value">${fmtSol(stats.volumeSol)} SOL</div></div>
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
        <h2 style="margin-top:0">Beli / Jual <span class="badge badge-sim">SIMULASI</span></h2>
        <p class="small muted">Trading ini simulasi — tidak ada transaksi on-chain dan tidak memakai SOL asli.</p>
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
    </div>`;

  // Copy buttons
  view.querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Disalin.'));
    });
  });

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
  renderTradeForm();
  renderPnlCard();
  renderTradesTable();

  function renderTradeForm() {
    const form = document.getElementById('tradeForm');
    const pnl = walletPnl;
    const holdings = pnl ? pnl.holdings : 0;
    if (!state.wallet) {
      form.innerHTML = `<p class="muted">Hubungkan dompet Phantom untuk trading (simulasi).</p>
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
        <button class="btn btn-buy" id="buyBtn">Beli $${esc(coin.ticker)} (Simulasi)</button>`;
      const input = document.getElementById('buySol');
      const update = () => {
        const sol = Number(input.value);
        const est = document.getElementById('buyEstimate');
        if (sol > 0) {
          const tokens = (coin.tokenReserve * sol) / (coin.solReserve + sol);
          est.textContent = `≈ ${fmtTokens(tokens)} ${coin.ticker} (harga eksekusi ≈ ${fmtPrice(sol / tokens)} SOL)`;
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
            <button class="btn" id="maxSell">MAX (${fmtTokens(holdings)})</button>
          </div>
          <div class="estimate" id="sellEstimate"></div>
        </div>
        <button class="btn btn-sell" id="sellBtn">Jual $${esc(coin.ticker)} (Simulasi)</button>`;
      const input = document.getElementById('sellTokens');
      const update = () => {
        const tokens = Number(input.value);
        const est = document.getElementById('sellEstimate');
        if (tokens > 0) {
          const sol = (coin.solReserve * tokens) / (coin.tokenReserve + tokens);
          est.textContent = `≈ ${fmtSol(sol)} SOL (harga eksekusi ≈ ${fmtPrice(sol / tokens)} SOL)`;
        } else est.textContent = '';
      };
      input.addEventListener('input', update);
      document.getElementById('maxSell').addEventListener('click', () => {
        input.value = holdings;
        update();
      });
      document.getElementById('sellBtn').addEventListener('click', async () => {
        const tokens = Number(input.value);
        if (!(tokens > 0)) return toast('Masukkan jumlah token.');
        await submitTrade('sell', { tokenAmount: tokens });
      });
    }
    if (pnl && pnl.totalTrades > 0) {
      form.insertAdjacentHTML(
        'beforeend',
        `<p class="small" style="margin-top:10px">Posisimu: <b>${fmtTokens(pnl.holdings)} ${esc(
          coin.ticker
        )}</b> (${fmtSol(pnl.currentValueSol)} SOL) •
        PnL <b class="${pnl.totalPnlSol >= 0 ? 'profit' : 'loss'}">${fmtSignedSol(pnl.totalPnlSol)} (${fmtPct(
          pnl.roiPct
        )})</b></p>`
      );
    }
  }

  async function submitTrade(side, amounts) {
    const resEl = document.getElementById('tradeResult');
    try {
      const res = await apiPost('/api/trades', {
        mintAddress: coin.mintAddress,
        wallet: state.wallet,
        side,
        ...amounts,
      });
      resEl.innerHTML = `<div class="alert alert-success">${side === 'buy' ? 'Beli' : 'Jual'} berhasil: ${fmtTokens(
        res.trade.tokenAmount
      )} ${esc(coin.ticker)} untuk ${fmtSol(res.trade.solAmount)} SOL @ ${fmtPrice(res.trade.price)} SOL.</div>`;
      setTimeout(() => renderCoin(mintAddress), 600);
    } catch (err) {
      resEl.innerHTML = `<div class="alert alert-error">Gagal: ${esc(err.message)}</div>`;
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
        <p class="muted">Belum ada transaksi simulasi di coin ini. Beli dulu untuk mulai melacak PnL.</p>`;
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
        <div class="stat"><div class="label">Holdings</div><div class="value">${fmtTokens(p.holdings)}</div></div>
        <div class="stat"><div class="label">Harga Rata-rata Beli</div><div class="value">${fmtPrice(p.avgBuyPrice)} SOL</div></div>
        <div class="stat"><div class="label">Cost Basis</div><div class="value">${fmtSol(p.costBasisSol)} SOL</div></div>
        <div class="stat"><div class="label">Nilai Sekarang</div><div class="value">${fmtSol(p.currentValueSol)} SOL</div></div>
        <div class="stat"><div class="label">Unrealized PnL</div><div class="value ${p.unrealizedPnlSol >= 0 ? 'profit' : 'loss'}">${fmtSignedSol(p.unrealizedPnlSol)}</div></div>
        <div class="stat"><div class="label">Realized PnL</div><div class="value ${p.realizedPnlSol >= 0 ? 'profit' : 'loss'}">${fmtSignedSol(p.realizedPnlSol)}</div></div>
        <div class="stat"><div class="label">Total PnL</div><div class="value ${cls}">${fmtSignedSol(p.totalPnlSol)}</div></div>
        <div class="stat"><div class="label">ROI</div><div class="value ${cls}">${fmtPct(p.roiPct)}</div></div>
      </div>
      <p class="small muted" style="margin-top:10px">Metode average-cost, dihitung server dari transaksi simulasi yang tercatat.</p>`;
  }

  function renderTradesTable() {
    const wrap = document.getElementById('tradesTable');
    let rows = trades;
    if (state.tradeTab === 'Beli') rows = trades.filter((t) => t.side === 'buy');
    else if (state.tradeTab === 'Jual') rows = trades.filter((t) => t.side === 'sell');
    else if (state.tradeTab === 'Punyaku') {
      if (!state.wallet) {
        wrap.innerHTML = '<p class="muted">Hubungkan dompet untuk melihat transaksimu.</p>';
        return;
      }
      rows = walletTrades;
    }
    if (!rows.length) {
      wrap.innerHTML = '<p class="muted">Belum ada transaksi.</p>';
      return;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Waktu</th><th>Jenis</th><th>Token</th><th>SOL</th><th>Harga</th><th>Dompet</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (t) => `<tr>
                <td>${fmtTime(t.createdAt)}</td>
                <td><span class="badge ${t.side === 'buy' ? 'badge-buy' : 'badge-sell'}">${
                  t.side === 'buy' ? 'Beli' : 'Jual'
                }</span></td>
                <td>${fmtTokens(t.tokenAmount)}</td>
                <td>${fmtSol(t.solAmount)}</td>
                <td>${fmtPrice(t.price)}</td>
                <td class="mono">${esc(shortAddr(t.wallet))}${t.wallet === state.wallet ? ' (kamu)' : ''}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>`;
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
      '<p class="muted" style="padding:40px 0;text-align:center">Belum ada transaksi — grafik muncul setelah ada trading simulasi.</p>';
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
    tip.innerHTML = `${esc(fmtTime(best.t))}<br><b>${fmtPrice(best.price)} SOL</b>${
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
        <p>Portofolio menampilkan posisi trading simulasi dari dompet yang terhubung.</p>
        <p><button class="btn btn-primary" id="connectPf">Hubungkan Phantom</button></p>
      </div>`;
    document.getElementById('connectPf').onclick = connectWallet;
    return;
  }
  view.innerHTML += '<p class="muted">Memuat portofolio…</p>';
  let data;
  try {
    data = await apiGet(`/api/portfolio?wallet=${encodeURIComponent(state.wallet)}`);
  } catch (err) {
    view.innerHTML += `<div class="alert alert-error">Gagal memuat portofolio: ${esc(err.message)}</div>`;
    return;
  }
  const s = data.summary;
  const cls = s.totalPnlSol >= 0 ? 'profit' : 'loss';
  view.innerHTML = `
    <h1>Portofolio Saya</h1>
    <p class="muted">Dompet <span class="mono">${esc(state.wallet)}</span> • Semua angka dari trading simulasi.</p>
    <div class="card">
      <div class="stat-grid">
        <div class="stat"><div class="label">Total PnL</div><div class="value ${cls}">${fmtSignedSol(s.totalPnlSol)} (${fmtPct(s.totalPnlPct)})</div></div>
        <div class="stat"><div class="label">Nilai Sekarang</div><div class="value">${fmtSol(s.totalCurrentValueSol)} SOL</div></div>
        <div class="stat"><div class="label">Cost Basis</div><div class="value">${fmtSol(s.totalCostBasisSol)} SOL</div></div>
        <div class="stat"><div class="label">Realized PnL</div><div class="value ${s.totalRealizedPnlSol >= 0 ? 'profit' : 'loss'}">${fmtSignedSol(s.totalRealizedPnlSol)}</div></div>
        <div class="stat"><div class="label">Unrealized PnL</div><div class="value ${s.totalUnrealizedPnlSol >= 0 ? 'profit' : 'loss'}">${fmtSignedSol(s.totalUnrealizedPnlSol)}</div></div>
        <div class="stat"><div class="label">Total Beli</div><div class="value">${fmtSol(s.totalBuySol)} SOL</div></div>
        <div class="stat"><div class="label">Total Jual</div><div class="value">${fmtSol(s.totalSellSol)} SOL</div></div>
        <div class="stat"><div class="label">Coin • Transaksi</div><div class="value">${s.coinCount} • ${s.totalTrades}</div></div>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Posisi per Coin</h2>
      ${
        data.positions.length === 0
          ? '<p class="muted">Belum ada posisi. Mulai trading (simulasi) di salah satu coin.</p>'
          : `<div class="table-wrap"><table>
              <thead><tr><th>Coin</th><th>Holdings</th><th>Harga Rata-rata</th><th>Nilai</th><th>PnL</th><th>ROI</th><th></th></tr></thead>
              <tbody>
                ${data.positions
                  .map(
                    (p) => `<tr>
                      <td><a href="#/coin/${esc(p.mintAddress)}"><b>${esc(p.name)}</b> <span class="muted">$${esc(p.ticker)}</span></a></td>
                      <td>${fmtTokens(p.holdings)}</td>
                      <td>${fmtPrice(p.avgBuyPrice)} SOL</td>
                      <td>${fmtSol(p.currentValueSol)} SOL</td>
                      <td class="${p.totalPnlSol >= 0 ? 'profit' : 'loss'}">${fmtSignedSol(p.totalPnlSol)}</td>
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
if (getPhantom()) {
  getPhantom().on('disconnect', () => {
    state.wallet = null;
    state.balanceSol = null;
    localStorage.removeItem('solpump-wallet');
    renderHeader();
    route();
  });
  // Reconnect silently if the wallet was already trusted.
  if (state.wallet) {
    getPhantom()
      .connect({ onlyIfTrusted: true })
      .then(async (resp) => {
        state.wallet = resp.publicKey.toString();
        await refreshBalance();
        renderHeader();
        route();
      })
      .catch(() => {
        state.wallet = null;
        localStorage.removeItem('solpump-wallet');
        renderHeader();
      });
  }
}

renderHeader();
route();
