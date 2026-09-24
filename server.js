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
const SVG_PLACEHOLDER = "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 24 24' fill='none' stroke='%23f05a28' stroke-width='1.5'%3E%3Cpath d='M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z'/%3E%3Cpolyline points='3.27 6.96 12 12.01 20.73 6.96'/%3E%3Cline x1='12' y1='22.08' x2='12' y2='12'/%3E%3C/svg%3E";

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

async function fetchGlobalRustCampaign() {
  if (db.users.length > 0) {
    for (const u of db.users) {
      try {
        const cleanToken = u.accessToken.trim().replace('OAuth ', '');
        const query = [{
          operationName: "ViewerDropsDashboard",
          query: `query ViewerDropsDashboard {
            currentUser {
              dropCampaigns {
                id name startAt endAt status
                game { id displayName }
                timeBasedDrops {
                  id name requiredMinutesWatched
                  benefitEdges { benefit { imageAssetURL } }
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
          },
          timeout: 10000
        });

        const campaigns = response.data[0]?.data?.currentUser?.dropCampaigns || [];
        const rustCampaigns = campaigns.filter(c => c.game && (c.game.displayName.toLowerCase() === 'rust' || c.game.id === '263490'));

        const now = new Date();
        const activeOrUpcoming = rustCampaigns.filter(c => new Date(c.endAt) > now);

        if (activeOrUpcoming.length > 0) {
          activeOrUpcoming.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
          const target = activeOrUpcoming[0];

          const campaignDrops = (target.timeBasedDrops || []).map(drop => ({
            id: drop.id,
            name: drop.name,
            requiredMinutes: drop.requiredMinutesWatched || 60,
            image: drop.benefitEdges?.[0]?.benefit?.imageAssetURL || SVG_PLACEHOLDER
          }));

          return {
            name: target.name,
            startAt: target.startAt,
            endAt: target.endAt,
            status: target.status,
            drops: campaignDrops
          };
        }
      } catch (e) {}
    }
  }

  try {
    const res = await axios.get('https://twitch.facepunch.com/api/drops/detail', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 5000
    });
    if (res.data) {
      let rawDrops = Array.isArray(res.data) ? res.data : (res.data.drops || res.data.streamers || []);
      if (rawDrops.length > 0) {
        const campaignDrops = rawDrops.map(drop => {
          let img = drop.imageUrl || drop.image || drop.icon || SVG_PLACEHOLDER;
          if (img && img.startsWith('/')) img = 'https://twitch.facepunch.com' + img;
          return {
            id: drop.id || drop.name,
            name: drop.name || drop.streamer || 'Rust Drop',
            requiredMinutes: (drop.hours || drop.requiredHours || 1) * 60,
            image: img
          };
        });

        return {
          name: res.data.name || res.data.title || 'RUST ISLES (Round 53)',
          startAt: res.data.startAt || res.data.start || '2026-09-24T19:00:00Z',
          endAt: res.data.endAt || res.data.end || '2026-10-05T00:00:00Z',
          status: 'UPCOMING',
          drops: campaignDrops
        };
      }
    }
  } catch (e) {}

  return {
    name: 'RUST ISLES (Round 53)',
    startAt: '2026-09-24T19:00:00Z',
    endAt: '2026-10-05T00:00:00Z',
    status: 'UPCOMING',
    drops: [
      { id: '1', name: 'Rust Isles Reward #1', requiredMinutes: 120, image: SVG_PLACEHOLDER },
      { id: '2', name: 'Rust Isles Reward #2', requiredMinutes: 180, image: SVG_PLACEHOLDER }
    ]
  };
}

async function fetchUserDrops(authToken) {
  const cleanToken = authToken.trim().replace('OAuth ', '');

  const validateRes = await axios.get('https://id.twitch.tv/oauth2/validate', {
    headers: { 'Authorization': 'OAuth ' + cleanToken },
    timeout: 10000
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
              id name startAt endAt game { displayName }
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
      },
      timeout: 10000
    });

    const campaigns = response.data[0]?.data?.currentUser?.inventory?.dropCampaignInProgress || [];
    const rustCampaigns = campaigns.filter(c => c.game && c.game.displayName.toLowerCase() === 'rust');

    rustCampaigns.forEach(c => {
      (c.timeBasedDrops || []).forEach(drop => {
        const img = drop.benefitEdges?.[0]?.benefit?.imageAssetURL || SVG_PLACEHOLDER;
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

async function updateAllData() {
  const globalCampaign = await fetchGlobalRustCampaign();
  io.emit('campaign-info', globalCampaign);

  db.users.forEach(async (user) => {
    try {
      const { username, items } = await fetchUserDrops(user.accessToken);
      io.emit('user-drops', { username, items });
      io.emit('log', 'Обновлены данные для аккаунта ' + username);
    } catch (err) {
      console.error('Токен недействителен: ' + err.message);
      io.emit('log', 'Удаление сбойного аккаунта из базы');
      db.users = db.users.filter(u => u.accessToken !== user.accessToken);
      saveConfig(db);
    }
  });
}

function startAllMiningLoops() {
  Object.values(activeIntervals).forEach(clearInterval);
  activeIntervals = {};

  updateAllData();
  const loop = setInterval(updateAllData, 60000);
  activeIntervals['global'] = loop;
}

async function startDeviceFlow(socket) {
  try {
    const params = new URLSearchParams({ client_id: DEVICE_CLIENT_ID });
    const res = await axios.post('https://id.twitch.tv/oauth2/device', params, { timeout: 10000 });
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

        const tokenRes = await axios.post('https://id.twitch.tv/oauth2/token', tokenParams, { timeout: 10000 });
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
  socket.emit('auth-success', db.users.length);
  updateAllData();

  socket.on('add-account', () => {
    startDeviceFlow(socket);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('Сервер запущен и доступен по адресу: http://localhost:' + PORT);
  startAllMiningLoops();
});