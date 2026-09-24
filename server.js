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
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const DEVICE_CLIENT_ID = 'ue6666qo983tsx6so1t0vnawi233wa';
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (data.accessToken && !data.users) {
        return { users: [{ accessToken: data.accessToken, refreshToken: data.refreshToken }] };
      }
      return data.users ? data : { users: [] };
    } catch (e) {
      return { users: [] };
    }
  }
  return { users: [] };
}

function saveConfig(data) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

let db = loadConfig();
let activeIntervals = {};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

async function fetchUserDrops(authToken) {
  const cleanToken = authToken.trim().replace('OAuth ', '');

  const validateRes = await axios.get('https://id.twitch.tv/oauth2/validate', {
    headers: { 'Authorization': 'OAuth ' + cleanToken }
  });
  const username = validateRes.data.login || 'Пользователь';

  let items = [];
  try {
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
  } catch (gqlErr) {
    console.error('Ошибка чтения наград для ' + username + ': ' + gqlErr.message);
  }

  return { username, items };
}

function startAllMiningLoops() {
  Object.values(activeIntervals).forEach(clearInterval);
  activeIntervals = {};

  db.users.forEach(user => {
    const userId = user.accessToken;

    async function update() {
      try {
        const { username, items } = await fetchUserDrops(user.accessToken);
        io.emit('user-drops', { username, items });
        io.emit('log', 'Обновлены данные для аккаунта ' + username + ' (найдено наград: ' + items.length + ')');
      } catch (err) {
        console.error('Токен недействителен: ' + err.message);
        io.emit('log', 'Удаление сбойного аккаунта из базы');

        db.users = db.users.filter(u => u.accessToken !== user.accessToken);
        saveConfig(db);

        if (activeIntervals[userId]) {
          clearInterval(activeIntervals[userId]);
          delete activeIntervals[userId];
        }
      }
    }

    update();
    activeIntervals[userId] = setInterval(update, 60000);
  });
}

async function startDeviceFlow(socket) {
  try {
    const params = new URLSearchParams({ client_id: DEVICE_CLIENT_ID });
    const res = await axios.post('https://id.twitch.tv/oauth2/device', params);
    const { device_code, user_code, verification_uri, interval } = res.data;

    socket.emit('device-code', { user_code, verification_uri });

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

          const newToken = tokenRes.data.access_token;
          const exists = db.users.some(u => u.accessToken === newToken);

          if (!exists) {
            db.users.push({
              accessToken: newToken,
              refreshToken: tokenRes.data.refresh_token
            });
            saveConfig(db);
          }

          socket.emit('auth-success');
          startAllMiningLoops();
        }
      } catch (err) {}
    }, pollInterval);

  } catch (err) {
    socket.emit('log', 'Ошибка запуска Device Flow: ' + err.message);
  }
}

io.on('connection', (socket) => {
  if (db.users.length > 0) {
    socket.emit('auth-success', db.users.length);
    startAllMiningLoops();
  }

  socket.on('add-account', () => {
    startDeviceFlow(socket);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('Сервер запущен и доступен по адресу: http://localhost:' + PORT);
  if (db.users.length > 0) {
    startAllMiningLoops();
  }
});