// server.js - Multiplayer Spaceship Game Server
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files from public directory
app.use(express.static(__dirname + '/public'));
app.use(express.json());

// Root route - serve index.html from public folder
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Game state
const players = new Map();
const bullets = new Map();
const bannedUsers = new Map(); // username -> ban expiry timestamp
const kickedUsers = new Map(); // username -> kick expiry timestamp

// Profanity filter
const BANNED_WORDS = [
  'rape', 'nigga', 'nigger', 'fuck', 'shit', 'bitch', 'cunt', 
  'whore', 'slut', 'gay', 'homo', 'pussy', 'dick', 'anal', 
  'onlyfans', 'cum', 'blowjob', 'porn'
];

// Admin password (CHANGE THIS!)
const ADMIN_PASSWORD = '3310';

function containsProfanity(text) {
  const lowerText = text.toLowerCase();
  return BANNED_WORDS.some(word => lowerText.includes(word));
}

function isUserBanned(username) {
  const lowerName = username.toLowerCase();
  
  // Check permanent ban
  if (bannedUsers.has(lowerName)) {
    const expiry = bannedUsers.get(lowerName);
    if (expiry === 'permanent') return true;
    if (Date.now() < expiry) return true;
    bannedUsers.delete(lowerName);
  }
  
  // Check 24h kick
  if (kickedUsers.has(lowerName)) {
    const expiry = kickedUsers.get(lowerName);
    if (Date.now() < expiry) return true;
    kickedUsers.delete(lowerName);
  }
  
  return false;
}

