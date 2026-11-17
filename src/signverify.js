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
//   profile:  "solpump:profile:<wallet>\nusername:<username or ''>\n
//              border:<border>\navatar:<sha256 of the avatar's base64
//              payload, or ''>\ncover:<sha256 of the cover's base64
//              payload, or ''>"
//   dev-burn:  "solpump:dev-burn:<wallet>\nmint:<mint>\namount:<amount>\n
//              source:pool" — only for pool-reserve burns (the pool wallet
//              burns its own tokens, server-signed, so the creator's
//              signature is the only proof of authorization; a holdings
//              burn needs no message because the on-chain burn transaction
//              itself is signed by the creator's wallet).
//   buyback:   "solpump:buyback:<wallet>\nmint:<mint>\namount:<amount|all>"
//              — spending the creator's unclaimed fees needs the creator's
//              signature, because the pool pays the bought tokens to the
//              creator from a server-signed transfer.
//   re-register: "solpump:re-register:<wallet>\nmint:<mint>" — restoring
//              a wiped coin needs the creator's signature; the server also
//              checks on-chain that the signer created the mint (see
//              verifyReRegister in src/verify.js).
//   reward claim: "solpump:reward-claim:<wallet>\nmint:<mint>\ncallout:<id>\n
//              tier:<10|25|50>" — the pool pays the reward to the callout
//              author from a server-signed transfer, so the claim needs
//              the author's signature.
//   stream start: "solpump:stream-start:<wallet>\nmint:<mint>" — only the
//              coin's creator may go live for that coin; the signature
//              proves the WebSocket broadcaster is the creator.
//   stream join:  "solpump:stream-join:<wallet>\nmint:<mint>" — a viewer
//              signs once per session to chat as their wallet (chat
//              authorship is then bound to the signed wallet for the whole
//              connection; unsigned viewers can watch but not chat).
// The profile message binds the submitted fields (including the image
// CONTENT via its hash) to the signature, so a signed edit cannot be
// replayed with different values. The wallet is in the message too, so a
// signature for one wallet cannot edit another wallet's profile.
// Signatures travel as base64. A replayed follow signature can only repeat
// the same idempotent follow/unfollow, so no nonce is needed there; a
// replayed profile signature can only re-apply the same profile values.

const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');

function followMessage(action, followingWallet) {
  return `solpump:${action}:${followingWallet}`;
}

// Canonical profile-edit message. `username` is '' when cleared/absent,
// `border` is the preset key ('none' default), `avatarHash`/`coverHash`
// are the sha256 hex of the uploaded image's base64 payload ('' when no
// image is submitted in this edit — the existing image is then kept).
function profileMessage({ wallet, username, border, avatarHash, coverHash }) {
  return [
    `solpump:profile:${wallet}`,
    `username:${username || ''}`,
    `border:${border || 'none'}`,
    `avatar:${avatarHash || ''}`,
    `cover:${coverHash || ''}`,
  ].join('\n');
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Canonical dev-burn message (pool source only). `amount` is the exact
// string the client sends (String of the burn amount); the server rebuilds
// it from the request body the same way, so both sides must format the
// number identically (plain JS String(number)).
function devBurnMessage({ wallet, mint, amount, source }) {
  return [
    `solpump:dev-burn:${wallet}`,
    `mint:${mint}`,
    `amount:${amount}`,
    `source:${source}`,
  ].join('\n');
}

// Canonical buyback message. `amount` is the exact amount string the
// client sends — a number, or 'all' for a full buyback of whatever is
// unclaimed at execution time.
function buybackMessage({ wallet, mint, amount }) {
  return [`solpump:buyback:${wallet}`, `mint:${mint}`, `amount:${amount}`].join('\n');
}

// Canonical re-register message. The signer must be the wallet that
// created the mint on-chain (verified separately — see verifyReRegister);
// the signature only proves the request came from that wallet.
function reRegisterMessage({ wallet, mint }) {
  return [`solpump:re-register:${wallet}`, `mint:${mint}`].join('\n');
}

// Canonical reward-claim message. `calloutId` is the callout's numeric id
// (as a string), `tier` is the claimed tier percent (10, 25, or 50).
function rewardClaimMessage({ wallet, mint, calloutId, tier }) {
  return [
    `solpump:reward-claim:${wallet}`,
    `mint:${mint}`,
    `callout:${calloutId}`,
    `tier:${tier}`,
  ].join('\n');
}

// Canonical livestream-start message (broadcaster = the coin's creator).
function streamStartMessage({ wallet, mint }) {
  return [`solpump:stream-start:${wallet}`, `mint:${mint}`].join('\n');
}

// Canonical livestream-join message (viewer signs once per session to
// chat as their wallet).
function streamJoinMessage({ wallet, mint }) {
  return [`solpump:stream-join:${wallet}`, `mint:${mint}`].join('\n');
}

// Canonical contact-book messages (address book for transfers). Writes
// are signature-proved like profile edits: the message binds the owner,
// the action, and the values, so a signature cannot be replayed for a
// different contact or different values.
//   add:    "solpump:contact-add:<owner>\nname:<name>\nwallet:<wallet>"
//   edit:   "solpump:contact-edit:<owner>\ncontact:<id>\nname:<name>\nwallet:<wallet>"
//   delete: "solpump:contact-delete:<owner>\ncontact:<id>"
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
// revoke, list). `wallet`/`badge` are omitted for list. The action is
// part of the signed text, so a signature for one action cannot be
// replayed as another. Must match public/app.js adminMessage exactly.
function adminMessage({ admin, action, wallet, badge }) {
  const lines = [`solpump:admin:${admin}`, `action:${action}`];
  if (wallet) lines.push(`wallet:${wallet}`);
  if (badge) lines.push(`badge:${badge}`);
  return lines.join('\n');
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

module.exports = {
  followMessage,
  profileMessage,
  devBurnMessage,
  buybackMessage,
  reRegisterMessage,
  rewardClaimMessage,
  streamStartMessage,
  streamJoinMessage,
  contactAddMessage,
  contactEditMessage,
  contactDeleteMessage,
  adminMessage,
  sha256Hex,
  verifyWalletSignature,
};
