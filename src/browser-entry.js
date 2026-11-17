'use strict';
// Entry point for the browser bundle (built by build.js with esbuild).
// Exposes the Solana libraries as globals for solana.js / app.js:
//   window.solanaWeb3 — @solana/web3.js
//   window.splToken   — @solana/spl-token

import * as solanaWeb3 from '@solana/web3.js';
import * as splToken from '@solana/spl-token';

window.solanaWeb3 = solanaWeb3;
window.splToken = splToken;
