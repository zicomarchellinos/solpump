'use strict';
// Ed25519 signature verification for wallet-proved actions (follows).
// The client signs a canonical message with Phantom's signMessage; the
// server checks the signature against the claimed wallet address so nobody
// can follow/unfollow on another wallet's behalf. Uses Node's built-in
// crypto (Ed25519 via JWK) — no extra dependency.
//
// Canonical messages (the server rebuilds the expected message from the
// request body and never trusts a client-supplied one):
//   follow:   "solpump:follow:<followingWallet>"
//   unfollow: "solpump:unfollow:<followingWallet>"
// Signatures travel as base64. A replayed signature can only repeat the
// same idempotent follow/unfollow, so no nonce is needed.

const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');

function followMessage(action, followingWallet) {
  return `solpump:${action}:${followingWallet}`;
}

// Verify an Ed25519 signature (base64) over a UTF-8 message, made by the
// holder of `walletAddress` (base58 Solana address). Returns false on any
// malformed input instead of throwing.
function verifyWalletSignature({ walletAddress, message, signatureBase64 }) {
  try {
    if (
      typeof walletAddress !== 'string' ||
      typeof message !== 'string' ||
      typeof signatureBase64 !== 'string'
    ) {
      return false;
    }
    const pubkeyBytes = new PublicKey(walletAddress).toBytes();
    const signature = Buffer.from(signatureBase64, 'base64');
    if (signature.length !== 64) return false;
    const keyObject = crypto.createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(pubkeyBytes).toString('base64url'),
      },
      format: 'jwk',
    });
    return crypto.verify(null, Buffer.from(message, 'utf8'), keyObject, signature);
  } catch {
    return false;
  }
}

module.exports = { followMessage, verifyWalletSignature };
