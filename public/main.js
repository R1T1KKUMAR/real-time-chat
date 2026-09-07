const socket = io();

// Elements
const overlay = document.getElementById('overlay');
const usernameInput = document.getElementById('username-input');
const sessionInput = document.getElementById('session-input');
const createBtn = document.getElementById('create-session');
const joinBtn = document.getElementById('join-session');
const joinError = document.getElementById('join-error');
const sessionError = document.getElementById('session-error');
const form = document.getElementById('form');
const input = document.getElementById('input');
const messagesEl = document.getElementById('messages');
const chatScroll = document.getElementById('chat-scroll');
const chatEmpty = document.getElementById('chat-empty');
const typingIndicator = document.getElementById('typing-indicator');
const userListEl = document.getElementById('user-list');
const onlineCount = document.getElementById('online-count');
const msgCountEl = document.getElementById('msg-count');
const charCount = document.getElementById('char-count');
const formHint = document.getElementById('form-hint');
const connText = document.getElementById('conn-text');
const composerPrefix = document.getElementById('composer-prefix');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const headerSession = document.getElementById('header-session');
const sidebarSession = document.getElementById('sidebar-session');
const sidebarSessionId = document.getElementById('sidebar-session-id');
const sidebarShareRow = document.getElementById('sidebar-share-row');
const copyLinkBtn = document.getElementById('copy-link');
const topicEl = document.getElementById('topic');
const imageInput = document.getElementById('image-input');
const imagePreview = document.getElementById('image-preview');
const previewImg = document.getElementById('preview-img');
const previewName = document.getElementById('preview-name');
const clearImageBtn = document.getElementById('clear-image');
const replyPreview = document.getElementById('reply-preview');
const replyToUser = document.getElementById('reply-to-user');
const replyToSnippet = document.getElementById('reply-to-snippet');
const clearReplyBtn = document.getElementById('clear-reply');
const sidebarKeyRow = document.getElementById('sidebar-key-row');
const sidebarKeyfp = document.getElementById('sidebar-keyfp');
const lockedBanner = document.getElementById('locked-banner');
const voiceBtn = document.getElementById('voice-btn');
const recBar = document.getElementById('rec-bar');
const recTime = document.getElementById('rec-time');
const recWave = document.getElementById('rec-wave');
const recCancel = document.getElementById('rec-cancel');
const qrModal = document.getElementById('qr-modal');
const qrCanvas = document.getElementById('qr-canvas');
const qrRoom = document.getElementById('qr-room');
const qrLink = document.getElementById('qr-link');
const qrCopy = document.getElementById('qr-copy');
const qrClose = document.getElementById('qr-close');
const qrBtn = document.getElementById('qr-btn');
const soundBtn = document.getElementById('sound-btn');
const burnBtn = document.getElementById('burn-btn');
const pollBtn = document.getElementById('poll-btn');
const fileInput = document.getElementById('file-input');
const pollModal = document.getElementById('poll-modal');
const pollQ = document.getElementById('poll-q');
const pollOpts = document.getElementById('poll-opts');
const pollAddOpt = document.getElementById('poll-add-opt');
const pollSend = document.getElementById('poll-send');
const pollCancel = document.getElementById('poll-cancel');
const themeBtn = document.getElementById('theme-btn');
const shieldBtn = document.getElementById('shield-btn');
const privacyShield = document.getElementById('privacy-shield');
const privacyToast = document.getElementById('privacy-toast');
const watermarkEl = document.getElementById('watermark');
const installBtn = document.getElementById('install-btn');
const installHint = document.getElementById('install-hint');
const moreBtn = document.getElementById('more-btn');

let username = '';
let sessionId = '';
let joined = false;
let needsRejoin = false; // set on disconnect while in a room, cleared on successful rejoin
let messageCount = 0;
let typingTimeout = null;
let isTyping = false;
let pendingImage = null; // { dataUrl, name }
let pendingReply = null; // { id, username, snippet }
const typingUsers = new Set();
const ALLOWED_REACTIONS = ['❤️', '😂', '👍', '🎉', '😮', '😢'];

// --- E2EE state: AES-GCM room key. The key travels in the URL hash (#k=…)
// which browsers never send to the server — the server only sees ciphertext.
let roomKey = null;      // CryptoKey for the current room (null = no key)
let roomKeyB64 = '';     // base64url-encoded raw key
let roomLocked = false;  // true when the room has ciphertext but we lack the key
let pendingKeyB64 = '';  // key generated for a create-session in flight
let pendingKeySid = '';
const msgCache = new Map(); // id -> decrypted { message, image, audio, duration, seenBy }
const MSG_CACHE_MAX = 200;
const msgOrder = []; // chat bubble ids in display order (for seen up-to tracking)
let lastUsers = []; // latest room member list (for tick computation)
let lastSeenSent = '';
let lastSeenEmit = 0;
function cacheDecrypted(id, obj){
  if(!id) return;
  msgCache.set(id, obj);
  if(msgCache.size > MSG_CACHE_MAX){ const first = msgCache.keys().next().value; msgCache.delete(first); }
}

const STORAGE_USER = 'signal_username';
const STORAGE_SESSION = 'signal_session';

// Helpers
function initials(name) { return name.trim().slice(0, 2).toUpperCase(); }
function formatTime(iso) { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return '' } }
function fmtDur(s){ s=Math.max(0,Math.round(Number(s)||0)); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; }
// Short label for a message used in reply quotes / reply composer preview.
function snippetFor(d){
  if(!d) return '';
  if(d.audio || d.type==='voice') return `[voice ${fmtDur(d.voiceDuration ?? d.duration ?? 0)}]`;
  if(d.pollOptions || d.type==='poll') return (`[📊 ${d.pollQuestion||'Poll'}]`).slice(0,80);
  if(d.file || d.type==='file') return (`[📎 ${d.fileName||'file'}]`).slice(0,80);
  if(d.image || d.type==='image') return (d.message || '[image]').slice(0,120);
  return (d.message||'').slice(0,120);
}
// Per-user avatar gradients (self keeps the signature coral via CSS).
const AVATARS=[
  ['#2EC4B6','#177a72'], // teal
  ['#FFB020','#8f5c06'], // amber
  ['#8B7CF6','#463da0'], // violet
  ['#4FA3FF','#1c539e'], // blue
  ['#5FD97A','#20703a'], // green
  ['#F65D8A','#93304f'], // rose
];
function avatarGradient(name){
  let h=0; const s=String(name||'?');
  for(let i=0;i<s.length;i++){ h=((h*31)+s.charCodeAt(i))>>>0; }
  const c=AVATARS[h%AVATARS.length];
  return `linear-gradient(135deg, ${c[0]}, ${c[1]})`;
}
// Tiny WebAudio blips (no assets). Created lazily on first user gesture.
let soundOn=true;
try{ soundOn=localStorage.getItem('signal_sound')!=='off'; }catch{}
let actxSnd=null;
function blip(freq,dur,delay){
  if(!soundOn) return;
  try{
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC) return;
    actxSnd=actxSnd||new AC();
    if(actxSnd.state==='suspended') actxSnd.resume();
    const t=actxSnd.currentTime+(delay||0);
    const o=actxSnd.createOscillator(), g=actxSnd.createGain();
    o.type='sine'; o.frequency.value=freq;
    g.gain.setValueAtTime(0.0001,t);
    g.gain.exponentialRampToValueAtTime(0.06,t+0.012);
    g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
    o.connect(g); g.connect(actxSnd.destination);
    o.start(t); o.stop(t+dur+0.05);
  }catch{}
}
function sndSend(){ blip(660,0.07,0); }
function sndRecv(){ blip(520,0.08,0); blip(784,0.1,0.09); }
function refreshSoundBtn(){ if(soundBtn) soundBtn.textContent=soundOn?'🔊':'🔇'; }
function sanitize(text) { const div=document.createElement('div'); div.textContent=text; return div.innerHTML; }
function scrollToBottom(smooth=true){
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior = smooth && !prefersReduced ? 'smooth' : 'auto';
    try{
      chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior });
      if (Math.abs(chatScroll.scrollHeight - chatScroll.clientHeight - chatScroll.scrollTop) > 2 && behavior==='smooth') chatScroll.scrollTop = chatScroll.scrollHeight;
    }catch{ chatScroll.scrollTop = chatScroll.scrollHeight; }
  }));
}
function updateEmptyState(){ if(messageCount===0) chatEmpty.classList.remove('hidden'); else chatEmpty.classList.add('hidden'); }
function setConnection(state,text){
  const conn=document.querySelector('.conn');
  if(conn){ conn.classList.remove('conn--online','conn--offline'); if(state==='online') conn.classList.add('conn--online'); if(state==='offline') conn.classList.add('conn--offline'); }
  connText.textContent=text;
}
function saveSession(){
  try{ sessionStorage.setItem(STORAGE_USER, username); sessionStorage.setItem(STORAGE_SESSION, sessionId); }catch{}
}
function clearSession(){ try{ sessionStorage.removeItem(STORAGE_USER); sessionStorage.removeItem(STORAGE_SESSION); }catch{} }
function getStored(){ try{ return { user: sessionStorage.getItem(STORAGE_USER)||'', sess: sessionStorage.getItem(STORAGE_SESSION)||'' }; }catch{ return {user:'',sess:''} } }

