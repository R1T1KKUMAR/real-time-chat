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
app.use(express.static(path.join(__dirname, 'public')));

// --- Session store (per-room) ---
const MAX_HISTORY = 100;
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

  socket.emit('joined', { username, sessionId, users: getUsersList(sess), history: sess.history });

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
  res.json({ status: 'ok', uptime: process.uptime(), sessions: sessions.size, totalUsers, ids: Array.from(sessions.keys()) });
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
    if (!isValidMessage(rawMsg)) {
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

    const message = rawMsg.trim();
    const payload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}-${socket.id.slice(0, 4)}`,
      username: socket.username,
      message,
      type: 'text',
      timestamp: new Date().toISOString(),
      sessionId: socket.sessionId,
    };
    pushHistory(sess, payload);
    io.to(socket.sessionId).emit('chat message', payload);
  });

  socket.on('chat image', (data) => {
    if (!socket.username || !socket.sessionId) {
      socket.emit('chat error', 'Join a session before sending images');
      return;
    }
    const image = data && typeof data.image === 'string' ? data.image : '';
    const caption = data && typeof data.caption === 'string' ? data.caption.trim().slice(0, 200) : '';
    if (!isValidImage(image)) {
      socket.emit('chat error', 'Invalid image — use PNG/JPEG/GIF/WEBP under ~1.5MB');
      return;
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
      message: caption,
      image,
      type: 'image',
      timestamp: new Date().toISOString(),
      sessionId: socket.sessionId,
    };
    pushHistory(sess, payload);
    io.to(socket.sessionId).emit('chat message', payload);
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
    }, 3500);
    sess.pendingLeaves.set(lower, { timeout, username, oldSocketId: socket.id });
    console.log(`[grace] ${username} in ${sessionId} has 3.5s to reclaim`);
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
  console.log(`✓ listening on *:${PORT} (${process.env.NODE_ENV || 'development'})`);
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
