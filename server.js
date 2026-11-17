'use strict';
// solpump — single-service app: Express API + static frontend + SQLite.
// Listens on PORT (Render sets it) or 3000 locally.

const path = require('path');
const express = require('express');

// Initialize the database (creates data/solpump.db + schema on startup).
require('./src/db');
const api = require('./src/routes');

const app = express();
// Behind Render's proxy; lets req.ip be the real client IP.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Larger JSON limit: coin registration can carry a base64 logo (~900 KB).
app.use(express.json({ limit: '2mb' }));

// API
app.use('/api', api);

// Unknown API routes: JSON 404 (the frontend expects JSON errors, and
// unmatched POSTs would otherwise fall through to Express's HTML 404).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint tidak ditemukan.' });
});

// Solana browser libraries ship as one committed bundle
// (public/vendor-solana.js, built by build.js with esbuild), served with the
// rest of the static frontend — no third-party CDN needed at runtime.

// Uploaded coin logos (data/ is gitignored; files live on the server disk).
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));

// Static single-page frontend.
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback: any non-API route serves the app shell.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// JSON error handler (must be last).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Terjadi kesalahan.' });
});

app.listen(PORT, () => {
  console.log(`solpump listening on port ${PORT}`);
});