// --- E2EE crypto (WebCrypto AES-GCM 256-bit). Requires a secure context
// (https / localhost) — crypto.subtle is undefined on plain http.
const _te = new TextEncoder(), _td = new TextDecoder();
function b64encodeBytes(bytes){ let s=''; const b=new Uint8Array(bytes); for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); return btoa(s); }
function b64decodeToBytes(b64){ const s=atob(b64); const b=new Uint8Array(s.length); for(let i=0;i<s.length;i++) b[i]=s.charCodeAt(i); return b; }
function b64urlEncode(bytes){ return b64encodeBytes(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function b64urlDecode(s){ s=String(s).replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4) s+='='; return b64decodeToBytes(s); }
async function importRoomKey(b64){
  const raw=b64urlDecode(b64);
  if(raw.length!==32) throw new Error('bad key length');
  return crypto.subtle.importKey('raw', raw, { name:'AES-GCM' }, true, ['encrypt','decrypt']);
}
async function genRoomKey(){
  const raw=crypto.getRandomValues(new Uint8Array(32));
  const key=await crypto.subtle.importKey('raw', raw, { name:'AES-GCM' }, true, ['encrypt','decrypt']);
  return { key, b64:b64urlEncode(raw) };
}
async function encryptJSON(key, obj){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, _te.encode(JSON.stringify(obj)));
  return { enc:1, iv:b64urlEncode(iv), data:b64encodeBytes(ct) };
}
async function decryptJSON(key, ivB64, dataB64){
  const pt=await crypto.subtle.decrypt({ name:'AES-GCM', iv:b64urlDecode(ivB64) }, key, b64decodeToBytes(dataB64));
  return JSON.parse(_td.decode(pt));
}
const KEYS_STORE='signal_room_keys';
function loadStoredKey(sid){ try{ const all=JSON.parse(localStorage.getItem(KEYS_STORE)||'{}'); return typeof all[sid]==='string'?all[sid]:''; }catch{ return '' } }
function storeKey(sid,k){ try{ const all=JSON.parse(localStorage.getItem(KEYS_STORE)||'{}'); all[sid]=k; localStorage.setItem(KEYS_STORE, JSON.stringify(all)); }catch{} }
function keyFromHash(){ try{ const m=location.hash.match(/#k=([A-Za-z0-9_-]{43})/); return m?m[1]:''; }catch{ return '' } }
// Emoji fingerprint of the room key — both sides compare to detect a middleman.
const FP_EMOJI=['🐬','🌙','⚡','🍀','🔥','🌊','⭐','🍁','🐝','🌸','🎯','🍉','🦊','🌈','🐢','💎'];
async function keyFingerprint(b64){
  const h=await crypto.subtle.digest('SHA-256', b64urlDecode(b64));
  const v=new Uint8Array(h); let s='';
  for(let i=0;i<4;i++) s+=FP_EMOJI[v[i]%16];
  return s;
}
// Resolve the key for a room: fresh create-key > URL hash > stored key.
// (pendingKeySid==='' means a create-session is in flight — sid unknown yet.)
async function setupRoomKey(sid){
  let kb64='';
  if(pendingKeyB64 && (pendingKeySid==='' || sid===pendingKeySid)){ kb64=pendingKeyB64; }
  else { kb64=keyFromHash() || loadStoredKey(sid); }
  pendingKeyB64=''; pendingKeySid='';
  roomKey=null; roomKeyB64='';
  if(kb64){
    try{
      roomKey=await importRoomKey(kb64);
      roomKeyB64=kb64;
      storeKey(sid,kb64);
    }catch{ roomKey=null; }
  }
  return !!roomKey;
}
function inviteLink(sid){
  const base=`${window.location.origin}${window.location.pathname}?session=${encodeURIComponent(sid)}`;
  return roomKeyB64 ? `${base}#k=${roomKeyB64}` : base;
}
function setSessionUI(sid){
  sessionId = sid;
  if(headerSession) headerSession.textContent = sid;
  if(sidebarSession) sidebarSession.textContent = `# ${sid}`;
  if(sidebarSessionId){ sidebarSessionId.textContent = sid; }
  if(sidebarShareRow) sidebarShareRow.style.display = sid ? 'flex' : 'none';
  if(copyLinkBtn) copyLinkBtn.style.display = sid ? 'inline-flex' : 'none';
  if(qrBtn) qrBtn.style.display = sid ? 'inline-flex' : 'none';
  if(topicEl) topicEl.textContent = sid === 'general' ? 'Low-latency relay for quick thoughts. Keep it kind.' : `Private room ${sid} — share the ID to invite others.`;
  // update URL without reload
  try{
    const url = new URL(window.location.href);
    if(sid && sid!=='general'){ url.searchParams.set('session', sid); } else { url.searchParams.delete('session'); }
    history.replaceState(null,'',url.toString());
  }catch{}
}

// Sidebar toggle
sidebarToggle.addEventListener('click', ()=>sidebar.classList.toggle('open'));
chatScroll.addEventListener('click', ()=>sidebar.classList.remove('open'));

// Char count + typing (with heartbeat so the other side never sticks on "X is typing")
let typingHeartbeat = null;
function emitTyping(){
  if(!joined) return;
  if(!isTyping){ isTyping=true; if(socket.connected) socket.emit('typing'); }
  clearTimeout(typingTimeout);
  typingTimeout=setTimeout(stopTyping,900);
  // re-announce every 3s while the user keeps typing; receiver expires entries
  // after 6s without refresh, so a lost 'stop typing' (disconnect) self-heals
  if(!typingHeartbeat){ typingHeartbeat=setInterval(()=>{ if(isTyping && socket.connected) socket.emit('typing'); },3000); }
}
function stopTyping(){
  if(isTyping){ isTyping=false; if(socket.connected){ try{ socket.emit('stop typing'); }catch{} } }
  clearTimeout(typingTimeout);
  if(typingHeartbeat){ clearInterval(typingHeartbeat); typingHeartbeat=null; }
}
input.addEventListener('input', ()=>{
  charCount.textContent = `${input.value.length} / 500`;
  charCount.style.color = input.value.length>450 ? '#FF5A3C' : '';
  if(!joined) return;
  if(input.value.trim().length>0){
    emitTyping();
  } else {
    stopTyping();
  }
});

// Validation
function validateUsername(val){
  if(!val) return 'Enter a username to continue';
  if(val.length<2||val.length>20) return 'Username must be 2–20 characters';
  if(!/^[a-zA-Z0-9 _\-.]{2,20}$/.test(val)) return 'Only letters, numbers, space, _ - . allowed';
  return '';
}
function validateSessionId(val){
  if(!val) return 'Enter a session ID';
  const t=val.trim().toUpperCase();
  if(t.length<3||t.length>20) return 'Session ID must be 3–20 chars';
  if(!/^[A-Z0-9_-]{3,20}$/.test(t)) return 'Only A-Z, 0-9, _ - allowed';
  return '';
}
function showJoinError(msg){ joinError.textContent=msg||''; usernameInput.style.borderColor=msg?'#EF4444':''; }
function showSessionError(msg){ sessionError.textContent=msg||''; sessionInput.style.borderColor=msg?'#EF4444':''; if(!msg) sessionError.style.color=''; }

// Prefill from URL ?session=ID
(function(){
  try{
    const params=new URLSearchParams(window.location.search);
    const sid=params.get('session');
    if(sid && sessionInput){ sessionInput.value=sid.toUpperCase(); }
  }catch{}
  const stored=getStored();
  if(stored.user) usernameInput.value=stored.user;
  if(stored.sess && !sessionInput.value) sessionInput.value=stored.sess;
})();

async function attemptCreate(){
  const u=usernameInput.value.trim();
  const uErr=validateUsername(u);
  if(uErr){ showJoinError(uErr); usernameInput.focus(); return; }
  if(!window.crypto || !crypto.subtle){ showJoinError('Encryption needs https or localhost — use the https link'); return; }
  showJoinError(''); showSessionError('');
  try{
    const g=await genRoomKey();
    pendingKeyB64=g.b64; pendingKeySid=''; // sid assigned by server; setupRoomKey picks this up
  }catch{ showJoinError('Could not generate encryption key — try again'); return; }
  socket.emit('create session', { username: u });
  createBtn.textContent='Creating…'; createBtn.disabled=true;
  setTimeout(()=>{ createBtn.textContent='Create new session →'; createBtn.disabled=false; },1500);
}
function attemptJoin(){
  const u=usernameInput.value.trim();
  const sid=sessionInput.value.trim().toUpperCase();
  const uErr=validateUsername(u);
  const sErr=validateSessionId(sid);
  if(uErr){ showJoinError(uErr); usernameInput.focus(); return; }
  if(sErr){ showSessionError(sErr); sessionInput.focus(); return; }
  showJoinError(''); showSessionError('');
  socket.emit('join session', { username: u, sessionId: sid });
  joinBtn.textContent='Joining…'; joinBtn.disabled=true;
  setTimeout(()=>{ joinBtn.textContent='Join →'; joinBtn.disabled=false; },1500);
}

createBtn.addEventListener('click', attemptCreate);
joinBtn.addEventListener('click', attemptJoin);
usernameInput.addEventListener('input', ()=>showJoinError(''));
sessionInput.addEventListener('input', ()=>showSessionError(''));
sessionInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); attemptJoin(); }});
usernameInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); // decide: if session id filled -> join else create
  if(sessionInput.value.trim()) attemptJoin(); else attemptCreate();
}});

