'use strict';
// Livestream signaling for solpump coins — WebRTC MESH, no external
// streaming service.
//
// How it works: the coin's creator broadcasts camera + mic from the coin
// page (getUserMedia); every viewer opens a direct WebRTC peer connection
// to the broadcaster. This server only relays the signaling (offers,
// answers, ICE candidates) and the live chat over WebSocket — media never
// touches the server.
//
// Honest limits (stated in the UI too):
//   - MESH: the broadcaster uploads one stream PER VIEWER, so quality
//     degrades as the audience grows — ~10 viewers is the practical max.
//     The server caps a room at 25 viewers.
//   - No TURN server: a public STUN server (Google's) is the only ICE
//     helper, so viewers behind strict symmetric NATs may fail to connect.
//   - No recording, no replay: when the creator stops or disconnects, the
//     stream is gone. Chat is in-memory only (late joiners see no history).
//   - Chat authorship is signature-proved once per session (the viewer
//     signs streamJoinMessage); unsigned viewers can watch but not chat.
//
// Rooms live in memory only — a server restart ends every stream (the
// same ephemerality as the rest of the free-tier deployment).
//
// Protocol (JSON over /ws/stream?mint=<mint>):
//   Client -> server:
//     { type: 'join', role: 'broadcaster', wallet, message, signature }
//     { type: 'join', role: 'viewer' }
//     { type: 'auth', wallet, message, signature }   (viewer: enable chat)
//     { type: 'offer', to: <viewerId>, sdp }          (broadcaster only)
//     { type: 'answer', sdp }                         (viewer only)
//     { type: 'ice', to: <'broadcaster'|viewerId>, candidate }
//     { type: 'chat', text }                          (authed participants)
//     { type: 'leave' }
//   Server -> client:
//     { type: 'joined', viewerId, live, broadcaster, viewerCount, chatAuthed }
//       (broadcaster joins also get `viewers`: ids of viewers who joined
//       before the stream started — they never trigger viewer-joined, so
//       the broadcaster must offer to them from this list)
//     { type: 'viewer-joined', viewerId, viewerCount }  (to broadcaster)
//     { type: 'viewer-left', viewerId, viewerCount }    (to broadcaster)
//     { type: 'viewer-count', viewerCount }             (to everyone)
//     { type: 'stream-started', broadcaster, viewerCount }
//     { type: 'stream-ended' }
//     { type: 'offer', from: 'broadcaster', sdp }     (relayed to a viewer)
//     { type: 'answer', from: <viewerId>, sdp }       (relayed to broadcaster)
//     { type: 'ice', from, candidate }                (relayed)
//     { type: 'chat', wallet, username, avatarUrl, border, text, time }
//     { type: 'authed', wallet, profile }
//     { type: 'error', error }
// Chat messages also carry the sender's verified flag + community badges
// (computed at join/auth time), so the chat can show checkmarks and badge
// icons next to usernames like the rest of the site.

const crypto = require('crypto');
const db = require('./db');
const badges = require('./badges');
const { getSolUsdPrice } = require('./solprice');
const {
  streamStartMessage,
  streamJoinMessage,
  verifyWalletSignature,
} = require('./signverify');

const MAX_VIEWERS_PER_STREAM = 25;
const CHAT_MAX_CHARS = 280;
const CHAT_MIN_INTERVAL_MS = 2000; // one chat message per 2s per connection
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// mint -> { broadcaster: conn|null, viewers: Map(id -> conn), startedAt }
const rooms = new Map();

function getRoom(mint, create = false) {
  let room = rooms.get(mint);
  if (!room && create) {
    room = { broadcaster: null, viewers: new Map(), startedAt: null };
    rooms.set(mint, room);
  }
  return room || null;
}

function cleanupRoom(mint) {
  const room = rooms.get(mint);
  if (room && !room.broadcaster && room.viewers.size === 0) {
    rooms.delete(mint);
  }
}

// Live streams for the REST API (feed LIVE badges + /api/streams):
// only rooms with a broadcaster count as live.
function getLiveStreams() {
  const out = [];
  for (const [mint, room] of rooms) {
    if (!room.broadcaster) continue;
    out.push({
      mintAddress: mint,
      broadcaster: room.broadcaster.wallet,
      viewerCount: room.viewers.size,
      startedAt: room.startedAt,
    });
  }
  return out;
}

