const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const server = http.createServer(app);

// --- Security & middleware ---
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors());
app.use(express.json());
// PWA: the service worker must NEVER be served stale — a cached sw.js pins
// users to an old shell and breaks "install / update" on Android.
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.use(express.static(path.join(__dirname, 'public')));

// --- Session store (per-room) ---
const MAX_HISTORY = 100;
// Grace period before a disconnect counts as a real "leave".
// Mobile browsers kill/suspend sockets when the screen locks or the tab is
// backgrounded — even a 15s grace still shows false "X left" in that case.
// 30s tolerates short backgrounding; anything longer means the phone slept
// and "left" is the honest presence state (same as WhatsApp "last seen").
const LEAVE_GRACE_MS = 30000;
const APP_VERSION = '1.7.5';
const sessions = new Map(); // sessionId -> { id, createdAt, users: Map<socketId,{username,joinedAt}>, usernames:Set<lower>, history:[], pendingLeaves:Map<lower,{timeout,oldSocketId,username}> }

function generateSessionId() {
  // 6-char uppercase alphanumeric, easy to share/remember
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  if (sessions.has(id)) return generateSessionId();
  return id;
}
function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      createdAt: Date.now(),
      users: new Map(),
      usernames: new Set(),
      history: [],
      pendingLeaves: new Map(),
      hasEncrypted: false, // flips true once any E2EE envelope lands (key never touches server)
    });
    console.log(`[session] created ${sessionId}`);
  }
  return sessions.get(sessionId);
}
// Pre-create general for backward compat
getOrCreateSession('general');