// copy invite link (includes the #k= room key so the receiver can decrypt)
if(copyLinkBtn){
  copyLinkBtn.addEventListener('click', async ()=>{
    const sid=sessionId||'';
    const link = inviteLink(sid);
    try{
      await navigator.clipboard.writeText(link);
      const prev=copyLinkBtn.textContent; copyLinkBtn.textContent='✓ Copied'; setTimeout(()=>copyLinkBtn.textContent=prev,1500);
    }catch{
      prompt('Copy this link:', link);
    }
  });
}

// QR invite modal (local encoder — the link + key never leaves the browser)
function drawQR(canvas, m){
  const quiet=2;
  const target=232;
  const scale=Math.max(1,Math.floor(target/(m.size+quiet*2)));
  const px=(m.size+quiet*2)*scale;
  canvas.width=px; canvas.height=px;
  const cx=canvas.getContext('2d');
  cx.fillStyle='#E7ECF2';
  cx.beginPath();
  if(cx.roundRect) cx.roundRect(0,0,px,px,14); else cx.rect(0,0,px,px);
  cx.fill();
  cx.fillStyle='#0B0F16';
  for(let y=0;y<m.size;y++)for(let x=0;x<m.size;x++){
    if(m.at(x,y)) cx.fillRect((x+quiet)*scale,(y+quiet)*scale,scale,scale);
  }
}
function openQR(){
  if(!sessionId || !qrModal) return;
  const link=inviteLink(sessionId);
  if(qrRoom) qrRoom.textContent='# '+sessionId;
  if(qrLink) qrLink.textContent=link;
  let ok=false;
  try{
    if(typeof makeQR==='function'){
      const m=makeQR(link);
      if(m){ drawQR(qrCanvas,m); qrCanvas.style.display='block'; ok=true; }
    }
  }catch{}
  if(!ok && qrCanvas) qrCanvas.style.display='none';
  qrModal.style.display='flex';
}
function closeQR(){ if(qrModal) qrModal.style.display='none'; }
if(qrBtn) qrBtn.addEventListener('click', openQR);
if(qrClose) qrClose.addEventListener('click', closeQR);
if(qrModal) qrModal.addEventListener('click', (e)=>{ if(e.target===qrModal) closeQR(); });
if(qrCopy) qrCopy.addEventListener('click', async ()=>{
  try{
    await navigator.clipboard.writeText(inviteLink(sessionId));
    const prev=qrCopy.textContent; qrCopy.textContent='✓ Copied'; setTimeout(()=>qrCopy.textContent=prev,1500);
  }catch{ prompt('Copy this link:', inviteLink(sessionId)); }
});
if(soundBtn){
  refreshSoundBtn();
  soundBtn.addEventListener('click', ()=>{
    soundOn=!soundOn;
    try{ localStorage.setItem('signal_sound', soundOn?'on':'off'); }catch{}
    refreshSoundBtn();
    if(soundOn) sndSend();
  });
}

// Focus shortcuts
document.addEventListener('keydown', (e)=>{
  if(e.key==='/' && !joined) return;
  if(e.key==='/' && document.activeElement!==input){ e.preventDefault(); if(joined) input.focus(); }
  if(e.key==='Escape'){
    if(qrModal && qrModal.style.display!=='none'){ closeQR(); return; }
    if(pollModal && pollModal.style.display!=='none'){ closePoll(); return; }
    if(form && form.classList.contains('open-more')){ closeMore(); return; }
    if(recState){ stopRecording(false); return; }
    if(pendingReply){ clearPendingReply(); return; }
    if(pendingImage){ clearPendingImage(); return; }
    if(pendingFile){ clearPendingFile(); return; }
    input.value=''; charCount.textContent='0 / 500'; stopTyping(); typingIndicator.textContent='';
  }
});
document.addEventListener('click', ()=>{
  document.querySelectorAll('.reaction-picker').forEach(p=>p.style.display='none');
});
if(clearReplyBtn) clearReplyBtn.addEventListener('click', clearPendingReply);