// Clean up old bans/kicks every minute
setInterval(() => {
  const now = Date.now();
  
  for (const [name, expiry] of kickedUsers.entries()) {
    if (expiry !== 'permanent' && now >= expiry) {
      kickedUsers.delete(name);
    }
  }
  
  for (const [name, expiry] of bannedUsers.entries()) {
    if (expiry !== 'permanent' && now >= expiry) {
      bannedUsers.delete(name);
    }
  }
}, 60000);

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Join game
  socket.on('join', (data) => {
    const { name, color } = data;
    
    // Validate name
    if (!name || name.trim().length === 0) {
      socket.emit('joinError', 'Name cannot be empty');
      return;
    }
    
    if (name.length > 20) {
      socket.emit('joinError', 'Name too long (max 20 characters)');
      return;
    }
    
    // Check profanity
    if (containsProfanity(name)) {
      socket.emit('joinError', 'Username contains inappropriate language');
      return;
    }
    
    // Check if banned/kicked
    if (isUserBanned(name)) {
      socket.emit('joinError', 'You have been banned from the game');
      return;
    }
    
    // Check if name is taken
    for (const player of players.values()) {
      if (player.name.toLowerCase() === name.toLowerCase()) {
        socket.emit('joinError', 'Name already taken');
        return;
      }
    }

    // Create player
    const player = {
      id: socket.id,
      name: name,
      color: color,
      x: 0,
      y: 0,
      angle: 0,
      speed: 0,
      health: 6,
      kills: 0,
      shipSize: 'small'
    };

    players.set(socket.id, player);
    
    // Send success
    socket.emit('joinSuccess', {
      playerId: socket.id,
      players: Array.from(players.values())
    });
    
    // Notify others
    socket.broadcast.emit('playerJoined', player);
    
    console.log(`Player joined: ${name} (${socket.id})`);
  });

  // Update player position
  socket.on('updatePlayer', (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    
    player.x = data.x;
    player.y = data.y;
    player.angle = data.angle;
    player.speed = data.speed;
    
    // Broadcast to others
    socket.broadcast.emit('playerMoved', {
      id: socket.id,
      x: data.x,
      y: data.y,
      angle: data.angle,
      speed: data.speed
    });
  });

  // Shoot bullet
  socket.on('shoot', (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    
    const bulletId = `${socket.id}_${Date.now()}`;
    const bullet = {
      id: bulletId,
      x: data.x,
      y: data.y,
      vx: data.vx,
      vy: data.vy,
      color: player.color,
      owner: socket.id
    };
    
    bullets.set(bulletId, bullet);
    
    // Broadcast to all
    io.emit('bulletFired', bullet);
    
    // Auto-remove after 5 seconds
    setTimeout(() => bullets.delete(bulletId), 5000);
  });

  // Player hit
  socket.on('playerHit', (data) => {
    const victim = players.get(data.victimId);
    const shooter = players.get(data.shooterId);
    
    if (!victim || !shooter) return;
    
    victim.health--;
    
    // Broadcast damage
    io.emit('playerDamaged', {
      victimId: data.victimId,
      health: victim.health
    });
    
    // Check death
    if (victim.health <= 0) {
      shooter.kills++;
      victim.kills = 0;
      victim.health = 6;
      victim.shipSize = 'small';
      
      // Update shooter ship size
      if (shooter.kills >= 6) shooter.shipSize = 'large';
      else if (shooter.kills >= 3) shooter.shipSize = 'medium';
      
      io.emit('playerDied', {
        victimId: data.victimId,
        killerId: data.shooterId,
        killerKills: shooter.kills,
        killerShipSize: shooter.shipSize
      });
      
      console.log(`${shooter.name} killed ${victim.name}`);
    }
  });

  // Respawn
  socket.on('respawn', (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    
    player.x = data.x;
    player.y = data.y;
    player.angle = 0;
    player.speed = 0;
    
    socket.broadcast.emit('playerRespawned', {
      id: socket.id,
      x: data.x,
      y: data.y
    });
  });

  // Admin authentication
  socket.on('adminLogin', (password) => {
    if (password === ADMIN_PASSWORD) {
      socket.emit('adminAuthenticated');
      socket.isAdmin = true;
      console.log('Admin authenticated:', socket.id);
    } else {
      socket.emit('adminError', 'Invalid password');
    }
  });

  // Admin: Get player list
  socket.on('adminGetPlayers', () => {
    if (!socket.isAdmin) return;
    
    socket.emit('adminPlayerList', {
      players: Array.from(players.values()),
      banned: Array.from(bannedUsers.entries()),
      kicked: Array.from(kickedUsers.entries())
    });
  });

  // Admin: Kick player (24h)
  socket.on('adminKick', (targetName) => {
    if (!socket.isAdmin) return;
    
    const lowerName = targetName.toLowerCase();
    const expiry = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
    kickedUsers.set(lowerName, expiry);
    
    // Find and disconnect player
    for (const [id, player] of players.entries()) {
      if (player.name.toLowerCase() === lowerName) {
        io.to(id).emit('kicked', 'You have been kicked for 24 hours');
        io.sockets.sockets.get(id)?.disconnect(true);
        break;
      }
    }
    
    console.log(`Admin kicked: ${targetName}`);
    socket.emit('adminActionSuccess', `Kicked ${targetName} for 24 hours`);
  });

  // Admin: Ban player (permanent)
  socket.on('adminBan', (targetName) => {
    if (!socket.isAdmin) return;
    
    const lowerName = targetName.toLowerCase();
    bannedUsers.set(lowerName, 'permanent');
    
    // Find and disconnect player
    for (const [id, player] of players.entries()) {
      if (player.name.toLowerCase() === lowerName) {
        io.to(id).emit('banned', 'You have been permanently banned');
        io.sockets.sockets.get(id)?.disconnect(true);
        break;
      }
    }
    
    console.log(`Admin banned: ${targetName}`);
    socket.emit('adminActionSuccess', `Permanently banned ${targetName}`);
  });

  // Admin: Get banned words
  socket.on('adminGetBannedWords', () => {
    if (!socket.isAdmin) return;
    socket.emit('bannedWordsUpdate', BANNED_WORDS);
  });

  // Admin: Add banned word
  socket.on('adminAddBannedWord', (word) => {
    if (!socket.isAdmin) return;
    
    const lowerWord = word.toLowerCase().trim();
    if (!lowerWord || BANNED_WORDS.includes(lowerWord)) return;
    
    BANNED_WORDS.push(lowerWord);
    console.log(`Admin added banned word: ${lowerWord}`);
    socket.emit('bannedWordsUpdate', BANNED_WORDS);
    socket.emit('adminActionSuccess', `Added "${lowerWord}" to banned words`);
  });

  // Admin: Remove banned word
  socket.on('adminRemoveBannedWord', (word) => {
    if (!socket.isAdmin) return;
    
    const index = BANNED_WORDS.indexOf(word.toLowerCase());
    if (index > -1) {
      BANNED_WORDS.splice(index, 1);
      console.log(`Admin removed banned word: ${word}`);
      socket.emit('bannedWordsUpdate', BANNED_WORDS);
      socket.emit('adminActionSuccess', `Removed "${word}" from banned words`);
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const player = players.get(socket.id);
    if (player) {
      console.log('Player disconnected:', player.name);
      players.delete(socket.id);
      io.emit('playerLeft', socket.id);
    }
  });
});

// Health check endpoint
app.get('/ping', (req, res) => {
  res.json({ 
    status: 'ok', 
    players: players.size,
    uptime: process.uptime()
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
