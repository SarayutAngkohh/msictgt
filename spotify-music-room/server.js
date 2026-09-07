require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// 1. กด Login ไปยัง Spotify
app.get('/login', (req, res) => {
  const scope = 'user-read-currently-playing user-read-playback-state user-read-private';
  const authUrl = `https://accounts.spotify.com/authorize?response_type=code&client_id=${CLIENT_ID}&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  res.redirect(authUrl);
});

// 2. Callback รับ Code เพื่อแลก Access Token
app.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  try {
    const response = await axios.post('https://accounts.spotify.com/api/token', new URLSearchParams({
      code: code,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64')
      }
    });

    const accessToken = response.data.access_token;
    res.cookie('spotify_access_token', accessToken, { maxAge: 3600000 }); // 1 hour
    res.redirect('/');
  } catch (error) {
    res.send('Login Failed: ' + error.message);
  }
});

// Real-time Management
const activeUsers = {};

io.on('connection', (socket) => {
  socket.on('register_user', async (token) => {
    socket.accessToken = token;
    try {
      const userProfile = await axios.get('https://api.spotify.com/v1/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      activeUsers[socket.id] = {
        name: userProfile.data.display_name,
        avatar: userProfile.data.images[0]?.url || 'https://via.placeholder.com/150',
        song: null
      };
      io.emit('update_users', activeUsers);
    } catch (e) {
      console.log('Error fetching profile');
    }
  });

  socket.on('disconnect', () => {
    delete activeUsers[socket.id];
    io.emit('update_users', activeUsers);
  });
});

// ดึงเพลงทุกๆ 4 วินาที (เหมาะกับคน 40 คน ประหยัดทรัพยากร)
setInterval(async () => {
  for (const socketId in activeUsers) {
    const user = activeUsers[socketId];
    const socket = io.sockets.sockets.get(socketId);
    if (socket && socket.accessToken) {
      try {
        const res = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
          headers: { 'Authorization': `Bearer ${socket.accessToken}` }
        });

        if (res.data && res.data.is_playing) {
          user.song = {
            title: res.data.item.name,
            artist: res.data.item.artists.map(a => a.name).join(', '),
            albumCover: res.data.item.album.images[0]?.url
          };
        } else {
          user.song = null;
        }
      } catch (err) {
        user.song = null;
      }
    }
  }
  io.emit('update_users', activeUsers);
}, 4000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));