// Rendering
function renderReactions(container, reactions, messageId){
  container.innerHTML='';
  if(!reactions) return;
  const entries=Object.entries(reactions).filter(([,users])=>Array.isArray(users)&&users.length>0);
  if(entries.length===0) return;
  entries.forEach(([emoji, users])=>{
    const btn=document.createElement('button');
    btn.type='button';
    btn.className='reaction-pill'+(users.includes(username)?' reaction-pill--mine':'');
    btn.title=users.join(', ');
    const eSpan=document.createElement('span');
    eSpan.textContent=emoji;
    const cSpan=document.createElement('span');
    cSpan.className='reaction-pill__count';
    cSpan.textContent=users.length;
    btn.appendChild(eSpan); btn.appendChild(cSpan);
    btn.addEventListener('click', (ev)=>{ ev.stopPropagation(); socket.emit('toggle reaction', { messageId, emoji }); });
    container.appendChild(btn);
  });
}
// --- Read receipts ---
// Tracks rendered bubble order; tells the server the newest bubble on screen
// (throttled). Ticks on own messages: ✓ sent, ✓✓ gray seen by some,
// ✓✓ teal seen by every other current member.
function noteSeen(data){
  if(!data || !data.id) return;
  if(!msgOrder.includes(data.id)) msgOrder.push(data.id);
  const c=msgCache.get(data.id);
  const seen=Array.isArray(data.seenBy)?[...data.seenBy]:[];
  if(c) c.seenBy=seen;
  else msgCache.set(data.id, { message:'', seenBy:seen });
  updateTicksFor(data.id);
  maybeEmitSeen();
  // disappearing message: shred locally N seconds after first render (read)
  if(data.burnAfter===10 || data.burnAfter===60 || data.burnAfter===3600){
    setTimeout(()=>shredMessage(data.id), data.burnAfter*1000);
  }
}
function shredMessage(id){
  if(!id) return;
  const safe=String(id).replace(/"/g,'\\"');
  const li=messagesEl.querySelector(`[data-id="${safe}"]`);
  if(li){ li.classList.add('message--burn'); setTimeout(()=>li.remove(), 350); }
  msgCache.delete(id);
  const ix=msgOrder.indexOf(id);
  if(ix>=0) msgOrder.splice(ix,1);
}
function updateTicksFor(id){
  const safe=String(id).replace(/"/g,'\\"');
  const li=messagesEl.querySelector(`[data-id="${safe}"]`);
  if(!li || !li.classList.contains('message--self')) return;
  const tick=li.querySelector('.ticks');
  if(!tick) return;
  const seenBy=((msgCache.get(id)||{}).seenBy)||[];
  const others=(lastUsers||[]).filter(u=>u!==username);
  if(others.length===0){ tick.textContent='✓'; tick.classList.remove('ticks--seen'); return; }
  const all=others.every(u=>seenBy.includes(u));
  tick.textContent = seenBy.length ? '✓✓' : '✓';
  tick.classList.toggle('ticks--seen', all);
}
function maybeEmitSeen(){
  if(!joined || roomLocked || document.hidden || !msgOrder.length) return;
  const last=msgOrder[msgOrder.length-1];
  if(last===lastSeenSent) return;
  const now=Date.now();
  if(now-lastSeenEmit<1500) return;
  lastSeenEmit=now; lastSeenSent=last;
  socket.emit('message seen', { messageId:last });
}
function fmtSize(b){ b=Math.max(0,Math.round(Number(b)||0)); if(b<1024) return `${b} B`; if(b<1048576) return `${(b/1024).toFixed(1)} KB`; return `${(b/1048576).toFixed(1)} MB`; }
function burnShort(s){ return s===10?'10s':s===60?'1m':s===3600?'1h':''; }
function paintPoll(li, data){
  const box=li.querySelector('.poll');
  if(!box || !Array.isArray(data.pollOptions)) return;
  box.querySelector('.poll__q').textContent=data.pollQuestion||'Poll';
  const opts=box.querySelector('.poll__opts');
  opts.innerHTML='';
  const votes=(data.poll && data.poll.votes)||{};
  let total=0;
  const counts=data.pollOptions.map((_,i)=>{ const arr=votes[String(i)]; const n=Array.isArray(arr)?arr.length:0; total+=n; return n; });
  data.pollOptions.forEach((opt,i)=>{
    const mine=Array.isArray(votes[String(i)]) && votes[String(i)].includes(username);
    const pct=total>0?Math.round(counts[i]/total*100):0;
    const b=document.createElement('button');
    b.type='button';
    b.className='poll__opt'+(mine?' poll__opt--mine':'');
    b.innerHTML=`<span class="poll__bar" style="width:${pct}%"></span><span class="poll__label"></span><span class="poll__count"></span>`;
    b.querySelector('.poll__label').textContent=opt;
    b.querySelector('.poll__count').textContent=counts[i]?`${counts[i]} · ${pct}%`:'';
    b.title=Array.isArray(votes[String(i)])?votes[String(i)].join(', '):'No votes yet';
    b.addEventListener('click', (ev)=>{ ev.stopPropagation(); socket.emit('vote', { messageId:data.id, option:i }); });
    opts.appendChild(b);
  });
  box.querySelector('.poll__total').textContent=`${total} vote${total!==1?'s':''}`;
}
function wireFile(li, data){
  const chip=li.querySelector('.file-chip');
  if(!chip) return;
  chip.querySelector('.file-chip__name').textContent=data.fileName||'file';
  chip.querySelector('.file-chip__size').textContent=fmtSize(data.fileSize||0);
  const a=chip.querySelector('.file-chip__dl');
  a.href=data.file;
  a.download=data.fileName||'file';
}
function wireVoicePlayer(li, data){
  const wrap=li.querySelector('.voice-player');
  const audio=wrap.querySelector('audio');
  const playBtn=wrap.querySelector('.voice-player__play');
  const wave=wrap.querySelector('.voice-player__wave');
  const timeEl=wrap.querySelector('.voice-player__time');
  const speedBtn=wrap.querySelector('.voice-player__speed');
  const dur=data.voiceDuration||0;
  audio.src=data.audio;
  const peaks=(Array.isArray(data.voicePeaks) && data.voicePeaks.length ? data.voicePeaks : new Array(40).fill(0.35));
  const bars=peaks.map(()=>{ const s=document.createElement('i'); wave.appendChild(s); return s; });
  peaks.forEach((v,i)=>{ bars[i].style.height=`${Math.max(12,Math.round(v*100))}%`; });
  const paint=()=>{
    const total=(isFinite(audio.duration) && audio.duration>0) ? audio.duration : dur;
    const p=total>0 ? (audio.currentTime/total) : 0;
    const cut=Math.floor(p*bars.length);
    bars.forEach((b,i)=>b.classList.toggle('on', i<cut));
    timeEl.textContent=`${fmtDur(audio.currentTime||0)} / ${fmtDur(total)}`;
  };
  timeEl.textContent=`0:00 / ${fmtDur(dur)}`;
  playBtn.addEventListener('click', (ev)=>{
    ev.stopPropagation();
    if(audio.paused){
      document.querySelectorAll('.voice-player audio').forEach(a=>{ if(a!==audio) a.pause(); });
      audio.play().catch(()=>{});
    } else audio.pause();
  });
  audio.addEventListener('play', ()=>{ playBtn.textContent='⏸'; });
  audio.addEventListener('pause', ()=>{ playBtn.textContent='▶'; paint(); });
  audio.addEventListener('timeupdate', paint);
  audio.addEventListener('loadedmetadata', paint);
  audio.addEventListener('ended', ()=>{ playBtn.textContent='▶'; });
  const SPEEDS=[1,1.5,2]; let si=0;
  speedBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); si=(si+1)%SPEEDS.length; audio.playbackRate=SPEEDS[si]; speedBtn.textContent=`${SPEEDS[si]}×`; });
  wave.addEventListener('click', (ev)=>{
    ev.stopPropagation();
    const r=wave.getBoundingClientRect();
    const p=Math.max(0, Math.min(1, (ev.clientX-r.left)/Math.max(1,r.width)));
    if(isFinite(audio.duration) && audio.duration>0) audio.currentTime=p*audio.duration;
  });
}
function addChatMessage(data,isSelf){
  if(data.id){ const safe=data.id.replace(/"/g,'\\"'); if(messagesEl.querySelector(`[data-id="${safe}"]`)) return; }
  messageCount++; msgCountEl.textContent=`${messageCount} message${messageCount!==1?'s':''}`; updateEmptyState();
  const li=document.createElement('li');
  li.className=`message ${isSelf?'message--self':''}`;
  if(data.id) li.dataset.id=data.id;
  const time=formatTime(data.timestamp);
  const isImage = data.type==='image' && typeof data.image==='string' && data.image.startsWith('data:image/');
  const isVoice = data.type==='voice' && typeof data.audio==='string' && data.audio.startsWith('data:audio/');
  const isPoll = data.type==='poll' && Array.isArray(data.pollOptions) && data.pollOptions.length>=2;
  const isFile = data.type==='file' && typeof data.file==='string' && data.file.startsWith('data:');
  const hasReply = data.replyTo && typeof data.replyTo.id==='string';
  li.innerHTML=`
    <div class="message__bar"></div>
    <div class="message__head">
      <div class="message__avatar"${isSelf?'':` style="background:${avatarGradient(data.username)}"`}>${sanitize(initials(data.username))}</div>
      <div class="message__meta">
        <span class="message__author"></span>
        <span class="message__time"></span>
        <span class="ticks" title="Seen"></span>
        ${data.burnAfter?`<span class="burn" title="Disappearing message">🔥${burnShort(data.burnAfter)}</span>`:``}
      </div>
      <div class="message__actions">
        <button class="mini-btn" data-act="react" title="React">☺</button>
        <button class="mini-btn" data-act="reply" title="Reply">↩</button>
      </div>
    </div>
    ${hasReply ? `<div class="message__reply"><span class="message__reply-user"></span><span class="message__reply-text"></span></div>` : ``}
    ${isImage ? `<img class="message__image" alt="shared image" loading="lazy" />` : isVoice ? `<div class="voice-player"><button type="button" class="voice-player__play" aria-label="Play voice note">▶</button><div class="voice-player__wave"></div><span class="voice-player__time"></span><button type="button" class="voice-player__speed" title="Playback speed">1×</button><audio preload="metadata"></audio></div>` : isPoll ? `<div class="poll"><div class="poll__q"></div><div class="poll__opts"></div><div class="poll__total"></div></div>` : isFile ? `<div class="file-chip"><span class="file-chip__icon">📄</span><div class="file-chip__meta"><span class="file-chip__name"></span><span class="file-chip__size"></span></div><a class="file-chip__dl" title="Download">⬇</a></div>` : `<div class="message__body"></div>`}
    ${(isImage||isVoice||isFile) && data.message ? `<div class="message__image-caption"></div>` : ``}
    <div class="message__reactions"></div>
    <div class="reaction-picker" style="display:none"></div>
  `;
  li.querySelector('.message__author').textContent=data.username;
  li.querySelector('.message__time').textContent=time;
  if(hasReply){
    li.querySelector('.message__reply-user').textContent='@'+data.replyTo.username;
    // Encrypted rooms: server can't read the target, so fill the snippet
    // from our own decrypted copy.
    let snip=data.replyTo.snippet||'';
    if(!snip && data.replyTo.id && msgCache.has(data.replyTo.id)){
      snip=snippetFor(msgCache.get(data.replyTo.id));
    }
    li.querySelector('.message__reply-text').textContent=snip;
    li.querySelector('.message__reply').addEventListener('click', ()=>{
      const target=messagesEl.querySelector(`[data-id="${data.replyTo.id.replace(/"/g,'\\"')}"]`);
      if(target){ target.scrollIntoView({behavior:'smooth', block:'center'}); target.classList.add('message--flash'); setTimeout(()=>target.classList.remove('message--flash'),1200); }
    });
  }
  if(isImage){
    const img=li.querySelector('.message__image');
    img.src=data.image;
    img.addEventListener('click', ()=> window.open(data.image, '_blank'));
    if(data.message){
      li.querySelector('.message__image-caption').textContent=data.message;
    }
  } else if(isVoice){
    wireVoicePlayer(li, data);
    if(data.message){
      li.querySelector('.message__image-caption').textContent=data.message;
    }
  } else if(isPoll){
    paintPoll(li, data);
  } else if(isFile){
    wireFile(li, data);
    if(data.message){
      li.querySelector('.message__image-caption').textContent=data.message;
    }
  } else {
    li.querySelector('.message__body').textContent=data.message||'';
  }
  // reactions
  const reactBox=li.querySelector('.message__reactions');
  renderReactions(reactBox, data.reactions, data.id);
  // picker
  const picker=li.querySelector('.reaction-picker');
  ALLOWED_REACTIONS.forEach(em=>{
    const b=document.createElement('button');
    b.type='button'; b.className='reaction-option'; b.textContent=em;
    b.addEventListener('click', (ev)=>{ ev.stopPropagation(); socket.emit('toggle reaction', { messageId: data.id, emoji: em }); picker.style.display='none'; });
    picker.appendChild(b);
  });
  const reactBtn=li.querySelector('[data-act="react"]');
  const replyBtn=li.querySelector('[data-act="reply"]');
  reactBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); picker.style.display=picker.style.display==='none'?'flex':'none'; });
  replyBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); setPendingReply({ id: data.id, username: data.username, snippet: snippetFor(data) }); });
  messagesEl.appendChild(li);
  noteSeen(data);
  scrollToBottom();
}
function updateMessageInPlace(data){
  if(!data || !data.id) return;
  if(data.sessionId && sessionId && data.sessionId!==sessionId) return;
  const safe=data.id.replace(/"/g,'\\"');
  const li=messagesEl.querySelector(`[data-id="${safe}"]`);
  if(!li) {
    // if missed (e.g. history gap), append as new
    addChatMessage(data, data.username===username);
    return;
  }
  const box=li.querySelector('.message__reactions');
  if(box) renderReactions(box, data.reactions, data.id);
  // live poll results ride the same event
  if(li.querySelector('.poll') && data.poll){
    const c=msgCache.get(data.id)||{};
    paintPoll(li, { pollQuestion:c.pollQuestion||'Poll', pollOptions:c.pollOptions||[], poll:data.poll });
  }
}
function setPendingReply(ref){
  pendingReply=ref||null;
  if(!ref){
    if(replyPreview) replyPreview.style.display='none';
    return;
  }
  if(replyToUser) replyToUser.textContent=ref.username;
  if(replyToSnippet) replyToSnippet.textContent=ref.snippet||'';
  if(replyPreview) replyPreview.style.display='flex';
  input.focus();
}
function clearPendingReply(){ setPendingReply(null); }
function addSystemMessage(text,variant=''){
  messageCount++; msgCountEl.textContent=`${messageCount} message${messageCount!==1?'s':''}`; updateEmptyState();
  const li=document.createElement('li');
  li.className='message--system';
  li.innerHTML=`<span class="system-pill ${variant}"><i></i><span></span></span>`;
  li.querySelector('.system-pill span').textContent=text;
  messagesEl.appendChild(li);
  scrollToBottom();
}
function renderUserList(users){
  lastUsers=Array.isArray(users)?[...users]:[];
  onlineCount.textContent=users.length;
  if(users.length===0){ userListEl.innerHTML=`<li class="user-list__empty">No one else here yet.<br>Share the session ID to invite.</li>`; return; }
  userListEl.innerHTML='';
  users.forEach(u=>{
    const li=document.createElement('li');
    const self=u===username;
    li.className=`user-chip ${self?'user-chip--self':''}`;
    li.innerHTML=`<span class="user-chip__avatar"${self?'':` style="background:${avatarGradient(u)}"`}>${sanitize(initials(u))}</span><span class="user-chip__name"></span><span class="user-chip__status"></span>`;
    li.querySelector('.user-chip__name').textContent=u + (self?'  (you)':'');
    userListEl.appendChild(li);
  });
  // membership changed -> recompute own ticks (teal needs "all current members")
  document.querySelectorAll('.message--self').forEach(li=>{ if(li.dataset.id) updateTicksFor(li.dataset.id); });
}
// Typing entries expire if the other side vanishes without 'stop typing'
// (disconnect, killed tab). Refreshed by the 3s sender heartbeat.
const typingExpiry = new Map();
const TYPING_EXPIRE_MS = 6000;
function touchTypingUser(name){
  typingUsers.add(name);
  if(typingExpiry.has(name)) clearTimeout(typingExpiry.get(name));
  typingExpiry.set(name, setTimeout(()=>{ typingUsers.delete(name); typingExpiry.delete(name); renderTyping(); }, TYPING_EXPIRE_MS));
  renderTyping();
}
function clearTypingUser(name){
  typingUsers.delete(name);
  if(typingExpiry.has(name)){ clearTimeout(typingExpiry.get(name)); typingExpiry.delete(name); }
  renderTyping();
}
function renderTyping(){
  if(typingUsers.size===0){ typingIndicator.innerHTML=''; return; }
  const names=Array.from(typingUsers).slice(0,3);
  let text=''; if(names.length===1) text=`${names[0]} is typing`; else if(names.length===2) text=`${names[0]} and ${names[1]} are typing`; else text=`${names[0]} and ${names.length-1} others are typing`;
  typingIndicator.innerHTML=`${sanitize(text)}<span class="typing__dots"><i></i><i></i><i></i></span>`;
}

// Auto-rejoin on connect if stored — URL ?session= takes priority over stored
function tryAutoRejoin(){
  const {user, sess:storedSess}=getStored();
  let urlSess='';
  try{ urlSess=new URLSearchParams(window.location.search).get('session')?.trim().toUpperCase()||''; }catch{}
  const targetSess = urlSess || storedSess;
  if(user && targetSess && (!joined || needsRejoin)){
    usernameInput.value=user; sessionInput.value=targetSess;
    showJoinError(''); showSessionError('');
    socket.emit('join session', { username:user, sessionId:targetSess });
    if (!joined) { sessionError.textContent=`Reconnecting to ${targetSess} as ${user}…`; sessionError.style.color='#8A9BB0'; }
  } else if(user && !joined && sessionInput.value.trim()){
    showJoinError(''); socket.emit('join session', { username:user, sessionId:sessionInput.value.trim().toUpperCase() });
  }
}

// Socket events
socket.on('connect', ()=>{
  setConnection('online', `Connected • ${socket.id.slice(0,4)}`);
  const stored = getStored();
  // Fresh load auto-join, OR re-join after a transient disconnect.
  // Previously we only rejoined when !joined, so a network blip left the
  // server-side entry to expire -> false "X left" for everyone else,
  // while this client still thought it was joined.
  if (stored.user && stored.sess && (!joined || needsRejoin)) setTimeout(tryAutoRejoin,80);
});
socket.on('disconnect', (reason)=>{
  setConnection('offline','Disconnected — reconnecting…');
  stopTyping();
  if (joined){
    needsRejoin = true;
    // Make the outage visible so the user knows MESSAGES AREN'T FLOWING
    // (previously the app looked fine while the socket was dead).
    formHint.textContent=`Connection lost (${reason||'unknown'}) — reconnecting…`;
  }
});
socket.on('connect_error', ()=>setConnection('offline','Connection failed — retrying…'));
// Phone screen-lock / background tab kills the socket; when the user comes
// back, reconnect immediately instead of waiting for socket.io backoff.
document.addEventListener('visibilitychange', ()=>{
  if(document.hidden || !joined) return;
  if(!socket.connected){ try{ socket.connect(); }catch{} }
  else if(needsRejoin){ tryAutoRejoin(); }
  else maybeEmitSeen();
});
window.addEventListener('focus', ()=>{ maybeEmitSeen(); });

socket.on('username error', (msg)=>{ showJoinError(msg); const s=getStored(); if(s.user && msg.includes('already taken')){ /* keep session, let user pick new name */ }});
socket.on('session error', (msg)=>{ showSessionError(msg); sessionError.style.color='#F87171'; });
socket.on('session created', ({sessionId:sid})=>{
  setSessionUI(sid);
  // plant the room key in the URL hash (never sent to the server) so the
  // invite link carries it
  if(roomKeyB64){ try{ location.hash=`k=${roomKeyB64}`; }catch{} }
});
socket.on('chat error', (msg)=>{ formHint.textContent=msg; setTimeout(()=>formHint.textContent='',3000); });

// Decrypt-then-render for incoming messages. Plaintext (legacy) renders as-is;
// envelopes need the room key, else a lock placeholder.
async function renderIncoming(data, isSelf){
  if(data.sessionId && sessionId && data.sessionId!==sessionId) return;
  if(!data.enc){
    if(data.id) cacheDecrypted(data.id, { message:data.message||'', image:data.image||'', audio:!!data.audio, duration:data.voiceDuration||0 });
    addChatMessage(data,isSelf);
    return;
  }
  if(!roomKey){
    // Someone uses encryption here and we lack the key — lock the room so we
    // never leak plaintext into it.
    if(!roomLocked) setLocked(true);
    addLockedBubble(data,isSelf,false);
    return;
  }
  try{
    const inner=await decryptJSON(roomKey, data.iv, data.data);
    const merged={ ...data,
      message: typeof inner.message==='string' ? inner.message : '',
      ...(typeof inner.image==='string' ? { image: inner.image } : {}),
      ...(typeof inner.audio==='string' ? { audio: inner.audio,
        voiceDuration: Math.max(0, Math.min(600, Number(inner.duration)||0)),
        voicePeaks: Array.isArray(inner.peaks) ? inner.peaks.slice(0,64).map(v=>Math.max(0,Math.min(1,Number(v)||0))) : [] } : {}),
      ...(Array.isArray(inner.options) ? { pollQuestion: String(inner.question||'Poll').slice(0,200),
        pollOptions: inner.options.slice(0,5).map(o=>String(o||'').slice(0,100)) } : {}),
      ...(typeof inner.file==='string' ? { file: inner.file,
        fileName: String(inner.name||'file').slice(0,120),
        fileSize: Math.max(0, Math.min(50*1024*1024, Number(inner.size)||0)),
        fileMime: String(inner.mime||'').slice(0,100) } : {}),
    };
    cacheDecrypted(data.id, { message:merged.message, image:merged.image||'', audio:!!merged.audio, duration:merged.voiceDuration||0,
      pollQuestion:merged.pollQuestion||'', pollOptions:merged.pollOptions||[], fileName:merged.fileName||'' });
    addChatMessage(merged,isSelf);
  }catch{
    addLockedBubble(data,isSelf,true);
  }
}
function addLockedBubble(data,isSelf,wrongKey){
  if(data.id){ const safe=String(data.id).replace(/"/g,'\\"'); if(messagesEl.querySelector(`[data-id="${safe}"]`)) return; }
  messageCount++; msgCountEl.textContent=`${messageCount} message${messageCount!==1?'s':''}`; updateEmptyState();
  const li=document.createElement('li');
  li.className=`message ${isSelf?'message--self':''}`;
  if(data.id) li.dataset.id=data.id;
  li.innerHTML=`
    <div class="message__bar"></div>
    <div class="message__head">
      <div class="message__avatar">🔒</div>
      <div class="message__meta">
        <span class="message__author"></span>
        <span class="message__time"></span>
      </div>
    </div>
    <div class="message__body"></div>
  `;
  li.querySelector('.message__author').textContent=data.username;
  li.querySelector('.message__time').textContent=formatTime(data.timestamp);
  li.querySelector('.message__body').textContent= wrongKey
    ? '🔒 Could not decrypt — wrong room key?'
    : '🔒 Encrypted message — open the full invite link';
  messagesEl.appendChild(li);
  noteSeen(data);
  scrollToBottom();
}
function setLocked(on){
  roomLocked=on;
  if(lockedBanner) lockedBanner.style.display=on?'flex':'none';
  input.disabled=on;
  if(on) input.placeholder='🔒 Locked — open the full invite link to read & send';
}

socket.on('joined', async (data)=>{
  username=data.username;
  setSessionUI(data.sessionId);
  joined=true;
  needsRejoin=false;
  // fresh receipt state for this room view
  msgOrder.length=0; msgCache.clear(); lastSeenSent=''; lastSeenEmit=0;
  saveSession();
  overlay.classList.add('hidden');
  composerPrefix.textContent=`@${username}`;
  input.placeholder=`Message in ${data.sessionId} as ${username}…`;
  input.focus();
  renderUserList(data.users);
  formHint.textContent='';
  // resolve room key: fresh create-key > URL hash > stored key
  await setupRoomKey(data.sessionId);
  const locked=!!data.hasEncrypted && !roomKey;
  if(roomKey && sidebarKeyfp){
    try{
      const fp=await keyFingerprint(roomKeyB64);
      sidebarKeyfp.textContent=fp;
      sidebarKeyfp.title=`Room key fingerprint ${fp} — compare with your partner; must match`;
      if(sidebarKeyRow) sidebarKeyRow.style.display='flex';
    }catch{}
  } else if(sidebarKeyRow){ sidebarKeyRow.style.display='none'; }
  if(Array.isArray(data.history) && data.history.length>0){
    for(const m of data.history){ await renderIncoming(m, m.username===username); }
  }
  setLocked(locked);
  if(locked) addSystemMessage('🔒 This room is encrypted — ask the sender for the full invite link (it carries the key)', '');
  // Silent reclaim after a network blip — don't spam another "You joined" pill.
  if (data.reclaimed) return;
  setTimeout(()=>{
    const last=messagesEl.lastElementChild;
    const lastText=last?.textContent||'';
    if(!lastText.includes(`You joined as ${username}`)){
      addSystemMessage(`You joined ${data.sessionId} as ${username}`, 'system-pill--join');
    }
  },15);
  // reset session error color
  sessionError.style.color='';
});

socket.on('chat message', (data)=>{
  // room already filtered server-side, but double-check sessionId match if present
  if(data.sessionId && sessionId && data.sessionId!==sessionId) return;
  const isSelf=data.username===username;
  renderIncoming(data,isSelf);
  if(!isSelf){ sndRecv(); clearTypingUser(data.username); }
});
socket.on('message updated', (data)=>{
  updateMessageInPlace(data);
});
socket.on('message burned', (data)=>{
  if(!data || !data.id) return;
  if(data.sessionId && sessionId && data.sessionId!==sessionId) return;
  shredMessage(data.id);
});
socket.on('messages seen', (data)=>{
  if(!data || data.sessionId!==sessionId) return;
  const idx=msgOrder.indexOf(data.upToId);
  if(idx<0) return;
  for(let i=0;i<=idx;i++){
    const id=msgOrder[i];
    const c=msgCache.get(id);
    if(c){
      c.seenBy=c.seenBy||[];
      if(!c.seenBy.includes(data.username)) c.seenBy.push(data.username);
    }
    updateTicksFor(id);
  }
});
socket.on('user joined', (data)=>{
  if(data.sessionId && sessionId && data.sessionId!==sessionId) return;
  addSystemMessage(`${data.username} joined ${data.sessionId}`, 'system-pill--join');
});
socket.on('user left', (data)=>{
  const name=typeof data==='string'?data:data.username;
  if(!name||name==='undefined') return;
  if(data.sessionId && sessionId && data.sessionId!==sessionId) return;
  addSystemMessage(`${name} left ${data.sessionId||sessionId}`, 'system-pill--leave');
  clearTypingUser(name);
});
socket.on('users update', (data)=>{
  if(data.sessionId && sessionId && data.sessionId!==sessionId) return;
  renderUserList(data.users||[]);
});
socket.on('user typing', (data)=>{
  if(data.sessionId && sessionId && data.sessionId!==sessionId) return;
  if(data.username===username) return;
  touchTypingUser(data.username); scrollToBottom(false);
});
socket.on('user stop typing', (data)=>{
  if(data.sessionId && sessionId && data.sessionId!==sessionId) return;
  clearTypingUser(data.username);
});
socket.on('server shutdown', (msg)=>{ setConnection('offline','Server restarting…'); formHint.textContent=msg; });

// Image handling
function clearPendingImage(){
  pendingImage=null;
  if(imageInput) imageInput.value='';
  if(imagePreview) imagePreview.style.display='none';
  if(previewImg) previewImg.removeAttribute('src');
  if(previewName) previewName.textContent='';
}
if(imageInput){
  imageInput.addEventListener('change', ()=>{
    const file=imageInput.files && imageInput.files[0];
    if(!file) return;
    clearPendingFile();
    if(!file.type.startsWith('image/')){ formHint.textContent='Only images allowed'; return; }
    if(file.size > 1.6*1024*1024){ formHint.textContent='Image too large — max 1.5MB'; imageInput.value=''; return; }
    if(!['image/png','image/jpeg','image/jpg','image/gif','image/webp'].includes(file.type)){
      formHint.textContent='Use PNG/JPEG/GIF/WEBP only'; return;
    }
    const reader=new FileReader();
    reader.onload=()=>{
      const dataUrl=reader.result;
      if(typeof dataUrl==='string' && dataUrl.length>2000000){ formHint.textContent='Image too large after encoding'; return; }
      pendingImage={ dataUrl, name: file.name };
      if(previewImg){ previewImg.style.display=''; previewImg.src=dataUrl; }
      if(previewName) previewName.textContent=`${file.name} (${(file.size/1024).toFixed(0)}KB) — caption optional`;
      if(imagePreview) imagePreview.style.display='flex';
      formHint.textContent='';
      input.focus();
    };
    reader.readAsDataURL(file);
  });
}
if(clearImageBtn) clearImageBtn.addEventListener('click', ()=>{ clearPendingImage(); clearPendingFile(); });

// Voice notes — hold the mic button to record. Always sealed with the room
// key (same envelope as text/images); max 2 minutes (Opus).
let recState=null;
const VOICE_MAX_S=120;
function pickVoiceMime(){
  if(typeof MediaRecorder==='undefined') return '';
  const cands=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'];
  for(const m of cands){ try{ if(MediaRecorder.isTypeSupported(m)) return m; }catch{} }
  return '';
}
async function startRecording(){
  if(recState) return;
  if(!joined){ formHint.textContent='Create or join a session first'; return; }
  if(roomLocked){ formHint.textContent='🔒 Locked — open the full invite link to send'; return; }
  if(!roomKey){ formHint.textContent='Voice notes need encryption — create a new session'; return; }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ formHint.textContent='Mic not available in this browser'; return; }
  const mime=pickVoiceMime();
  if(!mime){ formHint.textContent='Voice recording not supported here'; return; }
  let stream;
  try{ stream=await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true } }); }
  catch{ formHint.textContent='Mic blocked — allow microphone access'; return; }
  const rec=new MediaRecorder(stream, { mimeType:mime });
  const chunks=[];
  rec.ondataavailable=(e)=>{ if(e.data && e.data.size) chunks.push(e.data); };
  const st={ stream, rec, mime, chunks, startTs:Date.now(), peaks:[], timerId:0, autoId:0, sampleId:0, waveRaf:0, analyser:null, waveData:null, actx:null, _hist:null, done:false };
  recState=st;
  // live level meter on the mini canvas
  try{
    const AC=window.AudioContext||window.webkitAudioContext;
    if(AC && recWave){
      const ctx=new AC(); st.actx=ctx;
      const src=ctx.createMediaStreamSource(stream);
      const an=ctx.createAnalyser(); an.fftSize=512; src.connect(an);
      st.analyser=an; st.waveData=new Uint8Array(an.fftSize);
      const cx2=recWave.getContext('2d');
      const draw=()=>{
        if(recState!==st) return;
        an.getByteTimeDomainData(st.waveData);
        let peak=0;
        for(let i=0;i<st.waveData.length;i++){ const v=Math.abs(st.waveData[i]-128)/128; if(v>peak) peak=v; }
        const W=recWave.width,H=recWave.height;
        cx2.clearRect(0,0,W,H);
        cx2.fillStyle='#2EC4B6';
        const n=28,bw=W/n;
        st._hist=st._hist||new Array(n).fill(0);
        st._hist.push(Math.min(1,peak*1.6)); st._hist.shift();
        st._hist.forEach((v,i)=>{ const h=Math.max(2,v*H); cx2.fillRect(i*bw+1,(H-h)/2,bw-2,h); });
        st.waveRaf=requestAnimationFrame(draw);
      };
      draw();
      st.sampleId=setInterval(()=>{
        if(recState!==st){ clearInterval(st.sampleId); return; }
        const h=st._hist||[0]; st.peaks.push(h[h.length-1]||0);
        if(st.peaks.length>64) st.peaks.shift();
      },150);
    }
  }catch{}
  if(recBar) recBar.style.display='flex';
  const tick=()=>{ const s=Math.floor((Date.now()-st.startTs)/1000); if(recTime) recTime.textContent=`${fmtDur(Math.min(s,VOICE_MAX_S))} / ${fmtDur(VOICE_MAX_S)}`; };
  tick(); st.timerId=setInterval(tick,250);
  st.autoId=setTimeout(()=>{ if(recState===st) stopRecording(true); }, VOICE_MAX_S*1000);
  try{ rec.start(250); }catch{ cleanupRecording(); formHint.textContent='Could not start recording'; return; }
  formHint.textContent='';
}
function cleanupRecording(){
  const st=recState; recState=null;
  if(!st) return;
  clearInterval(st.timerId); clearTimeout(st.autoId); clearInterval(st.sampleId);
  cancelAnimationFrame(st.waveRaf);
  try{ st.actx && st.actx.close(); }catch{}
  try{ st.stream.getTracks().forEach(t=>t.stop()); }catch{}
  if(recBar) recBar.style.display='none';
}
function stopRecording(send){
  const st=recState;
  if(!st || st.done) return;
  st.done=true;
  const durS=(Date.now()-st.startTs)/1000;
  clearInterval(st.timerId); clearTimeout(st.autoId); clearInterval(st.sampleId);
  cancelAnimationFrame(st.waveRaf);
  st.rec.onstop=()=>{
    cleanupRecording();
    if(!send) return;
    if(durS<0.5 || !st.chunks.length){ formHint.textContent='Too short — hold the mic to record'; return; }
    const blob=new Blob(st.chunks,{ type:st.mime });
    const reader=new FileReader();
    reader.onload=async ()=>{
      const dataUrl=reader.result;
      if(typeof dataUrl!=='string' || !dataUrl.startsWith('data:audio/') || dataUrl.length>1500000){
        formHint.textContent='Voice note too large — keep it shorter'; return;
      }
      const replyToId=pendingReply?pendingReply.id:null;
      const replyToUser=pendingReply?pendingReply.username:null;
      try{
        const env=await encryptJSON(roomKey, {
          audio:dataUrl, message:input.value.trim().slice(0,200),
          duration:Math.round(durS*10)/10, peaks:st.peaks, mime:st.mime,
        });
        env.replyToId=replyToId; env.replyToUser=replyToUser;
        if(pendingBurn) env.burnAfter=pendingBurn;
        socket.emit('chat voice', env);
        sndSend();
      }catch{ formHint.textContent='Encryption failed — try again'; return; }
      clearPendingReply();
      input.value=''; charCount.textContent='0 / 500';
      stopTyping(); input.focus();
    };
    reader.readAsDataURL(blob);
  };
  try{ st.rec.stop(); }catch{ cleanupRecording(); }
}
if(voiceBtn){
  voiceBtn.addEventListener('pointerdown', (e)=>{ e.preventDefault(); startRecording(); });
  voiceBtn.addEventListener('contextmenu', (e)=>e.preventDefault());
}
window.addEventListener('pointerup', ()=>{ if(recState) stopRecording(true); });
window.addEventListener('pointercancel', ()=>{ if(recState) stopRecording(false); });
if(recCancel){
  // pointerdown fires before window pointerup, so cancel wins over send
  recCancel.addEventListener('pointerdown', (e)=>{ e.preventDefault(); e.stopPropagation(); stopRecording(false); });
}