function isValidUsername(name) {
  if (typeof name !== 'string') return false;
  const t = name.trim();
  if (t.length < 2 || t.length > 20) return false;
  if (!/^[a-zA-Z0-9 _\-.]{2,20}$/.test(t)) return false;
  return true;
}
function isValidSessionId(id) {
  if (typeof id !== 'string') return false;
  const t = id.trim().toUpperCase();
  if (t.length < 3 || t.length > 20) return false;
  if (!/^[A-Z0-9_-]{3,20}$/.test(t)) return false;
  return true;
}
function isValidMessage(msg) {
  if (typeof msg !== 'string') return false;
  const t = msg.trim();
  if (t.length === 0 || t.length > 500) return false;
  return true;
}
function isValidImage(dataUrl) {
  if (typeof dataUrl !== 'string') return false;
  // ~1.8MB base64 ~ 1.35MB binary, limit to avoid DoS
  if (dataUrl.length > 2_000_000) return false;
  if (!dataUrl.startsWith('data:image/')) return false;
  // allow png/jpeg/gif/webp only
  if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(dataUrl)) return false;
  return true;
}
// --- End-to-end encryption: the server only ever sees opaque envelopes ---
// Clients encrypt with AES-GCM using the room key carried in the URL hash
// (never sent here). Envelope: { enc:1, iv:<b64url, 12 bytes>, data:<b64 ciphertext> }
const MAX_ENC_TEXT = 8192;      // ~500 chars plaintext + GCM tag, base64'd
const MAX_ENC_IMAGE = 2800000;  // ~2MB image + caption + overhead, re-encrypted
const MAX_ENC_VOICE = 1600000;  // ~2min Opus voice note + overhead, re-encrypted
const MAX_ENC_FILE = 4500000;   // ~3MB file + overhead, re-encrypted
const MAX_ENC_POLL = 8192;      // question + up to 5 options, re-encrypted
// Disappearing messages: sender-chosen TTL, strictly from this allowlist.
function cleanBurn(v) {
  return (v === 10 || v === 60 || v === 3600) ? v : null;
}
// Server-side shred: drop from history + tell the room to shred locally.
function scheduleBurn(sessionId, msgId, seconds) {
  setTimeout(() => {
    const s = sessions.get(sessionId);
    if (!s) return;
    const ix = s.history.findIndex(m => m && m.id === msgId);
    if (ix < 0) return;
    s.history.splice(ix, 1);
    io.to(sessionId).emit('message burned', { id: msgId, sessionId });
  }, seconds * 1000);
}
function isValidEnvelope(env, maxData) {
  if (!env || typeof env !== 'object' || env.enc !== 1) return false;
  if (typeof env.iv !== 'string' || typeof env.data !== 'string') return false;
  if (!/^[A-Za-z0-9_-]{16}$/.test(env.iv)) return false; // 12 bytes -> 16 b64url chars
  if (env.data.length < 24 || env.data.length > maxData) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(env.data)) return false;
  return true;
}
const ALLOWED_REACTIONS = ['❤️', '😂', '👍', '🎉', '😮', '😢'];
function findMessage(sess, id) {
  if (!id || typeof id !== 'string') return null;
  return sess.history.find(m => m.id === id) || null;
}
function buildReplyRef(sess, replyToId, replyToUser) {
  if (!replyToId || typeof replyToId !== 'string') return null;
  const target = findMessage(sess, replyToId);
  // Target evicted from history but sender told us who it was for (E2EE flow)
  if (!target) {
    if (typeof replyToUser === 'string' && replyToUser) {
      return { id: replyToId, username: replyToUser.slice(0, 20), snippet: '', type: 'text' };
    }
    return null;
  }
  // Encrypted target: server can't read it — client fills the snippet
  // from its own decrypted copy.
  if (target.enc) {
    return { id: target.id, username: target.username, snippet: '', type: target.type || 'text' };
  }
  const snippetSrc = target.type === 'image' ? (target.message || '[image]') : (target.message || '');
  return {
    id: target.id,
    username: target.username,
    snippet: String(snippetSrc).slice(0, 120),
    type: target.type || 'text',
  };
}
function getUsersList(session) {
  return Array.from(session.users.values()).map(u => u.username).sort((a, b) => a.localeCompare(b));
}
function broadcastUsers(sessionId) {
  const sess = sessions.get(sessionId);
  if (!sess) return;
  io.to(sessionId).emit('users update', { users: getUsersList(sess), count: sess.users.size, sessionId });
}
function pushHistory(session, payload) {
  session.history.push(payload);
  if (session.history.length > MAX_HISTORY) session.history.shift();
}
function joinSession(socket, username, sessionId) {
  const sess = getOrCreateSession(sessionId);
  const lower = username.toLowerCase();
  // Idempotent rejoin: same socket already in this room with same name
  // (e.g. client double-emits join after socket.io recovery) — must come
  // before the username-taken guard, otherwise it false-rejects as "taken".
  if (socket.username === username && socket.sessionId === sessionId && sess.users.has(socket.id)) {
    socket.emit('joined', { username, sessionId, users: getUsersList(sess), history: sess.history, reclaimed: true, hasEncrypted: !!sess.hasEncrypted });
    return true;
  }
  const pending = sess.pendingLeaves.get(lower);
  const isReclaim = !!pending;

  if (sess.usernames.has(lower) && !isReclaim) {
    socket.emit('username error', `"${username}" is already taken in ${sessionId} — try another`);
    return false;
  }
  if (isReclaim) {
    clearTimeout(pending.timeout);
    sess.pendingLeaves.delete(lower);
    sess.users.delete(pending.oldSocketId);
    console.log(`[reclaim] ${username} ${pending.oldSocketId} -> ${socket.id} in ${sessionId}`);
  }
  // clean previous session if socket was in another room
  if (socket.sessionId && socket.sessionId !== sessionId) {
    const oldSess = sessions.get(socket.sessionId);
    if (oldSess && oldSess.users.has(socket.id)) {
      oldSess.users.delete(socket.id);
      oldSess.usernames.delete(socket.username?.toLowerCase());
      socket.leave(socket.sessionId);
      broadcastUsers(socket.sessionId);
    }
  }
  if (socket.username && socket.sessionId === sessionId) {
    // re-join same session with different name
    const oldLower = socket.username.toLowerCase();
    if (oldLower !== lower) {
      sess.usernames.delete(oldLower);
      const oldPending = sess.pendingLeaves.get(oldLower);
      if (oldPending) { clearTimeout(oldPending.timeout); sess.pendingLeaves.delete(oldLower); }
    }
    sess.users.delete(socket.id);
  }

  socket.username = username;
  socket.sessionId = sessionId;
  socket.joinedAt = Date.now();
  sess.users.set(socket.id, { username, joinedAt: socket.joinedAt });
  sess.usernames.add(lower);
  socket.join(sessionId);

  console.log(`[join] ${username} -> ${sessionId} (${socket.id})${isReclaim ? ' (reclaimed)' : ''}`);

  socket.emit('joined', { username, sessionId, users: getUsersList(sess), history: sess.history, reclaimed: isReclaim, hasEncrypted: !!sess.hasEncrypted });

  if (!isReclaim) {
    socket.to(sessionId).emit('user joined', {
      username,
      timestamp: new Date().toISOString(),
      count: sess.users.size,
      sessionId,
    });
  }
  broadcastUsers(sessionId);
  return true;
}

