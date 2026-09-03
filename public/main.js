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

let username = '';
let sessionId = '';
let joined = false;
let messageCount = 0;
let typingTimeout = null;
let isTyping = false;
let pendingImage = null; // { dataUrl, name }
let pendingReply = null; // { id, username, snippet }
const typingUsers = new Set();
const ALLOWED_REACTIONS = ['❤️', '😂', '👍', '🎉', '😮', '😢'];

const STORAGE_USER = 'signal_username';
const STORAGE_SESSION = 'signal_session';

// Helpers
function initials(name) { return name.trim().slice(0, 2).toUpperCase(); }
function formatTime(iso) { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return '' } }
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
function setSessionUI(sid){
  sessionId = sid;
  if(headerSession) headerSession.textContent = sid;
  if(sidebarSession) sidebarSession.textContent = `# ${sid}`;
  if(sidebarSessionId){ sidebarSessionId.textContent = sid; }
  if(sidebarShareRow) sidebarShareRow.style.display = sid ? 'flex' : 'none';
  if(copyLinkBtn) copyLinkBtn.style.display = sid ? 'inline-flex' : 'none';
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

// Char count + typing
input.addEventListener('input', ()=>{
  charCount.textContent = `${input.value.length} / 500`;
  charCount.style.color = input.value.length>450 ? '#FF5A3C' : '';
  if(!joined) return;
  if(input.value.trim().length>0){
    if(!isTyping){ isTyping=true; socket.emit('typing'); }
    clearTimeout(typingTimeout);
    typingTimeout=setTimeout(()=>{ isTyping=false; socket.emit('stop typing'); },900);
  } else {
    if(isTyping){ isTyping=false; socket.emit('stop typing'); clearTimeout(typingTimeout); }
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

function attemptCreate(){
  const u=usernameInput.value.trim();
  const uErr=validateUsername(u);
  if(uErr){ showJoinError(uErr); usernameInput.focus(); return; }
  showJoinError(''); showSessionError('');
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

// copy link
if(copyLinkBtn){
  copyLinkBtn.addEventListener('click', async ()=>{
    const sid=sessionId||'';
    const link = `${window.location.origin}${window.location.pathname}?session=${encodeURIComponent(sid)}`;
    try{
      await navigator.clipboard.writeText(link);
      const prev=copyLinkBtn.textContent; copyLinkBtn.textContent='✓ Copied'; setTimeout(()=>copyLinkBtn.textContent=prev,1500);
    }catch{
      prompt('Copy this link:', link);
    }
  });
}

// Focus shortcuts
document.addEventListener('keydown', (e)=>{
  if(e.key==='/' && !joined) return;
  if(e.key==='/' && document.activeElement!==input){ e.preventDefault(); if(joined) input.focus(); }
  if(e.key==='Escape'){
    if(pendingReply){ clearPendingReply(); return; }
    if(pendingImage){ clearPendingImage(); return; }
    input.value=''; charCount.textContent='0 / 500'; if(isTyping){ isTyping=false; socket.emit('stop typing'); } typingIndicator.textContent='';
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
function addChatMessage(data,isSelf){
  if(data.id){ const safe=data.id.replace(/"/g,'\\"'); if(messagesEl.querySelector(`[data-id="${safe}"]`)) return; }
  messageCount++; msgCountEl.textContent=`${messageCount} message${messageCount!==1?'s':''}`; updateEmptyState();
  const li=document.createElement('li');
  li.className=`message ${isSelf?'message--self':''}`;
  if(data.id) li.dataset.id=data.id;
  const time=formatTime(data.timestamp);
  const isImage = data.type==='image' && typeof data.image==='string' && data.image.startsWith('data:image/');
  const hasReply = data.replyTo && typeof data.replyTo.id==='string';
  li.innerHTML=`
    <div class="message__bar"></div>
    <div class="message__head">
      <div class="message__avatar">${sanitize(initials(data.username))}</div>
      <div class="message__meta">
        <span class="message__author"></span>
        <span class="message__time"></span>
      </div>
      <div class="message__actions">
        <button class="mini-btn" data-act="react" title="React">☺</button>
        <button class="mini-btn" data-act="reply" title="Reply">↩</button>
      </div>
    </div>
    ${hasReply ? `<div class="message__reply"><span class="message__reply-user"></span><span class="message__reply-text"></span></div>` : ``}
    ${isImage ? `<img class="message__image" alt="shared image" loading="lazy" />` : `<div class="message__body"></div>`}
    ${isImage && data.message ? `<div class="message__image-caption"></div>` : ``}
    <div class="message__reactions"></div>
    <div class="reaction-picker" style="display:none"></div>
  `;
  li.querySelector('.message__author').textContent=data.username;
  li.querySelector('.message__time').textContent=time;
  if(hasReply){
    li.querySelector('.message__reply-user').textContent='@'+data.replyTo.username;
    li.querySelector('.message__reply-text').textContent=data.replyTo.snippet||'';
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
  replyBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); setPendingReply({ id: data.id, username: data.username, snippet: (data.type==='image' ? (data.message||'[image]') : (data.message||'')).slice(0,120) }); });
  messagesEl.appendChild(li);
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
  onlineCount.textContent=users.length;
  if(users.length===0){ userListEl.innerHTML=`<li class="user-list__empty">No one else here yet.<br>Share the session ID to invite.</li>`; return; }
  userListEl.innerHTML='';
  users.forEach(u=>{
    const li=document.createElement('li');
    li.className=`user-chip ${u===username?'user-chip--self':''}`;
    li.innerHTML=`<span class="user-chip__avatar">${sanitize(initials(u))}</span><span class="user-chip__name"></span><span class="user-chip__status"></span>`;
    li.querySelector('.user-chip__name').textContent=u + (u===username?'  (you)':'');
    userListEl.appendChild(li);
  });
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
  if(user && targetSess && !joined){
    usernameInput.value=user; sessionInput.value=targetSess;
    showJoinError(''); showSessionError('');
    socket.emit('join session', { username:user, sessionId:targetSess });
    sessionError.textContent=`Reconnecting to ${targetSess} as ${user}…`; sessionError.style.color='#8A9BB0';
  } else if(user && !joined && sessionInput.value.trim()){
    showJoinError(''); socket.emit('join session', { username:user, sessionId:sessionInput.value.trim().toUpperCase() });
  }
}

// Socket events
socket.on('connect', ()=>{
  setConnection('online', `Connected • ${socket.id.slice(0,4)}`);
  if(getStored().user && getStored().sess && !joined) setTimeout(tryAutoRejoin,80);
});
socket.on('disconnect', ()=>setConnection('offline','Disconnected — reconnecting…'));
socket.on('connect_error', ()=>setConnection('offline','Connection failed — retrying…'));

socket.on('username error', (msg)=>{ showJoinError(msg); const s=getStored(); if(s.user && msg.includes('already taken')){ /* keep session, let user pick new name */ }});
socket.on('session error', (msg)=>{ showSessionError(msg); sessionError.style.color='#F87171'; });
socket.on('session created', ({sessionId:sid})=>{ setSessionUI(sid); });
socket.on('chat error', (msg)=>{ formHint.textContent=msg; setTimeout(()=>formHint.textContent='',3000); });

socket.on('joined', (data)=>{
  username=data.username;
  setSessionUI(data.sessionId);
  joined=true;
  saveSession();
  overlay.classList.add('hidden');
  composerPrefix.textContent=`@${username}`;
  input.placeholder=`Message in ${data.sessionId} as ${username}…`;
  input.focus();
  renderUserList(data.users);
  formHint.textContent='';
  if(Array.isArray(data.history) && data.history.length>0){
    data.history.forEach(m=>{ const isSelf=m.username===username; addChatMessage(m,isSelf); });
  }
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
  addChatMessage(data,isSelf);
  if(!isSelf && typingUsers.has(data.username)){ typingUsers.delete(data.username); renderTyping(); }
});
socket.on('message updated', (data)=>{
  updateMessageInPlace(data);
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
  if(typingUsers.has(name)){ typingUsers.delete(name); renderTyping(); }
});
socket.on('users update', (data)=>{
  if(data.sessionId && sessionId && data.sessionId!==sessionId) return;
  renderUserList(data.users||[]);
});
socket.on('user typing', (data)=>{
  if(data.sessionId && sessionId && data.sessionId!==sessionId) return;
  if(data.username===username) return;
  typingUsers.add(data.username); renderTyping(); scrollToBottom(false);
});
socket.on('user stop typing', (data)=>{
  if(data.sessionId && sessionId && data.sessionId!==sessionId) return;
  typingUsers.delete(data.username); renderTyping();
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
      if(previewImg) previewImg.src=dataUrl;
      if(previewName) previewName.textContent=`${file.name} (${(file.size/1024).toFixed(0)}KB) — caption optional`;
      if(imagePreview) imagePreview.style.display='flex';
      formHint.textContent='';
      input.focus();
    };
    reader.readAsDataURL(file);
  });
}
if(clearImageBtn) clearImageBtn.addEventListener('click', clearPendingImage);

// Form submit
form.addEventListener('submit', (e)=>{
  e.preventDefault();
  const val=input.value.trim();
  const hasImage=!!pendingImage;
  if(!val && !hasImage) return;
  if(!joined){ formHint.textContent='Create or join a session first'; return; }
  if(val.length>500){ formHint.textContent='Message too long (max 500)'; return; }
  const replyToId = pendingReply ? pendingReply.id : null;
  if(hasImage){
    socket.emit('chat image', { image: pendingImage.dataUrl, caption: val, replyToId });
    clearPendingImage();
  } else {
    if(replyToId) socket.emit('chat message', { message: val, replyToId });
    else socket.emit('chat message', val);
  }
  clearPendingReply();
  input.value=''; charCount.textContent='0 / 500';
  if(isTyping){ isTyping=false; clearTimeout(typingTimeout); socket.emit('stop typing'); }
  input.focus();
});

// Initial
updateEmptyState();
renderUserList([]);
setConnection('connecting','Connecting…');
