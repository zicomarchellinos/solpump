'use strict';
// esbuild `inject` shim: several Solana dependencies reference the bare
// `Buffer` global, which does not exist in browsers. esbuild injects this
// import into every module that uses `Buffer`, so the bundled `buffer`
// package backs it.
import { Buffer } from 'buffer';

export { Buffer };
