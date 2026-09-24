const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
// Публичный Client ID для Device Flow (Smart TV / Switch)
const DEVICE_CLIENT_ID = 'ue6666qo983tsx6so1t0vnawi233wa';
// Официальный Client ID для GQL веб-интерфейса
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

const CONFIG_FILE = path.join(__dirname, 'config.json');
const HTML_FILE = path.join(__dirname, 'index.html');

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return {}; }
  }
  return {};
}

function saveConfig(data) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

let config = loadConfig();
let activeInterval = null;

// Раздаем имеющийся index.html
app.get('/', (req, res) => {
  res.sendFile(HTML_FILE);
});

// Автоматическое обновление токена через Refresh Token
async function refreshAccessToken() {
  if (!config.refreshToken) return false;
  try {
    const params = new URLSearchParams();
    params.append('client_id', DEVICE_CLIENT_ID);
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', config.refreshToken);

    const res = await axios.post('https://id.twitch.tv/oauth2/token', params);
    if (res.data.access_token) {
      config.accessToken = res.data.access_token;
      if (res.data.refresh_token) config.refreshToken = res.data.refresh_token;
      saveConfig(config);
      return true;
    }
  } catch (e) {
    console.log('Ошибка авто-обновления токена:', e.response?.data || e.message);
  }
  return false;
}

// Запрос к GraphQL API Twitch
async function checkRustDrops(authToken) {
  let cleanToken = authToken.trim().replace('OAuth ', '');

  const query = [{
    operationName: "Inventory",
    query: `query Inventory { currentUser { inventory { dropCampaignInProgress { id name status game { id displayName } timeBasedDrops { id name requiredMinutesWatched currentMinutesWatched } } } } }`
  }];

  const response = await axios.post(TWITCH_GQL_URL, query, {
    headers: {
      'Client-ID': GQL_CLIENT_ID,
      'Authorization': 'OAuth ' + cleanToken,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    }
  });

  const campaigns = response.data[0]?.data?.currentUser?.inventory?.dropCampaignInProgress || [];
  return campaigns.filter(c => c.game && c.game.displayName.toLowerCase() === 'rust');
}

// Запуск цикла фарма
async function runMiningLoop(authToken, emitLog) {
  if (activeInterval) clearInterval(activeInterval);

  emitLog('Запуск мониторинга Drops для Rust...');

  try {
    const rustData = await checkRustDrops(authToken);
    if (rustData.length === 0) {
      emitLog('Успешная авторизация. Активных Drops по Rust сейчас нет.');
    } else {
      emitLog('Активная кампания Rust: ' + JSON.stringify(rustData));
    }
  } catch (err) {
    if (err.response?.status === 401 && config.refreshToken) {
      emitLog('Токен истек. Обновление...');
      const refreshed = await refreshAccessToken();
      if (refreshed) return runMiningLoop(config.accessToken, emitLog);
    }
    emitLog('Ошибка подключения: ' + (err.response?.status ? `HTTP ${err.response.status}` : err.message));
  }

  activeInterval = setInterval(async function() {
    try {
      const rustData = await checkRustDrops(config.accessToken || authToken);
      emitLog('Данные обновлены: ' + new Date().toLocaleTimeString());
    } catch (err) {
      if (err.response?.status === 401 && config.refreshToken) {
        const refreshed = await refreshAccessToken();
        if (refreshed) emitLog('Токен автоматически обновлен');
      } else {
        emitLog('Ошибка обмена: ' + err.message);
      }
    }
  }, 60000);
}

// Device Code Flow
async function startDeviceFlow(emitLog, socket) {
  try {
    const params = new URLSearchParams();
    params.append('client_id', DEVICE_CLIENT_ID);

    const res = await axios.post('https://id.twitch.tv/oauth2/device', params);
    const { device_code, user_code, verification_uri, interval } = res.data;

    emitLog(`Требуется авторизация. Код: ${user_code}`);
    if (socket) socket.emit('device-code', { user_code, verification_uri });

    const pollInterval = (interval || 5) * 1000;
    const timer = setInterval(async () => {
      try {
        const tokenParams = new URLSearchParams();
        tokenParams.append('client_id', DEVICE_CLIENT_ID);
        tokenParams.append('device_code', device_code);
        tokenParams.append('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');

        const tokenRes = await axios.post('https://id.twitch.tv/oauth2/token', tokenParams);
        if (tokenRes.data.access_token) {
          clearInterval(timer);
          config.accessToken = tokenRes.data.access_token;
          config.refreshToken = tokenRes.data.refresh_token;
          saveConfig(config);

          io.emit('auth-success');
          emitLog('Авторизация успешно завершена.');
          runMiningLoop(config.accessToken, (msg) => io.emit('log', msg));
        }
      } catch (err) {
        // Ожидание ввода кода пользователем
      }
    }, pollInterval);

  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    emitLog('Ошибка запуска Device Flow: ' + errMsg);
  }
}

io.on('connection', function(socket) {
  if (config.accessToken) {
    runMiningLoop(config.accessToken, (msg) => io.emit('log', msg));
  } else {
    startDeviceFlow((msg) => io.emit('log', msg), socket);
  }

  socket.on('manual-token', function(data) {
    const authToken = data.authToken.trim();
    if (!authToken) return;
    config.accessToken = authToken;
    saveConfig(config);
    socket.emit('log', 'Токен сохранен');
    runMiningLoop(authToken, (msg) => io.emit('log', msg));
  });
});

server.listen(3001, function() {
  console.log('Сервер запущен: http://localhost:3001');
});