// Health check
app.get('/health', (req, res) => {
  const totalUsers = Array.from(sessions.values()).reduce((a, s) => a + s.users.size, 0);
  res.json({ status: 'ok', version: APP_VERSION, uptime: process.uptime(), sessions: sessions.size, totalUsers, ids: Array.from(sessions.keys()) });
});

// Fallback for SPA
app.get(/.*/, (req, res) => {
  if (req.path.startsWith('/socket.io')) return res.status(404).end();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 5e6, // allow ~2MB base64 images
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
});

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // let client know existing sessions count (for UI)
  // don't spam, just send general users
  const general = sessions.get('general');
  if (general) socket.emit('users update', { users: getUsersList(general), count: general.users.size, sessionId: 'general' });

  socket.on('create session', (data) => {
    const username = data && typeof data.username === 'string' ? data.username.trim() : '';
    if (!isValidUsername(username)) {
      socket.emit('username error', 'Username must be 2–20 chars, letters/numbers/_ - . only');
      return;
    }
    // per-socket rate limit: max 3 creates per 10s
    const now = Date.now();
    socket._createStamps = socket._createStamps || [];
    socket._createStamps = socket._createStamps.filter(t => now - t < 10000);
    if (socket._createStamps.length >= 3) {
      socket.emit('session error', 'Too many session creates — wait a moment');
      return;
    }
    socket._createStamps.push(now);
    const sessionId = generateSessionId();
    getOrCreateSession(sessionId);
    const ok = joinSession(socket, username, sessionId);
    if (ok) socket.emit('session created', { sessionId });
  });

  socket.on('join session', (data) => {
    const username = data && typeof data.username === 'string' ? data.username.trim() : '';
    const sessionIdRaw = data && typeof data.sessionId === 'string' ? data.sessionId : '';
    const sid = sessionIdRaw.trim().toUpperCase();
    if (!isValidUsername(username)) {
      socket.emit('username error', 'Username must be 2–20 chars, letters/numbers/_ - . only');
      return;
    }
    if (!isValidSessionId(sid)) {
      socket.emit('session error', 'Session ID must be 3–20 chars (A-Z, 0-9, _ -)');
      return;
    }
    if (!sessions.has(sid)) {
      socket.emit('session error', `Session "${sid}" not found — create a new one`);
      return;
    }
    joinSession(socket, username, sid);
  });

  // backward compat: old clients using set username -> join general
  socket.on('set username', (rawUsername) => {
    const username = typeof rawUsername === 'string' ? rawUsername.trim() : '';
    if (!isValidUsername(username)) {
      socket.emit('username error', 'Username must be 2–20 chars, letters/numbers/_ - . only');
      return;
    }
    // if client already in a session via new flow, treat as general
    joinSession(socket, username, 'general');
  });

  socket.on('chat message', (rawMsg) => {
    if (!socket.username || !socket.sessionId) {
      socket.emit('chat error', 'Join a session before sending messages');
      return;
    }
    // plaintext (legacy) OR encrypted envelope { enc:1, iv, data, replyToId?, replyToUser? }
    let text = '';
    let replyToId = null;
    let replyToUser = null;
    let envelope = null;
    if (typeof rawMsg === 'string') {
      text = rawMsg;
    } else if (rawMsg && typeof rawMsg === 'object') {
      if (rawMsg.enc === 1) {
        if (!isValidEnvelope(rawMsg, MAX_ENC_TEXT)) {
          socket.emit('chat error', 'Invalid encrypted message');
          return;
        }
        envelope = { enc: 1, iv: rawMsg.iv, data: rawMsg.data };
      } else {
        text = typeof rawMsg.message === 'string' ? rawMsg.message : '';
      }
      replyToId = typeof rawMsg.replyToId === 'string' ? rawMsg.replyToId : null;
      replyToUser = typeof rawMsg.replyToUser === 'string' ? rawMsg.replyToUser : null;
    }
    if (!envelope && !isValidMessage(text)) {
      socket.emit('chat error', 'Message must be 1–500 characters');
      return;
    }
    const sess = sessions.get(socket.sessionId);
    if (!sess) {
      socket.emit('chat error', 'Session not found');
      return;
    }
    // simple spam throttle: max 5 msgs per second
    const now = Date.now();
    socket._msgTimestamps = socket._msgTimestamps || [];
    socket._msgTimestamps = socket._msgTimestamps.filter(t => now - t < 1000);
    if (socket._msgTimestamps.length >= 5) {
      socket.emit('chat error', 'Slow down — too many messages');
      return;
    }
    socket._msgTimestamps.push(now);

    const burn = cleanBurn(rawMsg && typeof rawMsg === 'object' ? rawMsg.burnAfter : null);
    const message = text.trim();
    const payload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}-${socket.id.slice(0, 4)}`,
      username: socket.username,
      ...(envelope ? { enc: 1, iv: envelope.iv, data: envelope.data, message: '' } : { message }),
      type: 'text',
      timestamp: new Date().toISOString(),
      sessionId: socket.sessionId,
      replyTo: buildReplyRef(sess, replyToId, replyToUser),
      reactions: {},
      seenBy: [],
      ...(burn ? { burnAfter: burn } : {}),
    };
    if (envelope) sess.hasEncrypted = true;
    pushHistory(sess, payload);
    if (typeof burn !== 'undefined' && burn) scheduleBurn(socket.sessionId, payload.id, burn);
    io.to(socket.sessionId).emit('chat message', payload);
  });

  socket.on('chat image', (data) => {
    if (!socket.username || !socket.sessionId) {
      socket.emit('chat error', 'Join a session before sending images');
      return;
    }
    const replyToId = data && typeof data.replyToId === 'string' ? data.replyToId : null;
    const replyToUser = data && typeof data.replyToUser === 'string' ? data.replyToUser : null;
    // encrypted envelope { enc:1, iv, data } OR legacy { image, caption }
    let envelope = null;
    let image = '';
    let caption = '';
    const burn = cleanBurn(data && typeof data === 'object' ? data.burnAfter : null);
    if (data && data.enc === 1) {
      if (!isValidEnvelope(data, MAX_ENC_IMAGE)) {
        socket.emit('chat error', 'Invalid encrypted image');
        return;
      }
      envelope = { enc: 1, iv: data.iv, data: data.data };
    } else {
      image = data && typeof data.image === 'string' ? data.image : '';
      caption = data && typeof data.caption === 'string' ? data.caption.trim().slice(0, 200) : '';
      if (!isValidImage(image)) {
        socket.emit('chat error', 'Invalid image — use PNG/JPEG/GIF/WEBP under ~1.5MB');
        return;
      }
    }
    const sess = sessions.get(socket.sessionId);
    if (!sess) {
      socket.emit('chat error', 'Session not found');
      return;
    }
    // reuse spam throttle
    const now = Date.now();
    socket._msgTimestamps = socket._msgTimestamps || [];
    socket._msgTimestamps = socket._msgTimestamps.filter(t => now - t < 1000);
    if (socket._msgTimestamps.length >= 5) {
      socket.emit('chat error', 'Slow down — too many messages');
      return;
    }
    socket._msgTimestamps.push(now);

    const payload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}-${socket.id.slice(0, 4)}`,
      username: socket.username,
      ...(envelope ? { enc: 1, iv: envelope.iv, data: envelope.data, message: '' } : { message: caption, image }),
      type: 'image',
      timestamp: new Date().toISOString(),
      sessionId: socket.sessionId,
      replyTo: buildReplyRef(sess, replyToId, replyToUser),
      reactions: {},
      seenBy: [],
      ...(burn ? { burnAfter: burn } : {}),
    };
    if (envelope) sess.hasEncrypted = true;
    pushHistory(sess, payload);
    if (typeof burn !== 'undefined' && burn) scheduleBurn(socket.sessionId, payload.id, burn);
    io.to(socket.sessionId).emit('chat message', payload);
  });

  // Voice notes are always E2EE envelopes { enc:1, iv, data } holding
  // { audio:<dataURL>, message:<caption>, duration:<s>, peaks:[...], mime }
  socket.on('chat voice', (data) => {
    if (!socket.username || !socket.sessionId) {
      socket.emit('chat error', 'Join a session before sending voice notes');
      return;
    }
    if (!data || data.enc !== 1 || !isValidEnvelope(data, MAX_ENC_VOICE)) {
      socket.emit('chat error', 'Invalid voice note');
      return;
    }
    const burn = cleanBurn(data.burnAfter);
    const replyToId = typeof data.replyToId === 'string' ? data.replyToId : null;
    const replyToUser = typeof data.replyToUser === 'string' ? data.replyToUser : null;
    const sess = sessions.get(socket.sessionId);
    if (!sess) {
      socket.emit('chat error', 'Session not found');
      return;
    }
    // reuse spam throttle
    const now = Date.now();
    socket._msgTimestamps = socket._msgTimestamps || [];
    socket._msgTimestamps = socket._msgTimestamps.filter(t => now - t < 1000);
    if (socket._msgTimestamps.length >= 5) {
      socket.emit('chat error', 'Slow down — too many messages');
      return;
    }
    socket._msgTimestamps.push(now);

    const payload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}-${socket.id.slice(0, 4)}`,
      username: socket.username,
      enc: 1, iv: data.iv, data: data.data, message: '',
      type: 'voice',
      timestamp: new Date().toISOString(),
      sessionId: socket.sessionId,
      replyTo: buildReplyRef(sess, replyToId, replyToUser),
      reactions: {},
      seenBy: [],
      ...(burn ? { burnAfter: burn } : {}),
    };
    sess.hasEncrypted = true;
    pushHistory(sess, payload);
    if (typeof burn !== 'undefined' && burn) scheduleBurn(socket.sessionId, payload.id, burn);
    io.to(socket.sessionId).emit('chat message', payload);
  });

  // Polls: encrypted { question, options[] } envelope; votes live plaintext
  // on the payload (same trust model as reactions).
  socket.on('chat poll', (data) => {
    if (!socket.username || !socket.sessionId) {
      socket.emit('chat error', 'Join a session before sending polls');
      return;
    }
    if (!data || data.enc !== 1 || !isValidEnvelope(data, MAX_ENC_POLL)) {
      socket.emit('chat error', 'Invalid poll');
      return;
    }
    const burn = cleanBurn(data.burnAfter);
    const replyToId = typeof data.replyToId === 'string' ? data.replyToId : null;
    const replyToUser = typeof data.replyToUser === 'string' ? data.replyToUser : null;
    const sess = sessions.get(socket.sessionId);
    if (!sess) {
      socket.emit('chat error', 'Session not found');
      return;
    }
    const now = Date.now();
    socket._msgTimestamps = socket._msgTimestamps || [];
    socket._msgTimestamps = socket._msgTimestamps.filter(t => now - t < 1000);
    if (socket._msgTimestamps.length >= 5) {
      socket.emit('chat error', 'Slow down — too many messages');
      return;
    }
    socket._msgTimestamps.push(now);

    const payload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}-${socket.id.slice(0, 4)}`,
      username: socket.username,
      enc: 1, iv: data.iv, data: data.data, message: '',
      type: 'poll',
      poll: { votes: {} },
      timestamp: new Date().toISOString(),
      sessionId: socket.sessionId,
      replyTo: buildReplyRef(sess, replyToId, replyToUser),
      reactions: {},
      seenBy: [],
      ...(burn ? { burnAfter: burn } : {}),
    };
    sess.hasEncrypted = true;
    pushHistory(sess, payload);
    if (typeof burn !== 'undefined' && burn) scheduleBurn(socket.sessionId, payload.id, burn);
    io.to(socket.sessionId).emit('chat message', payload);
  });

  // Generic files (docs, PDFs, zips ≤3MB): always E2EE envelopes holding
  // { file:<dataURL>, name, size, mime, message:<caption> }.
  socket.on('chat file', (data) => {
    if (!socket.username || !socket.sessionId) {
      socket.emit('chat error', 'Join a session before sending files');
      return;
    }
    if (!data || data.enc !== 1 || !isValidEnvelope(data, MAX_ENC_FILE)) {
      socket.emit('chat error', 'Invalid file — use files under ~3MB');
      return;
    }
    const burn = cleanBurn(data.burnAfter);
    const replyToId = typeof data.replyToId === 'string' ? data.replyToId : null;
    const replyToUser = typeof data.replyToUser === 'string' ? data.replyToUser : null;
    const sess = sessions.get(socket.sessionId);
    if (!sess) {
      socket.emit('chat error', 'Session not found');
      return;
    }
    const now = Date.now();
    socket._msgTimestamps = socket._msgTimestamps || [];
    socket._msgTimestamps = socket._msgTimestamps.filter(t => now - t < 1000);
    if (socket._msgTimestamps.length >= 5) {
      socket.emit('chat error', 'Slow down — too many messages');
      return;
    }
    socket._msgTimestamps.push(now);

    const payload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}-${socket.id.slice(0, 4)}`,
      username: socket.username,
      enc: 1, iv: data.iv, data: data.data, message: '',
      type: 'file',
      timestamp: new Date().toISOString(),
      sessionId: socket.sessionId,
      replyTo: buildReplyRef(sess, replyToId, replyToUser),
      reactions: {},
      seenBy: [],
      ...(burn ? { burnAfter: burn } : {}),
    };
    sess.hasEncrypted = true;
    pushHistory(sess, payload);
    if (typeof burn !== 'undefined' && burn) scheduleBurn(socket.sessionId, payload.id, burn);
    io.to(socket.sessionId).emit('chat message', payload);
  });

  // One vote per user per poll (re-voting moves it). option loosely bound
  // 0..9 since option labels are sealed inside the envelope.
  socket.on('vote', (data) => {
    if (!socket.username || !socket.sessionId) return;
    const messageId = data && typeof data.messageId === 'string' ? data.messageId : '';
    const option = data && typeof data.option === 'number' ? data.option : -1;
    if (!messageId || messageId.length > 80 || !Number.isInteger(option) || option < 0 || option > 9) return;
    const sess = sessions.get(socket.sessionId);
    if (!sess) return;
    const msg = findMessage(sess, messageId);
    if (!msg || msg.type !== 'poll') return;
    // light vote throttle: max 10 votes per 10s
    const now = Date.now();
    socket._voteStamps = socket._voteStamps || [];
    socket._voteStamps = socket._voteStamps.filter(t => now - t < 10000);
    if (socket._voteStamps.length >= 10) return;
    socket._voteStamps.push(now);

    if (!msg.poll || typeof msg.poll !== 'object') msg.poll = { votes: {} };
    if (!msg.poll.votes || typeof msg.poll.votes !== 'object') msg.poll.votes = {};
    for (const k of Object.keys(msg.poll.votes)) {
      const arr = msg.poll.votes[k];
      if (Array.isArray(arr)) {
        const ix = arr.indexOf(socket.username);
        if (ix >= 0) arr.splice(ix, 1);
      }
    }
    const key = String(option);
    if (!Array.isArray(msg.poll.votes[key])) msg.poll.votes[key] = [];
    msg.poll.votes[key].push(socket.username);
    io.to(socket.sessionId).emit('message updated', msg);
  });

  // Read receipts: "<user> has seen everything up to <messageId>".
  // Server stamps seenBy on history (so late joiners see ticks) and relays.
  socket.on('message seen', (data) => {
    if (!socket.username || !socket.sessionId) return;
    const id = data && typeof data.messageId === 'string' ? data.messageId : '';
    if (!id || id.length > 80) return;
    const sess = sessions.get(socket.sessionId);
    if (!sess) return;
    const idx = sess.history.findIndex(m => m.id === id);
    if (idx < 0) return;
    const seer = socket.username;
    let changed = false;
    for (let i = 0; i <= idx; i++) {
      const m = sess.history[i];
      if (!m || m.username === seer) continue;
      m.seenBy = Array.isArray(m.seenBy) ? m.seenBy : [];
      if (!m.seenBy.includes(seer)) {
        if (m.seenBy.length > 50) m.seenBy.shift();
        m.seenBy.push(seer);
        changed = true;
      }
    }
    if (!changed) return;
    io.to(socket.sessionId).emit('messages seen', { username: seer, upToId: id, sessionId: socket.sessionId });
  });

  socket.on('toggle reaction', (data) => {
    if (!socket.username || !socket.sessionId) {
      socket.emit('chat error', 'Join a session before reacting');
      return;
    }
    const messageId = data && typeof data.messageId === 'string' ? data.messageId : '';
    const emoji = data && typeof data.emoji === 'string' ? data.emoji : '';
    if (!ALLOWED_REACTIONS.includes(emoji)) {
      socket.emit('chat error', 'Invalid reaction');
      return;
    }
    const sess = sessions.get(socket.sessionId);
    if (!sess) {
      socket.emit('chat error', 'Session not found');
      return;
    }
    const msg = findMessage(sess, messageId);
    if (!msg) {
      socket.emit('chat error', 'Message not found');
      return;
    }
    msg.reactions = msg.reactions || {};
    const users = msg.reactions[emoji] || [];
    const idx = users.indexOf(socket.username);
    if (idx >= 0) {
      users.splice(idx, 1);
      if (users.length === 0) delete msg.reactions[emoji];
      else msg.reactions[emoji] = users;
    } else {
      // one reaction per user per message? No — allow multiple emojis but toggle per emoji
      msg.reactions[emoji] = [...users, socket.username];
    }
    io.to(socket.sessionId).emit('message updated', msg);
  });

  socket.on('typing', () => {
    if (!socket.username || !socket.sessionId) return;
    socket.to(socket.sessionId).emit('user typing', { username: socket.username, sessionId: socket.sessionId });
  });
  socket.on('stop typing', () => {
    if (!socket.username || !socket.sessionId) return;
    socket.to(socket.sessionId).emit('user stop typing', { username: socket.username, sessionId: socket.sessionId });
  });

  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} ${socket.username || '(no username)'} session=${socket.sessionId || '-'} reason=${reason}`);
    if (!socket.username || !socket.sessionId) return;
    const sess = sessions.get(socket.sessionId);
    if (!sess) return;
    const username = socket.username;
    const lower = username.toLowerCase();
    const sessionId = socket.sessionId;
    const timeout = setTimeout(() => {
      sess.pendingLeaves.delete(lower);
      sess.usernames.delete(lower);
      sess.users.delete(socket.id);
      io.to(sessionId).emit('user left', {
        username,
        timestamp: new Date().toISOString(),
        count: sess.users.size,
        sessionId,
      });
      broadcastUsers(sessionId);
      console.log(`[leave] ${username} from ${sessionId} grace expired`);
      // cleanup empty non-general sessions after grace (keep history 10min)
      if (sess.users.size === 0 && sess.pendingLeaves.size === 0 && sessionId !== 'general') {
        if (sess.history.length === 0) {
          sessions.delete(sessionId);
          console.log(`[session] deleted empty ${sessionId}`);
        } else {
          // keep history for 10min then delete
          setTimeout(() => {
            const s = sessions.get(sessionId);
            if (s && s.users.size === 0 && s.pendingLeaves.size === 0) {
              sessions.delete(sessionId);
              console.log(`[session] expired ${sessionId} (history)`);
            }
          }, 10 * 60 * 1000);
        }
      }
    }, LEAVE_GRACE_MS);
    sess.pendingLeaves.set(lower, { timeout, username, oldSocketId: socket.id });
    console.log(`[grace] ${username} in ${sessionId} has ${LEAVE_GRACE_MS / 1000}s to reclaim`);
  });

  socket.on('error', (err) => console.error(`[socket error] ${socket.id}`, err));
});

// Error handling
app.use((err, req, res, next) => {
  console.error('[express error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✓ listening on *:${PORT} (v${APP_VERSION}, ${process.env.NODE_ENV || 'development'})`);
});

function shutdown(signal) {
  console.log(`\n[${signal}] shutting down gracefully...`);
  io.emit('server shutdown', 'Server is restarting');
  server.close(() => { console.log('HTTP server closed'); process.exit(0); });
  setTimeout(() => { console.error('Forced shutdown'); process.exit(1); }, 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server, io, sessions };