// Disappearing messages: sender-side TTL, sticky until changed.
let pendingBurn=0; // seconds: 0 | 10 | 60 | 3600
const BURN_STEPS=[0,10,60,3600];
const BURN_LABELS={ 0:'⏱', 10:'🔥10s', 60:'🔥1m', 3600:'🔥1h' };
function refreshBurnBtn(){ if(burnBtn){ burnBtn.textContent=BURN_LABELS[pendingBurn]; burnBtn.classList.toggle('composer__mic--on', pendingBurn>0); } }
if(burnBtn) burnBtn.addEventListener('click', ()=>{
  pendingBurn=BURN_STEPS[(BURN_STEPS.indexOf(pendingBurn)+1)%BURN_STEPS.length];
  refreshBurnBtn();
  input.focus();
});
refreshBurnBtn();
// seed two poll option inputs
if(pollOpts && pollOptionCount()===0){
  for(let i=0;i<2;i++){
    const inp=document.createElement('input');
    inp.type='text'; inp.maxLength=100; inp.placeholder=`Option ${i+1}`;
    pollOpts.appendChild(inp);
  }
}

// File staging (≤3MB, always E2EE). Mutually exclusive with image staging.
let pendingFile=null; // { dataUrl, name, size, mime }
function showFilePreview(){
  if(previewImg) previewImg.style.display='none';
  if(previewName) previewName.textContent=`📎 ${pendingFile.name} (${fmtSize(pendingFile.size)})`;
  if(imagePreview) imagePreview.style.display='flex';
}
function clearPendingFile(){
  pendingFile=null;
  if(fileInput) fileInput.value='';
  if(previewImg) previewImg.style.display='';
  if(imagePreview && !pendingImage) imagePreview.style.display='none';
  if(previewName && !pendingImage) previewName.textContent='';
}
if(fileInput){
  fileInput.addEventListener('change', ()=>{
    const file=fileInput.files && fileInput.files[0];
    if(!file) return;
    if(file.size>3*1024*1024){ formHint.textContent='File too large — max 3MB'; fileInput.value=''; return; }
    clearPendingImage();
    const reader=new FileReader();
    reader.onload=()=>{
      const dataUrl=reader.result;
      if(typeof dataUrl!=='string' || dataUrl.length>4500000){ formHint.textContent='File too large after encoding'; fileInput.value=''; return; }
      pendingFile={ dataUrl, name:file.name||'file', size:file.size, mime:file.type||'application/octet-stream' };
      showFilePreview();
      formHint.textContent='';
      input.focus();
    };
    reader.readAsDataURL(file);
  });
}

