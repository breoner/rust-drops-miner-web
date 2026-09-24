const socket = io();
const consoleEl = document.getElementById('console');
const authBox = document.getElementById('authBox');
const authCode = document.getElementById('authCode');
const authLink = document.getElementById('authLink');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const usersContainer = document.getElementById('usersContainer');
const addAccountBtn = document.getElementById('addAccountBtn');

const userDropsData = {};

function addLog(msg) {
  const time = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.innerHTML = `<span class="log-time">[${time}]</span> ${msg}`;
  consoleEl.appendChild(div);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

addAccountBtn.addEventListener('click', () => {
  socket.emit('add-account');
});

socket.on('log', addLog);

socket.on('device-code', (data) => {
  authBox.style.display = 'block';
  authCode.innerText = data.user_code;
  authLink.href = data.verification_uri;
  statusText.innerText = 'Требуется авторизация';
});

socket.on('auth-success', () => {
  authBox.style.display = 'none';
  statusDot.classList.add('active');
  statusText.innerText = 'Фарм активен';
});

socket.on('user-drops', ({ username, items }) => {
  userDropsData[username] = items;
  renderAllUsers();
});

function renderAllUsers() {
  usersContainer.innerHTML = '';
  const usernames = Object.keys(userDropsData);

  if (usernames.length === 0) {
    usersContainer.innerHTML = '<p style="color: var(--text-secondary)">Нет привязанных аккаунтов. Нажмите «Добавить аккаунт».</p>';
    return;
  }

  usernames.forEach(username => {
    const items = userDropsData[username];
    const userSection = document.createElement('div');
    userSection.style.background = 'var(--card-bg)';
    userSection.style.border = '1px solid var(--border-color)';
    userSection.style.borderRadius = '12px';
    userSection.style.padding = '16px';

    let cardsHtml = '';
    if (!items || items.length === 0) {
      cardsHtml = '<p style="color: var(--text-secondary); font-size: 0.9rem;">Активных кампаний Rust не найдено</p>';
    } else {
      cardsHtml = '<div class="drops-grid">' + items.map(drop => {
        const percent = Math.min(100, Math.round((drop.currentMinutes / drop.requiredMinutes) * 100));
        return `
          <div class="drop-card">
            <div class="drop-image-container">
              <img class="drop-image" src="${drop.image || ''}" alt="${drop.name}">
            </div>
            <div class="drop-name">${drop.name}</div>
            <div class="progress-container">
              <div class="progress-bar" style="width: ${percent}%"></div>
            </div>
            <div class="progress-text">
              <span>${percent}%</span>
              <span>${drop.currentMinutes}/${drop.requiredMinutes} мин</span>
            </div>
          </div>
        `;
      }).join('') + '</div>';
    }

    userSection.innerHTML = `
      <h3 style="margin-bottom: 12px; font-size: 1.1rem; color: var(--accent-color);">Аккаунт: ${username}</h3>
      ${cardsHtml}
    `;
    usersContainer.appendChild(userSection);
  });
}