function isLive(mint) {
  const room = rooms.get(mint);
  return !!(room && room.broadcaster);
}

function viewerCount(mint) {
  const room = rooms.get(mint);
  return room ? room.viewers.size : 0;
}

// One coin's live stream (or null when not live) for the coin detail API.
function getLiveStream(mint) {
  const room = rooms.get(mint);
  if (!room || !room.broadcaster) return null;
  return {
    mintAddress: mint,
    broadcaster: room.broadcaster.wallet,
    viewerCount: room.viewers.size,
    startedAt: room.startedAt,
  };
}

function send(ws, obj) {
  if (ws.readyState === 1) {
    // readyState 1 = OPEN (ws.OPEN); the constant is not imported here
    // to keep this module dependency-free.
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      // Socket died mid-send — the close handler cleans up.
    }
  }
}

function broadcast(room, obj, except = null) {
  if (room.broadcaster && room.broadcaster !== except) {
    send(room.broadcaster.ws, obj);
  }
  for (const viewer of room.viewers.values()) {
    if (viewer !== except) send(viewer.ws, obj);
  }
}

function broadcastViewerCount(room) {
  broadcast(room, { type: 'viewer-count', viewerCount: room.viewers.size });
}

function loadProfile(wallet) {
  const row = db.prepare('SELECT * FROM profiles WHERE wallet = ?').get(wallet);
  if (!row) return null;
  return {
    wallet: row.wallet,
    username: row.username || null,
    avatarUrl: row.avatar_url || null,
    border: row.border || 'none',
    coverUrl: row.cover_url || null,
  };
}

// Verified + community badges for a wallet, computed live from the DB
// (async only because the market-cap leg of the verified check needs the
// SOL/USD rate; the price is cached server-side, so this is fast).
async function loadBadges(wallet) {
  const coinMap = new Map();
  for (const row of db.prepare('SELECT * FROM coins').all()) {
    coinMap.set(row.mint_address, row);
  }
  const burnedMap = new Map();
  for (const r of db
    .prepare('SELECT mint_address, COALESCE(SUM(amount), 0) AS total FROM burns GROUP BY mint_address')
    .all()) {
    burnedMap.set(r.mint_address, r.total);
  }
  const { price: solUsd } = await getSolUsdPrice();
  return {
    verified: badges.computeVerifiedSet({ coinMap, burnedMap, solUsd }).has(wallet),
    badges: badges.computeBadgesForWallet(wallet),
  };
}