// Poll composer modal
function pollOptionCount(){ return pollOpts ? pollOpts.querySelectorAll('input').length : 0; }
function addPollOption(value){
  if(!pollOpts || pollOptionCount()>=5) return;
  const inp=document.createElement('input');
  inp.type='text'; inp.maxLength=100;
  inp.placeholder=`Option ${pollOptionCount()+1}`;
  if(value) inp.value=value;
  pollOpts.appendChild(inp);
  inp.focus();
}
function openPoll(){
  if(!joined){ formHint.textContent='Create or join a session first'; return; }
  if(roomLocked){ formHint.textContent='🔒 Locked — open the full invite link to send'; return; }
  if(!roomKey){ formHint.textContent='Polls need encryption — create a new session'; return; }
  if(!pollModal) return;
  pollModal.style.display='flex';
  if(pollQ) pollQ.focus();
}
function closePoll(){ if(pollModal) pollModal.style.display='none'; }
if(pollBtn) pollBtn.addEventListener('click', openPoll);
if(pollCancel) pollCancel.addEventListener('click', closePoll);
if(pollModal) pollModal.addEventListener('click', (e)=>{ if(e.target===pollModal) closePoll(); });
if(pollAddOpt) pollAddOpt.addEventListener('click', ()=>addPollOption(''));
if(pollSend) pollSend.addEventListener('click', async ()=>{
  const q=(pollQ?pollQ.value:'').trim().slice(0,200);
  const opts=pollOpts?Array.from(pollOpts.querySelectorAll('input')).map(i=>i.value.trim()).filter(Boolean).slice(0,5):[];
  if(q.length<1){ formHint.textContent='Poll needs a question'; return; }
  if(opts.length<2){ formHint.textContent='Poll needs at least 2 options'; return; }
  if(opts.some(o=>o.length>100)){ formHint.textContent='Options max 100 chars'; return; }
  const replyToId=pendingReply?pendingReply.id:null;
  const replyToUser=pendingReply?pendingReply.username:null;
  try{
    const env=await encryptJSON(roomKey, { question:q, options:opts });
    env.replyToId=replyToId; env.replyToUser=replyToUser;
    if(pendingBurn) env.burnAfter=pendingBurn;
    socket.emit('chat poll', env);
    sndSend();
  }catch{ formHint.textContent='Encryption failed — try again'; return; }
  clearPendingReply();
  if(pollQ) pollQ.value='';
  if(pollOpts) pollOpts.querySelectorAll('input').forEach(i=>i.value='');
  closePoll();
  input.focus();
});

