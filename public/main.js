
const socket = io();

const usernameContainer = document.getElementById('username-container');
const usernameInput = document.getElementById('username-input');
const joinChatButton = document.getElementById('join-chat');
const chatContainer = document.getElementById('chat-container');
const form = document.getElementById('form');
const input = document.getElementById('input');
const messages = document.getElementById('messages');

let username = '';

joinChatButton.addEventListener('click', () => {
  username = usernameInput.value;
  if (username) {
    socket.emit('set username', username);
    usernameContainer.style.display = 'none';
    chatContainer.style.display = 'block';
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (input.value) {
    socket.emit('chat message', input.value);
    input.value = '';
  }
});

socket.on('chat message', (data) => {
  const item = document.createElement('li');
  item.textContent = `${data.username}: ${data.message}`;
  messages.appendChild(item);
  window.scrollTo(0, document.body.scrollHeight);
});

socket.on('user joined', (username) => {
  const item = document.createElement('li');
  item.textContent = `${username} joined the chat`;
  messages.appendChild(item);
  window.scrollTo(0, document.body.scrollHeight);
});

socket.on('user left', (username) => {
  const item = document.createElement('li');
  item.textContent = `${username} left the chat`;
  messages.appendChild(item);
  window.scrollTo(0, document.body.scrollHeight);
});
