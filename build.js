'use strict';
// Bundles @solana/web3.js + @solana/spl-token into one browser file
// (public/vendor-solana.js) with esbuild. The bundle is committed to the
// repo so deploys never depend on a CDN at runtime; re-run `npm run build`
// after upgrading either library.

const esbuild = require('esbuild');

esbuild
  .build({
    entryPoints: ['src/browser-entry.js'],
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    outfile: 'public/vendor-solana.js',
    // Several Solana deps reference the bare `Buffer` global, which does
    // not exist in browsers; inject the bundled `buffer` package for it.
    inject: ['src/buffer-shim.js'],
    logLevel: 'info',
  })
  .catch(() => process.exit(1));