// Themes: '' (signal dark) -> midnight -> sunset, persisted
const THEMES=['','midnight','sunset'];
function applyTheme(t){
  try{
    if(!t) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme=t;
    localStorage.setItem('signal_theme', t);
  }catch{}
}
if(themeBtn) themeBtn.addEventListener('click', ()=>{
  let cur='';
  try{ cur=localStorage.getItem('signal_theme')||''; }catch{}
  applyTheme(THEMES[(THEMES.indexOf(cur)+1)%THEMES.length]);
});

// Form submit
form.addEventListener('submit', async (e)=>{
  e.preventDefault();
  closeMore();
  const val=input.value.trim();
  const hasImage=!!pendingImage;
  const hasFile=!!pendingFile;
  if(!val && !hasImage && !hasFile) return;
  if(!joined){ formHint.textContent='Create or join a session first'; return; }
  if(val.length>500){ formHint.textContent='Message too long (max 500)'; return; }
  if(roomLocked){ formHint.textContent='🔒 Locked — open the full invite link to send'; return; }
  const replyToId = pendingReply ? pendingReply.id : null;
  const replyToUser = pendingReply ? pendingReply.username : null;
  if(roomKey){
    // E2EE: text+caption (+image/file bytes) sealed into one envelope
    try{
      const inner = hasImage ? { image: pendingImage.dataUrl, message: val }
        : hasFile ? { file: pendingFile.dataUrl, name: pendingFile.name, size: pendingFile.size, mime: pendingFile.mime, message: val }
        : { message: val };
      const env = await encryptJSON(roomKey, inner);
      env.replyToId=replyToId; env.replyToUser=replyToUser;
      if(pendingBurn) env.burnAfter=pendingBurn;
      socket.emit(hasImage ? 'chat image' : hasFile ? 'chat file' : 'chat message', env);
    }catch{ formHint.textContent='Encryption failed — try again'; return; }
    if(hasImage) clearPendingImage();
    if(hasFile) clearPendingFile();
  } else if(hasImage){
    const payload={ image: pendingImage.dataUrl, caption: val, replyToId, replyToUser };
    if(pendingBurn) payload.burnAfter=pendingBurn;
    socket.emit('chat image', payload);
    clearPendingImage();
  } else if(hasFile){
    formHint.textContent='Files need encryption — create a new session'; return;
  } else {
    if(replyToId){ const payload={ message: val, replyToId, replyToUser }; if(pendingBurn) payload.burnAfter=pendingBurn; socket.emit('chat message', payload); }
    else if(pendingBurn) socket.emit('chat message', { message: val, burnAfter: pendingBurn });
    else socket.emit('chat message', val);
  }
  sndSend();
  clearPendingReply();
  input.value=''; charCount.textContent='0 / 500';
  stopTyping();
  input.focus();
});

