# solpump

Pembuat coin kripto ala [pump.fun](https://pump.fun) di **Solana devnet**.

- **Minting asli di devnet** lewat dompet Phantom: satu tanda tangan me-mint token SPL beneran (suplai 1.000.000.000, 6 desimal, otoritas mint langsung dicabut). Server memverifikasi mint-nya on-chain lewat devnet RPC sebelum coin masuk feed.
- **Feed coin** yang bisa dicari dan diurutkan, dengan statistik pasar simulasi.
- **Halaman detail coin**: bukti on-chain (alamat mint + transaksi, tautan ke Solana Explorer), grafik harga (area chart dengan sumbu waktu asli dan filter rentang), statistik harga, dan progres kurva bonding.
- **Trading simulasi** (jelas dilabeli SIMULASI — tidak ada transaksi on-chain): panel beli/jual dengan harga bonding-curve constant-product, riwayat transaksi yang bisa difilter, kartu Profit/Loss per coin (metode average-cost), dan halaman **Portofolio Saya** yang merangkum total PnL semua coin.

Nama, ticker, dan logo coin tersimpan di registry situs ini (SQLite) — mint on-chain-nya adalah token SPL standar tanpa metadata Metaplex.

## Teknologi

Single-service Node + Express + SQLite (better-sqlite3), frontend vanilla JS.
Library Solana (`@solana/web3.js` + `@solana/spl-token`) dibundel ke satu file browser (`public/vendor-solana.js`) dengan esbuild — tidak ada dependensi CDN saat runtime.

## Menjalankan lokal

```bash
npm install
npm start
```

Lalu buka http://localhost:3000. Node 22 direkomendasikan (lihat `render.yaml`).

Untuk membuat coin: instal ekstensi [Phantom](https://phantom.app/), atur jaringannya ke **Devnet**, lalu ambil SOL devnet gratis di https://faucet.solana.com (faucet RPC devnet sudah ditutup, jadi tidak ada tombol airdrop di aplikasi).

## Membangun ulang bundle Solana

`public/vendor-solana.js` di-commit ke repo. Setelah upgrade `@solana/web3.js` atau `@solana/spl-token`, bangun ulang dengan:

```bash
npm run build
```

## Testing

```bash
npm start            # di satu terminal (port 3000, atau PORT=3100)
npm run test:e2e     # API: matematika bonding-curve, PnL, guard oversell, penolakan mint palsu
npm run test:ui      # UI: feed, detail coin + grafik, portofolio, form buat coin (jsdom)
npm run test:mint    # simulasi transaksi mint di devnet (tanpa dompet, tanpa biaya)
```

`test:e2e` dan `test:ui` butuh server berjalan dan membersihkan data ujinya sendiri. `test:mint` membuktikan resep mint melawan devnet sungguhan lewat `simulateTransaction` — tidak ada transaksi nyata yang dikirim.

## Konfigurasi

| Variabel | Default | Deskripsi |
|---|---|---|
| `PORT` | `3000` | Port server (Render mengaturnya sendiri) |
| `SOLANA_DEVNET_RPC` | `https://api.devnet.solana.com` | Endpoint RPC devnet untuk verifikasi mint |

## Deploy ke Render

`render.yaml` berisi blueprint satu web service gratis (Node 22). Push repo ini ke GitHub, lalu di Render pilih **New + → Blueprint** dan arahkan ke file tersebut. Perhatian: SQLite di tier gratis Render bersifat ephemeral — data bisa hilang saat restart/redeploy.

## Struktur

```
server.js            entry point Express (API + frontend statis)
src/db.js            skema SQLite (coins, trades)
src/bonding.js       matematika bonding-curve + PnL (average-cost)
src/verify.js        verifikasi mint on-chain via devnet RPC
src/routes.js        endpoint API
src/browser-entry.js entry point bundle browser (esbuild)
public/              frontend (index.html, app.js, solana.js, styles.css)
test/                skrip uji (simulasi mint di devnet)
```

## Endpoint API

| Endpoint | Deskripsi |
|---|---|
| `GET /api/coins?search=&sort=` | Daftar coin + statistik pasar |
| `GET /api/coins/:mint?wallet=` | Detail coin: chart, statistik, trade, PnL dompet |
| `GET /api/portfolio?wallet=` | Portofolio simulasi satu dompet |
| `POST /api/trades` | Eksekusi trade simulasi (beli/jual) |
| `POST /api/coins/register` | Daftarkan coin setelah verifikasi mint on-chain |

## Catatan

- Trading adalah simulasi penuh: harga dari kurva bonding virtual (cadangan awal 30 SOL / 800.000.000 token, kelulusan di 85 SOL), bukan dari pasar on-chain.
- Devnet tidak bernilai uang sungguhan. Jangan gunakan aplikasi ini di mainnet tanpa audit keamanan.
