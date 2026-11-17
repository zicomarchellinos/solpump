# solpump

Pembuat coin kripto ala [pump.fun](https://pump.fun) di **Solana devnet**.

- **Minting asli di devnet** lewat dompet Phantom: satu tanda tangan me-mint token SPL beneran (suplai 1.000.000.000, 6 desimal, otoritas mint langsung dicabut). Server memverifikasi mint-nya on-chain lewat devnet RPC sebelum coin masuk feed. Transaksi di-simulasikan dulu sebelum ditandatangani, dan setiap kegagalan menampilkan pesan error aslinya.
- **Feed coin** yang bisa dicari dan diurutkan, dengan statistik pasar.
- **Halaman detail coin**: bukti on-chain (alamat mint + transaksi, tautan ke Solana Explorer), grafik harga (area chart dengan sumbu waktu asli dan filter rentang), statistik harga, dan progres kurva bonding.
- **Trading ASLI di devnet** lewat dompet pool kustodian (lihat di bawah): panel beli/jual dengan harga bonding-curve constant-product, riwayat transaksi yang bisa difilter lengkap dengan tautan kedua transaksi on-chain, kartu Profit/Loss per coin (metode average-cost), dan halaman **Portofolio Saya** yang merangkum total PnL semua coin. Saldo SOL dan token di UI dibaca langsung dari devnet RPC, bukan dari database lokal.
- **Burn**: pemegang coin bisa membakar tokennya (transaksi SPL burn asli via Phantom, diverifikasi on-chain). Burn mengurangi cadangan token kurva, jadi harga naik; halaman coin menampilkan total burn, riwayat burn, suplai beredar (1B dikurangi total burn), dan pratinjau efek harga.
- **Grafik candlestick**: toggle Area/Candles di halaman coin, candle OHLC dari trade tercatat dengan timeframe 1m/5m/15m/1h, volume bar, harga USD desimal biasa.
- **Deposit & transfer**: halaman portofolio menampilkan alamat deposit dompet sendiri (dengan QR code, library QR di-vendor lokal) + transfer masuk on-chain terbaru; coin bisa dikirim ke alamat Solana mana pun (transfer SPL asli via Phantom, diverifikasi on-chain, riwayat kirim/terima di portofolio).
- **Custom pair**: saat membuat coin, kreator memilih aset pair — SOL (default) atau coin lain yang sudah ada di registry situs. Trading, fee kreator, dan PnL berdenominasi aset pair; harga USD dihitung lewat rantai pair menuju SOL (maks 5 hop, deteksi siklus). Kalau coin pair hilang dari registry, trading coin tersebut nonaktif dengan penjelasan, bukan crash.
- **Profil yang bisa diedit**: satu dompet bisa membuat banyak coin; di halaman profil sendiri, pemilik bisa mengatur username (3–20 karakter, unik tanpa membedakan huruf besar/kecil), foto profil, border avatar (6 preset), dan cover banner. Edit dibuktikan dengan tanda tangan Phantom `signMessage` (Ed25519, diverifikasi server) — tanpa tanda tangan tidak bisa edit. Username/foto/border tampil di kartu coin, callout, daftar pengikut, dan halaman profil.
- **Tiga bahasa**: Indonesia (default), English, dan 简体中文, dengan switcher di header yang tersimpan di localStorage. Semua teks UI lewat kamus `public/i18n.js` (436 kunci per bahasa); format angka tetap seperti semula di semua bahasa.

Nama, ticker, dan logo coin tersimpan di registry situs ini (SQLite) — mint on-chain-nya adalah token SPL standar tanpa metadata Metaplex.

## Trading: model dompet pool

Tidak ada program on-chain kustom — trading memakai **dompet pool kustodian** yang dipegang server:

1. **Pool wallet.** Saat server pertama kali jalan, server membuat satu keypair pool dan menyimpan secret-nya di tabel `meta` di database (atau memakai `POOL_SECRET_KEY` dari environment — lihat Konfigurasi). Alamat pool tampil di footer situs dan di panel trading, dengan tautan ke Solana Explorer.
2. **Funding.** Setelah mint (1B token ke kreator), kreator menandatangani satu transaksi lagi untuk memindahkan **800.000.000 token** ke ATA pool (200.000.000 token tetap di dompet kreator). Server memverifikasi transfer itu on-chain; baru setelah itu coin masuk feed dengan trading aktif. Kalau funding dilewati/gagal, coin tetap tampil tapi trading nonaktif — kreator bisa funding belakangan dari halaman coin.
3. **Beli.** Pengguna menandatangani transfer SOL asli (Phantom) ke pool. Server menunggu konfirmasi on-chain, lalu mengirim token SPL dari pool ke ATA pembeli (transaksi asli yang ditandatangani server), baru kemudian mencatat trade. Harga dari kurva bonding constant-product (cadangan virtual 55 SOL / 800.000.000 token).
4. **Jual.** Pengguna menandatangani transfer token asli ke pool; server mengonfirmasi, lalu mengirim SOL dari pool ke pengguna, baru mencatat trade.
5. **Pra-pemeriksaan.** Sebelum pengguna menandatangani apa pun, server memeriksa saldo pool (token untuk beli, SOL untuk jual) dan saldo token pengguna on-chain — trade yang tidak bisa diselesaikan ditolak dulu dengan pesan yang jelas.
6. **Setiap trade mencatat kedua tanda tangan transaksi** (kaki pengguna + kaki pool) dan menampilkannya di tabel transaksi dengan tautan Explorer. Kaki pool yang gagal dicatat di tabel `failed_trades` (bukan trade) dan pengguna diberi tahu beserta tanda tangannya.

**Peringatan:** ini devnet saja — SOL di sini token testnet gratis tanpa nilai uang. Dompet pool bersifat kustodian: server memegang kuncinya dan menyelesaikan sisi kedua setiap trade. Jangan gunakan model ini di mainnet tanpa audit keamanan.

**Pool keypair di Render (tier gratis):** database SQLite di Render bersifat ephemeral. Kalau service restart tanpa `POOL_SECRET_KEY` yang diset, server membuat pool wallet BARU dan token/SOL di pool lama terlantar (trading gagal secara aman: trade baru ditolak di pra-pemeriksaan). Untuk deployment yang bertahan, set `POOL_SECRET_KEY` di environment Render dengan secret keypair yang sama. Saat pertama kali dibuat, server mencatat alamat pool dan secret-nya (base64) sekali di log dengan peringatan untuk menyimpannya.

## Harga dalam USD

Harga token dan market cap ditampilkan dalam USD, ala pump.fun — pasangannya tetap **TICKER/SOL**, dan semua jumlah yang benar-benar berpindah (input beli/jual, jumlah diterima, saldo pool, fee kreator) tetap dalam SOL.

- **Harga token**: harga SOL dari kurva bonding × kurs SOL/USD, ditampilkan desimal biasa tanpa notasi ilmiah (mis. `$0.000005`).
- **Market cap**: harga × kurs SOL/USD × suplai beredar (1.000.000.000 dikurangi total token yang diburn), dengan sufiks ringkas: `$5K`, `$500K`, `$5M`, `$50M`, `$500M`, `$5B`. Untuk pair coin, harga USD = harga dalam aset pair × harga USD aset pair (dihitung lewat rantai pair menuju SOL); kalau rantai tidak bisa dihitung, harga tampil dalam aset pair saja.
- **Kurs SOL/USD** diambil server dari API harga publik tanpa API key (Jupiter lite price API utama, CoinGecko sebagai cadangan), di-cache 60 detik di server (`src/solprice.js`), dan disertakan di respons API (`solUsd` + field `*Usd`). Kalau semua sumber harga tidak bisa dijangkau, server memakai harga terakhir yang ter-cache; kalau belum pernah ada harga sama sekali, UI kembali menampilkan SOL (tidak pernah crash atau NaN).
- **Market cap awal ≈ $5.000**: cadangan virtual 55 SOL dipilih agar coin baru mulai di sekitar $5K — market cap awal = 55 SOL × (1B / 800M) = 68,75 SOL ≈ **$5.008** pada kurs ~$72,85 (17 Nov 2026). Angka ini kira-kira saja karena kurs SOL/USD bergerak; kalau SOL bergerak jauh, setel ulang `VIRTUAL_SOL` di `src/bonding.js` dengan rumus `5000 / (1,25 × kurs SOL/USD)`.

## Teknologi

Single-service Node + Express + SQLite (better-sqlite3), frontend vanilla JS.
Library Solana (`@solana/web3.js` + `@solana/spl-token`) dibundel ke satu file browser (`public/vendor-solana.js`) dengan esbuild — tidak ada dependensi CDN saat runtime.

## Tampilan

UI-nya mengikuti tampilan pump.fun yang sebenarnya (dipelajari dari situs live + arsipnya, 2026-11-10): tema gelap (`#111113` latar, `#18191b` kartu), sidebar kiri 13rem, aksen hijau muda `#86efac` (tombol utama, teks gelap `#052e16`), hijau untung `#5ddf6c` / merah rugi `#f87171`, font **Geist** (Regular/Medium/Bold, di-vendor di `public/fonts/` — lisensi SIL OFL). Nama "solpump" dan brand mark-nya sendiri; tidak ada logo/aset brand pump.fun yang dipakai. Tata letaknya: strip trending di atas feed, kartu coin bergaya board (logo, nama + ticker, pair TICKER/SOL, waktu pembuatan, market cap, progres kurva bonding), halaman detail dua kolom (grafik + riwayat kiri, panel trading + PnL + fee kanan), dan halaman buat coin dua kolom dengan panel pratinjau live.

## Menjalankan lokal

```bash
npm install
npm start
```

Lalu buka http://localhost:3000. Node 22 direkomendasikan (lihat `render.yaml`).

Untuk membuat coin: instal ekstensi [Phantom](https://phantom.app/), atur jaringannya ke **Devnet** (Pengaturan → Developer Settings → Change Network → Devnet — website tidak bisa mengubah jaringan Phantom secara otomatis), lalu ambil SOL devnet gratis di https://faucet.solana.com (faucet RPC devnet sudah ditutup, jadi tidak ada tombol airdrop di aplikasi).

## Membangun ulang bundle Solana

`public/vendor-solana.js` di-commit ke repo. Setelah upgrade `@solana/web3.js` atau `@solana/spl-token`, bangun ulang dengan:

```bash
npm run build
```

## Testing

```bash
npm start            # di satu terminal (port 3000, atau PORT=3100)
npm run test:e2e     # API: matematika bonding-curve, PnL, penolakan prepare (pool habis / trading nonaktif), penolakan tanda tangan palsu, penolakan mint palsu, burn, candle, transfer, custom pair, multi-coin per dompet, profil (username unik, tanda tangan)
npm run test:ui      # UI: feed, detail coin + grafik/candle/burn/transfer, portofolio + deposit, form buat coin + pair picker, switcher bahasa (3 bahasa), profil + edit form (jsdom)
npm run test:mint    # simulasi transaksi mint di devnet (tanpa dompet, tanpa biaya)
npm run test:mint-flow  # kode klien persis (public/solana.js): deteksi Phantom, genesis devnet, konstruksi tx mint/funding/beli/jual/burn/transfer/pair-buy
```

`test:e2e` dan `test:ui` butuh server berjalan dan membersihkan data ujinya sendiri. `test:mint` dan `test:mint-flow` membuktikan resep mint melawan devnet sungguhan lewat `simulateTransaction` — tidak ada transaksi nyata yang dikirim. Langkah tanda tangan Phantom sendiri tidak bisa diuji di sini (tidak ada ekstensi dompet).

## Konfigurasi

| Variabel | Default | Deskripsi |
|---|---|---|
| `PORT` | `3000` | Port server (Render mengaturnya sendiri) |
| `SOLANA_DEVNET_RPC` | `https://api.devnet.solana.com` | Endpoint RPC devnet untuk verifikasi on-chain |
| `POOL_SECRET_KEY` | _(dibuat & disimpan di DB)_ | Secret keypair pool wallet: array JSON 64 angka, atau string base64. Set ini di production agar pool wallet bertahan restart. |
| `SOL_USD_PRICE` | _(harga live dari API)_ | Override kurs SOL/USD (pengujian + jalan darurat kalau API harga terblokir; jangan diset di production) |

## Deploy ke Render

`render.yaml` berisi blueprint satu web service gratis (Node 22). Push repo ini ke GitHub, lalu di Render pilih **New + → Blueprint** dan arahkan ke file tersebut. Perhatian: SQLite di tier gratis Render bersifat ephemeral — data bisa hilang saat restart/redeploy. Set `POOL_SECRET_KEY` di environment Render (lihat bagian Trading di atas) agar pool wallet tidak berubah.

## Struktur

```
server.js            entry point Express (API + frontend statis)
src/db.js            skema SQLite (coins, trades, meta, failed_trades, burns, transfers, profiles, follows, callouts, fee_claims)
src/bonding.js       matematika bonding-curve + PnL (average-cost) + burn + candle
src/pairs.js         registry aset pair + resolusi harga USD lewat rantai pair
src/signverify.js    verifikasi tanda tangan Ed25519 (follow + edit profil)
src/solprice.js      kurs SOL/USD (Jupiter/CoinGecko, cache 60 detik)
src/rpc.js           koneksi devnet RPC bersama + retry
src/pool.js          keypair pool wallet + transfer SOL/token dari pool
src/verify.js        verifikasi on-chain via devnet RPC (mint, funding, transfer, burn)
src/routes.js        endpoint API
src/browser-entry.js entry point bundle browser (esbuild)
public/              frontend (index.html, app.js, solana.js, i18n.js, styles.css, vendor/qrcode.js)
test/                skrip uji
```

## Endpoint API

| Endpoint | Deskripsi |
|---|---|
| `GET /api/pool` | Alamat dompet pool (publik) |
| `GET /api/sol-price` | Kurs SOL/USD saat ini (cache 60 detik; null kalau belum pernah ada harga) |
| `GET /api/coins?search=&sort=` | Daftar coin + statistik pasar |
| `GET /api/coins/:mint?wallet=` | Detail coin: chart, statistik, trade, PnL dompet, burn, callout |
| `GET /api/coins/:mint/candles?timeframe=` | Candle OHLC (1m/5m/15m/1h, default 5m) |
| `GET /api/coins/:mint/burns` | Riwayat burn + total burn/suplai beredar |
| `GET /api/pairs` | Aset pair yang tersedia (SOL + coin terdaftar) |
| `GET /api/portfolio?wallet=` | Portofolio satu dompet (+ riwayat transfer) |
| `GET /api/deposits?wallet=` | Transfer masuk on-chain terbaru ke dompet itu |
| `GET /api/transfers?wallet=` | Riwayat transfer (kirim + terima) |
| `POST /api/transfers` | Catat transfer setelah verifikasi on-chain |
| `POST /api/trades/prepare` | Kuotasi + pra-pemeriksaan saldo pool/pengguna (sebelum tanda tangan) |
| `POST /api/trades/buy` | Selesaikan beli setelah transfer SOL/pair-token pengguna terverifikasi on-chain |
| `POST /api/trades/sell` | Selesaikan jual setelah transfer token pengguna terverifikasi on-chain |
| `POST /api/coins/register` | Daftarkan coin setelah verifikasi mint (+ funding) on-chain; `pairMint` opsional |
| `POST /api/coins/:mint/fund` | Aktifkan trading dengan memverifikasi transfer funding belakangan |
| `POST /api/coins/:mint/burn` | Catat burn setelah verifikasi on-chain (menaikkan harga) |
| `POST /api/coins/:mint/claim-fees` | Kreator klaim fee 1% (SOL atau pair token) |
| `GET /api/creators/:wallet` | Profil kreator: coin, volume, fee, pengikut, callout, profil editable |
| `GET /api/follows/:wallet` | Daftar pengikut + mengikuti (+ profil mereka) |
| `POST /api/follows` | Follow/unfollow (dibuktikan tanda tangan) |
| `GET /api/profiles/:wallet` | Profil editable satu dompet (atau null) |
| `POST /api/profiles/:wallet` | Edit profil (dibuktikan tanda tangan; username unik) |
| `GET /api/coins/:mint/callouts` | Callout untuk satu coin |
| `POST /api/coins/:mint/callouts` | Posting callout (hanya pembeli terverifikasi) |
| `GET /api/callouts` | Callout terbaru (semua coin / yang diikuti) |

## Catatan

- Harga dari kurva bonding virtual (cadangan awal 55 SOL / 800.000.000 token, kelulusan di 85 SOL), bukan dari pasar on-chain — tapi SOL dan token yang berpindah adalah aset devnet asli.
- Devnet tidak bernilai uang sungguhan. Jangan gunakan aplikasi ini di mainnet tanpa audit keamanan.