// --- Screenshot / screen-recording deterrents (best-effort) ---
// Browsers give pages NO API to truly block OS screenshots, Snipping Tool,
// phone screenshots, or OBS capture. This module only deters casual capture:
//  - hides content during print / PrintScreen flash
//  - blurs content when the window loses focus (snip tools steal focus)
//  - blocks right-click save on the chat surface
//  - stamps a tracing watermark (username + time) so leaks are attributable
// True blocking needs a native wrapper: Android FLAG_SECURE,
// iOS preventScreenCapture, or Electron setContentProtection(true).
let shieldOn = true;
try{ shieldOn = localStorage.getItem('signal_shield') !== 'off'; }catch{}
let toastTimer = 0;
function showPrivacyToast(msg){
  if(!privacyToast) return;
  privacyToast.textContent = msg;
  privacyToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>privacyToast.classList.remove('show'), 2200);
}
function setPrivacyHide(on){
  document.body.classList.toggle('privacy-hide', !!on);
}
function flashShield(msg, ms){
  setPrivacyHide(true);
  if(msg) showPrivacyToast(msg);
  setTimeout(()=>{ setPrivacyHide(shieldOn ? !document.hasFocus() : false); }, ms || 1200);
}
function refreshShieldBtn(){
  if(!shieldBtn) return;
  shieldBtn.textContent = shieldOn ? '🛡️' : '🛡️‍⬛';
  shieldBtn.classList.toggle('shield-off', !shieldOn);
  shieldBtn.title = shieldOn
    ? 'Privacy shield ON: chat hides when app loses focus (click to disable)'
    : 'Privacy shield OFF (click to enable)';
}
function updateWatermark(){
  if(!watermarkEl) return;
  watermarkEl.innerHTML = '';
  if(!joined || !username) return;
  const tag = `${username} • ${sessionId} • ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
  const frag = document.createDocumentFragment();
  // tile across the viewport; rotated via CSS
  for(let y = -40; y < window.innerHeight + 100; y += 130){
    for(let x = -120; x < window.innerWidth + 100; x += 260){
      const s = document.createElement('span');
      s.className = 'watermark__tile';
      s.style.left = `${x}px`;
      s.style.top = `${y + ((x / 260) % 2 ? 40 : 0)}px`;
      s.textContent = tag;
      frag.appendChild(s);
    }
  }
  watermarkEl.appendChild(frag);
}
if(shieldBtn) shieldBtn.addEventListener('click', ()=>{
  shieldOn = !shieldOn;
  try{ localStorage.setItem('signal_shield', shieldOn ? 'on' : 'off'); }catch{}
  refreshShieldBtn();
  setPrivacyHide(false);
  showPrivacyToast(shieldOn ? '🛡️ Privacy shield ON — chat hides in background' : 'Privacy shield OFF');
  input && input.focus && document.hasFocus() && input.focus();
});
if(privacyShield) privacyShield.addEventListener('click', ()=>{ setPrivacyHide(false); input && input.focus && input.focus(); });
refreshShieldBtn();
window.addEventListener('resize', ()=>{ if(joined) updateWatermark(); });
setInterval(()=>{ if(joined) updateWatermark(); }, 30000);
// Hook into join: refresh watermark once identity is known
const _origSetSessionUI = setSessionUI;
setSessionUI = function(sid){ _origSetSessionUI(sid); updateWatermark(); };

// 1) Keyboard: PrintScreen, save/print/devtools shortcuts -> blank + warn
document.addEventListener('keydown', (e)=>{
  const k = e.key || '';
  const mod = e.ctrlKey || e.metaKey;
  const isPrintScreen = k === 'PrintScreen' || k === 'Snapshot';
  // macOS screenshot chords: Cmd+Shift+3/4/5 ; Windows snip: Win+Shift+S
  const isMacShot = e.metaKey && e.shiftKey && ['3','4','5'].includes(k);
  const isWinSnip = e.shiftKey && (e.metaKey || e.key === 'Meta') && (k.toLowerCase?.() === 's');
  const isSavePrint = mod && !e.shiftKey && ['p','s'].includes(k.toLowerCase?.() || '');
  const isDevtools = (e.ctrlKey && e.shiftKey && ['i','j','c','k'].includes((k || '').toLowerCase())) || k === 'F12';
  if(isPrintScreen || isMacShot || isWinSnip){
    e.preventDefault();
    try{ if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText('').catch(()=>{}); }catch{}
    flashShield('🛡️ Screenshots are discouraged in this private chat', 1500);
    return false;
  }
  if(isSavePrint){
    e.preventDefault();
    showPrivacyToast('🛡️ Saving / printing is disabled in this private chat');
    return false;
  }
  if(isDevtools){
    // don't fight devtools hard (breaks debugging), just warn once
    showPrivacyToast('🛡️ This chat is private — please don\'t copy content out');
  }
});
document.addEventListener('keyup', (e)=>{
  if((e.key || '') === 'PrintScreen'){
    try{ if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText('').catch(()=>{}); }catch{}
    flashShield('🛡️ Screenshots are discouraged in this private chat', 1500);
  }
});
// 2) Right-click / drag / copy-out deterrent on the chat surface only
document.addEventListener('contextmenu', (e)=>{
  if(e.target && e.target.closest && e.target.closest('#chat-scroll, #messages, .message__image, .sidebar')){
    e.preventDefault();
    showPrivacyToast('🛡️ Right-click is disabled to protect this chat');
    return false;
  }
});
document.addEventListener('dragstart', (e)=>{
  if(e.target && e.target.closest && e.target.closest('#messages')) e.preventDefault();
});
// 3) Print (Ctrl+P / Save-as-PDF) -> blank, then restore
window.addEventListener('beforeprint', ()=>setPrivacyHide(true));
window.addEventListener('afterprint', ()=>{ if(document.hasFocus() || !shieldOn) setPrivacyHide(false); showPrivacyToast('🛡️ Printing is disabled in this private chat'); });
// 4) Background blur: opening Snipping Tool / switching apps fires blur.
// When shield is on, hide content until the user clicks back.
window.addEventListener('blur', ()=>{ if(shieldOn && joined) setPrivacyHide(true); });
window.addEventListener('focus', ()=>{ setPrivacyHide(false); maybeEmitSeen(); });
// Mobile: double-tap-and-hold /PiP recording still captures pixels while
// visible — nothing a web page can do there; watermark remains the trace.

// --- Composer "more" popup (phones): voice/burn/poll/file live in a ＋
// popup on small screens so the send row always fits. Desktop unaffected.
function closeMore(){
  if(!moreBtn || !form) return;
  form.classList.remove('open-more');
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.textContent = '＋';
}
if(moreBtn && form){
  moreBtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    const open = form.classList.toggle('open-more');
    moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    moreBtn.textContent = open ? '✕' : '＋';
  });
  document.addEventListener('click', (e)=>{
    if(form.classList.contains('open-more') && !(e.target && e.target.closest && e.target.closest('#form'))) closeMore();
  });
}

// --- PWA install (Android) ---
// Chrome fires beforeinstallprompt only briefly and sometimes not at all —
// without capturing it there is no install entry point ("sometimes works").
// We stash the event, show our own Install button, and otherwise print the
// manual path so install NEVER dead-ends.
let deferredPrompt = null;
function isStandalone(){
  try{
    if(window.matchMedia('(display-mode: standalone)').matches) return true;
    if(window.navigator.standalone === true) return true; // iOS
    if(new URLSearchParams(location.search).get('source') === 'pwa') return true;
  }catch{}
  return false;
}
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredPrompt = e;
  if(installHint) installHint.style.display = 'none';
  if(installBtn && !isStandalone()) installBtn.style.display = 'block';
});
if(installBtn) installBtn.addEventListener('click', async ()=>{
  if(!deferredPrompt) return;
  try{
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
  }catch{}
  deferredPrompt = null;
  installBtn.style.display = 'none';
});
window.addEventListener('appinstalled', ()=>{
  deferredPrompt = null;
  if(installBtn) installBtn.style.display = 'none';
  if(installHint) installHint.style.display = 'none';
  showPrivacyToast('📲 App installed — launch it from your home screen');
});
// Manual fallback when the prompt never arrives (iOS, dismissed prompt,
// desktop): tell the user exactly where to tap.
setTimeout(()=>{
  if(isStandalone() || !installHint) return;
  if(deferredPrompt || (installBtn && installBtn.style.display === 'block')) return;
  if(joined) return; // entry screen gone — nothing to attach to
  const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
  installHint.textContent = isiOS
    ? 'Install on iPhone: Share ⬆ → Add to Home Screen.'
    : 'Install on Android: browser menu ⋮ → Add to Home screen / Install app.';
  installHint.style.display = 'block';
}, 3500);

// Initial
updateEmptyState();
renderUserList([]);
setConnection('connecting','Connecting…');