function attachStreamServer(wss) {
  wss.on('connection', (ws, req) => {
    let mint = null;
    try {
      const url = new URL(req.url, 'http://localhost');
      mint = url.searchParams.get('mint');
    } catch {
      mint = null;
    }
    if (!mint || !BASE58_RE.test(mint)) {
      send(ws, { type: 'error', error: 'Parameter mint tidak valid.' });
      ws.close(1008, 'invalid mint');
      return;
    }
    const conn = {
      id: crypto.randomUUID(),
      ws,
      mint,
      role: null, // 'broadcaster' | 'viewer' after join
      wallet: null,
      authed: false, // may chat (broadcaster: always; viewer: after auth)
      profile: null,
      verified: false,
      badges: [],
      lastChatAt: 0,
      joined: false,
    };

    const fail = (message) => {
      send(ws, { type: 'error', error: message });
    };

    const leaveRoom = () => {
      if (!conn.joined) return;
      const room = rooms.get(mint);
      if (!room) return;
      if (conn.role === 'broadcaster' && room.broadcaster === conn) {
        room.broadcaster = null;
        room.startedAt = null;
        // The stream is over: tell every viewer, then drop the room if
        // nobody is waiting (waiting viewers stay for a possible restart).
        broadcast(room, { type: 'stream-ended' });
      } else if (conn.role === 'viewer' && room.viewers.has(conn.id)) {
        room.viewers.delete(conn.id);
        if (room.broadcaster) {
          send(room.broadcaster.ws, {
            type: 'viewer-left',
            viewerId: conn.id,
            viewerCount: room.viewers.size,
          });
        }
        broadcastViewerCount(room);
      }
      conn.joined = false;
      cleanupRoom(mint);
    };

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return fail('Pesan bukan JSON yang valid.');
      }
      if (!msg || typeof msg.type !== 'string') {
        return fail('Pesan tidak dikenal.');
      }

      // ---- join ----
      if (msg.type === 'join') {
        if (conn.joined) return fail('Sudah bergabung ke stream ini.');
        const role = msg.role;
        if (role !== 'broadcaster' && role !== 'viewer') {
          return fail('role harus "broadcaster" atau "viewer".');
        }
        const coin = db
          .prepare('SELECT * FROM coins WHERE mint_address = ?')
          .get(mint);
        if (!coin) {
          fail('Coin tidak ditemukan.');
          ws.close(1008, 'unknown coin');
          return;
        }
        const room = getRoom(mint, true);
        if (role === 'broadcaster') {
          // Only the coin's creator may go live — wallet check plus
          // signature proof over the canonical stream-start message.
          const { wallet, message, signature } = msg;
          if (typeof wallet !== 'string' || !BASE58_RE.test(wallet)) {
            return fail('Alamat dompet tidak valid.');
          }
          if (wallet !== coin.creator_wallet) {
            return fail('Hanya kreator coin ini yang bisa memulai live stream.');
          }
          if (room.broadcaster) {
            return fail('Coin ini sudah live — hanya satu broadcaster per coin.');
          }
          const expected = streamStartMessage({ wallet, mint });
          if (message !== expected) {
            return fail('Pesan tanda tangan tidak sesuai dengan live stream ini.');
          }
          if (!verifyWalletSignature({ walletAddress: wallet, message, signatureBase64: signature })) {
            return fail('Tanda tangan tidak valid untuk dompet ini.');
          }
          conn.role = 'broadcaster';
          conn.wallet = wallet;
          conn.authed = true;
          conn.profile = loadProfile(wallet);
          const broadcasterBadges = await loadBadges(wallet);
          conn.verified = broadcasterBadges.verified;
          conn.badges = broadcasterBadges.badges;
          conn.joined = true;
          room.broadcaster = conn;
          room.startedAt = Date.now();
          send(ws, {
            type: 'joined',
            viewerId: null,
            live: true,
            broadcaster: wallet,
            viewerCount: room.viewers.size,
            chatAuthed: true,
            verified: conn.verified,
            badges: conn.badges,
            // Waiting viewers who joined before the stream started: they
            // never trigger viewer-joined, so the broadcaster offers to
            // them from this list.
            viewers: [...room.viewers.keys()],
          });
          // Waiting viewers: the stream just started.
          broadcast(room, {
            type: 'stream-started',
            broadcaster: wallet,
            viewerCount: room.viewers.size,
          }, conn);
          return;
        }
        // Viewer: no wallet needed to watch (chat needs auth later).
        if (room.viewers.size >= MAX_VIEWERS_PER_STREAM) {
          return fail(`Room penuh — maksimal ${MAX_VIEWERS_PER_STREAM} penonton per stream.`);
        }
        conn.role = 'viewer';
        conn.joined = true;
        room.viewers.set(conn.id, conn);
        send(ws, {
          type: 'joined',
          viewerId: conn.id,
          live: !!room.broadcaster,
          broadcaster: room.broadcaster ? room.broadcaster.wallet : null,
          viewerCount: room.viewers.size,
          chatAuthed: false,
        });
        if (room.broadcaster) {
          send(room.broadcaster.ws, {
            type: 'viewer-joined',
            viewerId: conn.id,
            viewerCount: room.viewers.size,
          });
        }
        broadcastViewerCount(room);
        return;
      }

      // Everything below requires a join first.
      if (!conn.joined) return fail('Bergabung dulu sebelum mengirim pesan.');

      // ---- auth (viewer enables chat) ----
      if (msg.type === 'auth') {
        if (conn.role !== 'viewer') return fail('Hanya viewer yang perlu auth chat.');
        const { wallet, message, signature } = msg;
        if (typeof wallet !== 'string' || !BASE58_RE.test(wallet)) {
          return fail('Alamat dompet tidak valid.');
        }
        const expected = streamJoinMessage({ wallet, mint });
        if (message !== expected) {
          return fail('Pesan tanda tangan tidak sesuai dengan live stream ini.');
        }
        if (!verifyWalletSignature({ walletAddress: wallet, message, signatureBase64: signature })) {
          return fail('Tanda tangan tidak valid untuk dompet ini.');
        }
        conn.wallet = wallet;
        conn.authed = true;
        conn.profile = loadProfile(wallet);
        const viewerBadges = await loadBadges(wallet);
        conn.verified = viewerBadges.verified;
        conn.badges = viewerBadges.badges;
        send(ws, {
          type: 'authed',
          wallet,
          profile: conn.profile,
          verified: conn.verified,
          badges: conn.badges,
        });
        return;
      }

      const room = rooms.get(mint);
      if (!room) return fail('Room stream tidak ditemukan.');

      // ---- signaling relay ----
      if (msg.type === 'offer') {
        // Only the broadcaster sends offers, addressed to one viewer.
        if (conn.role !== 'broadcaster') return fail('Hanya broadcaster yang mengirim offer.');
        const target = room.viewers.get(msg.to);
        if (!target) return fail('Viewer tujuan tidak ditemukan.');
        if (typeof msg.sdp !== 'object' || msg.sdp === null) {
          return fail('Offer harus berisi sdp.');
        }
        send(target.ws, { type: 'offer', from: 'broadcaster', sdp: msg.sdp });
        return;
      }
      if (msg.type === 'answer') {
        if (conn.role !== 'viewer') return fail('Hanya viewer yang mengirim answer.');
        if (!room.broadcaster) return fail('Broadcaster tidak lagi live.');
        if (typeof msg.sdp !== 'object' || msg.sdp === null) {
          return fail('Answer harus berisi sdp.');
        }
        send(room.broadcaster.ws, { type: 'answer', from: conn.id, sdp: msg.sdp });
        return;
      }
      if (msg.type === 'ice') {
        if (msg.candidate === undefined || msg.candidate === null) {
          return fail('ICE harus berisi candidate.');
        }
        if (msg.to === 'broadcaster') {
          if (conn.role !== 'viewer') return fail('Hanya viewer yang mengirim ICE ke broadcaster.');
          if (!room.broadcaster) return fail('Broadcaster tidak lagi live.');
          send(room.broadcaster.ws, { type: 'ice', from: conn.id, candidate: msg.candidate });
          return;
        }
        if (conn.role !== 'broadcaster') {
          return fail('Hanya broadcaster yang mengirim ICE ke viewer.');
        }
        const target = room.viewers.get(msg.to);
        if (!target) return fail('Viewer tujuan tidak ditemukan.');
        send(target.ws, { type: 'ice', from: 'broadcaster', candidate: msg.candidate });
        return;
      }

      // ---- chat ----
      if (msg.type === 'chat') {
        if (!conn.authed || !conn.wallet) {
          return fail('Hubungkan dompet dan tanda tangani pesan chat dulu untuk mengirim chat.');
        }
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (!text) return fail('Chat tidak boleh kosong.');
        if (text.length > CHAT_MAX_CHARS) {
          return fail(`Chat maksimal ${CHAT_MAX_CHARS} karakter.`);
        }
        const now = Date.now();
        if (now - conn.lastChatAt < CHAT_MIN_INTERVAL_MS) {
          return fail('Terlalu cepat — tunggu sebentar sebelum mengirim chat lagi.');
        }
        conn.lastChatAt = now;
        const profile = conn.profile;
        broadcast(room, {
          type: 'chat',
          wallet: conn.wallet,
          username: (profile && profile.username) || null,
          avatarUrl: (profile && profile.avatarUrl) || null,
          border: (profile && profile.border) || 'none',
          verified: conn.verified,
          badges: conn.badges,
          text,
          time: now,
        });
        return;
      }

      // ---- leave ----
      if (msg.type === 'leave') {
        leaveRoom();
        ws.close(1000, 'left');
        return;
      }

      fail('Pesan tidak dikenal.');
    });

    ws.on('close', leaveRoom);
    ws.on('error', leaveRoom);
  });
}

module.exports = {
  attachStreamServer,
  getLiveStreams,
  getLiveStream,
  isLive,
  viewerCount,
  MAX_VIEWERS_PER_STREAM,
  CHAT_MAX_CHARS,
};
