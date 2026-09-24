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
// Отдаем статические файлы (включая style.css)
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const DEVICE_CLIENT_ID = 'ue6666qo983tsx6so1t0vnawi233wa';
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

const CONFIG_FILE = path.join(__dirname, 'config.json');

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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// GraphQL запрос с парсингом картинок наград
async function checkRustDrops(authToken) {
  let cleanToken = authToken.trim().replace('OAuth ', '');

  const query = [{
    operationName: "Inventory",
    query: `query Inventory {
      currentUser {
        inventory {
          dropCampaignInProgress {
            id name game { displayName }
            timeBasedDrops {
              id name requiredMinutesWatched currentMinutesWatched
              benefitEdges { benefit { imageAssetURL } }
            }
          }
        }
      }
    }`
  }];

  const response = await axios.post(TWITCH_GQL_URL, query, {
    headers: {
      'Client-ID': GQL_CLIENT_ID,
      'Authorization': 'OAuth ' + cleanToken,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }
  });

  const campaigns = response.data[0]?.data?.currentUser?.inventory?.dropCampaignInProgress || [];
  const rustCampaigns = campaigns.filter(c => c.game && c.game.displayName.toLowerCase() === 'rust');

  let items = [];
  rustCampaigns.forEach(c => {
    (c.timeBasedDrops || []).forEach(drop => {
      const img = drop.benefitEdges?.[0]?.benefit?.imageAssetURL || '';
      items.push({
        name: drop.name,
        currentMinutes: drop.currentMinutesWatched || 0,
        requiredMinutes: drop.requiredMinutesWatched || 60,
        image: img
      });
    });
  });

  return items;
}

async function runMiningLoop(authToken, emitLog) {
  if (activeInterval) clearInterval(activeInterval);
  emitLog('Запуск мониторинга Drops для Rust...');

  async function update() {
    try {
      const items = await checkRustDrops(config.accessToken || authToken);
      io.emit('drops-data', items);
      emitLog(`Обновлены данные о предметах (${items.length} шт.)`);
    } catch (err) {
      emitLog('Ошибка обновления данных: ' + err.message);
    }
  }

  await update();
  activeInterval = setInterval(update, 60000);
}

async function startDeviceFlow(emitLog, socket) {
  try {
    const params = new URLSearchParams({ client_id: DEVICE_CLIENT_ID });
    const res = await axios.post('https://id.twitch.tv/oauth2/device', params);
    const { device_code, user_code, verification_uri, interval } = res.data;

    emitLog(`Требуется авторизация. Код: ${user_code}`);
    if (socket) socket.emit('device-code', { user_code, verification_uri });

    const pollInterval = (interval || 5) * 1000;
    const timer = setInterval(async () => {
      try {
        const tokenParams = new URLSearchParams({
          client_id: DEVICE_CLIENT_ID,
          device_code: device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        });

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
      } catch (err) {}
    }, pollInterval);

  } catch (err) {
    emitLog('Ошибка запуска Device Flow: ' + err.message);
  }
}

io.on('connection', function(socket) {
  if (config.accessToken) {
    socket.emit('auth-success');
    runMiningLoop(config.accessToken, (msg) => io.emit('log', msg));
  } else {
    startDeviceFlow((msg) => io.emit('log', msg), socket);
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, function() {
  console.log('Сервер запущен на порту: ' + PORT);
});