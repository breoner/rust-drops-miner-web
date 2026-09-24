const socket = io();
const consoleEl = document.getElementById('console');
const authBox = document.getElementById('authBox');
const authCode = document.getElementById('authCode');
const authLink = document.getElementById('authLink');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const usersContainer = document.getElementById('usersContainer');
const addAccountBtn = document.getElementById('addAccountBtn');
const campaignDropsGrid = document.getElementById('campaignDropsGrid');

const SVG_FALLBACK = "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 24 24' fill='none' stroke='%23f05a28' stroke-width='1.5'%3E%3Cpath d='M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z'/%3E%3Cpolyline points='3.27 6.96 12 12.01 20.73 6.96'/%3E%3Cline x1='12' y1='22.08' x2='12' y2='12'/%3E%3C/svg%3E";
const userDropsData = {};
let targetEndTime = null;
let countdownInterval = null;

function addLog(msg) {
  const time = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.innerHTML = '<span class="log-time">[' + time + ']</span> ' + msg;
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

socket.on('campaign-info', (data) => {
  const campaignName = document.getElementById('campaignName');
  const campaignBadge = document.getElementById('campaignBadge');

  if (!data) {
    campaignName.innerText = 'Активных кампаний Rust не найдено';
    campaignBadge.innerText = 'Неактивно';
    campaignBadge.className = 'timer-badge';

    document.getElementById('timerDays').innerText = '00';
    document.getElementById('timerHours').innerText = '00';
    document.getElementById('timerMinutes').innerText = '00';
    document.getElementById('timerSeconds').innerText = '00';
    if (countdownInterval) clearInterval(countdownInterval);

    if (campaignDropsGrid) {
      campaignDropsGrid.innerHTML = '<p class="no-drops-text">Нет активных скинов в кампании</p>';
    }
    return;
  }

  campaignName.innerText = data.name || 'Активная кампания Rust';

  const now = new Date().getTime();
  const startTime = new Date(data.startAt).getTime();

  if (now < startTime) {
    targetEndTime = startTime;
    campaignBadge.innerText = 'Скоро начнётся';
    campaignBadge.className = 'timer-badge upcoming';
    startCountdown();
  } else if (data.endAt) {
    targetEndTime = new Date(data.endAt).getTime();
    campaignBadge.innerText = 'Идёт фарм';
    campaignBadge.className = 'timer-badge active';
    startCountdown();
  }

  if (campaignDropsGrid) {
    if (data.drops && data.drops.length > 0) {
      campaignDropsGrid.innerHTML = data.drops.map(drop => {
        const hours = (drop.requiredMinutes / 60).toFixed(drop.requiredMinutes % 60 === 0 ? 0 : 1);
        const imgSrc = drop.image || SVG_FALLBACK;
        return '<div class="campaign-drop-card">' +
            '<div class="campaign-drop-img-box">' +
              '<img src="' + imgSrc + '" alt="' + drop.name + '" loading="lazy" onerror="this.onerror=null;this.src=\'' + SVG_FALLBACK + '\';">' +
            '</div>' +
            '<div class="campaign-drop-name">' + drop.name + '</div>' +
            '<div class="campaign-drop-time">' + hours + ' ч. просмотров (' + drop.requiredMinutes + ' мин)</div>' +
          '</div>';
      }).join('');
    } else {
      campaignDropsGrid.innerHTML = '<p class="no-drops-text">Скины не найдены</p>';
    }
  }
});

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);

  function update() {
    if (!targetEndTime) return;

    const now = new Date().getTime();
    const distance = targetEndTime - now;

    if (distance < 0) {
      clearInterval(countdownInterval);
      document.getElementById('timerDays').innerText = '00';
      document.getElementById('timerHours').innerText = '00';
      document.getElementById('timerMinutes').innerText = '00';
      document.getElementById('timerSeconds').innerText = '00';
      document.getElementById('campaignBadge').innerText = 'Завершено';
      document.getElementById('campaignBadge').className = 'timer-badge';
      return;
    }

    const days = Math.floor(distance / (1000 * 60 * 60 * 24));
    const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((distance % (1000 * 60)) / 1000);

    document.getElementById('timerDays').innerText = String(days).padStart(2, '0');
    document.getElementById('timerHours').innerText = String(hours).padStart(2, '0');
    document.getElementById('timerMinutes').innerText = String(minutes).padStart(2, '0');
    document.getElementById('timerSeconds').innerText = String(seconds).padStart(2, '0');
  }

  update();
  countdownInterval = setInterval(update, 1000);
}

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
        const imgSrc = drop.image || SVG_FALLBACK;
        return '<div class="drop-card">' +
            '<div class="drop-image-container">' +
              '<img class="drop-image" src="' + imgSrc + '" alt="' + drop.name + '" onerror="this.onerror=null;this.src=\'' + SVG_FALLBACK + '\';">' +
            '</div>' +
            '<div class="drop-name">' + drop.name + '</div>' +
            '<div class="progress-container">' +
              '<div class="progress-bar" style="width: ' + percent + '%"></div>' +
            '</div>' +
            '<div class="progress-text">' +
              '<span>' + percent + '%</span>' +
              '<span>' + drop.currentMinutes + '/' + drop.requiredMinutes + ' мин</span>' +
            '</div>' +
          '</div>';
      }).join('') + '</div>';
    }

    userSection.innerHTML = '<h3 style="margin-bottom: 12px; font-size: 1.1rem; color: var(--accent-color);">Аккаунт: ' + username + '</h3>' + cardsHtml;
    usersContainer.appendChild(userSection);
  });
}