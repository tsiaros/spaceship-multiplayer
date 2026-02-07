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
const npcs = new Map(); // NPC enemies and bosses
const npcDeaths = []; // Log of killed NPCs

let npcIdCounter = 0;
let clockActive = false;
let clockAngle = -45; // Start at bottom-left
let clockDirection = 1; // 1 = clockwise, -1 = counter-clockwise
let xBeamActive = false;
const xBeams = new Map();
let xBeamIdCounter = 0;

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
    
    // Each bullet does 1 damage independently
    victim.health--;
    
    // Broadcast damage to ALL players
    io.emit('playerDamaged', {
      victimId: data.victimId,
      health: victim.health
    });
    
    console.log(`${shooter.name} hit ${victim.name} - Health: ${victim.health}/6`);
    
    // Check death (when health reaches 0)
    if (victim.health <= 0) {
      shooter.kills++;
      victim.kills = 0;
      victim.health = 6;
      victim.shipSize = 'small';
      
      // Update shooter ship size based on kills
      if (shooter.kills >= 6) shooter.shipSize = 'large';
      else if (shooter.kills >= 3) shooter.shipSize = 'medium';
      else shooter.shipSize = 'small';
      
      // Broadcast death to ALL players IMMEDIATELY
      io.emit('playerDied', {
        victimId: data.victimId,
        killerId: data.shooterId,
        killerKills: shooter.kills,
        killerShipSize: shooter.shipSize
      });
      
      // Force cleanup after 100ms to ensure ghost removal
      setTimeout(() => {
        io.emit('forceRemoveShip', { playerId: data.victimId });
      }, 100);
      
      console.log(`💀 ${shooter.name} killed ${victim.name} (Killer kills: ${shooter.kills})`);
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

  // Admin: Spawn enemy NPC
  socket.on('adminSpawnEnemy', () => {
    if (!socket.isAdmin) return;
    
    const npcId = `enemy_${npcIdCounter++}`;
    const angle = Math.random() * Math.PI * 2;
    const distance = 400 + Math.random() * 300;
    
    const npc = {
      id: npcId,
      type: 'enemy',
      name: 'Enemy',
      x: 1280 + Math.cos(angle) * distance,
      y: 720 + Math.sin(angle) * distance,
      angle: Math.random() * 360,
      speed: 0,
      health: 6,
      maxHealth: 6,
      color: '#ff0000',
      target: null,
      lastShot: 0
    };
    
    npcs.set(npcId, npc);
    io.emit('npcSpawned', npc);
    socket.emit('adminActionSuccess', 'Enemy spawned');
    socket.emit('adminNPCList', {
      npcs: Array.from(npcs.values()),
      deaths: npcDeaths
    });
    console.log('Enemy NPC spawned:', npcId);
  });

  // Admin: Spawn boss NPC
  socket.on('adminSpawnBoss', () => {
    if (!socket.isAdmin) return;
    
    const npcId = `boss_${npcIdCounter++}`;
    const angle = Math.random() * Math.PI * 2;
    const distance = 400 + Math.random() * 300;
    
    const npc = {
      id: npcId,
      type: 'boss',
      name: 'Boss',
      x: 1280 + Math.cos(angle) * distance,
      y: 720 + Math.sin(angle) * distance,
      angle: Math.random() * 360,
      speed: 0,
      health: 25,
      maxHealth: 25,
      color: '#ff0000',
      target: null,
      lastShot: 0
    };
    
    npcs.set(npcId, npc);
    io.emit('npcSpawned', npc);
    socket.emit('adminActionSuccess', 'Boss spawned');
    socket.emit('adminNPCList', {
      npcs: Array.from(npcs.values()),
      deaths: npcDeaths
    });
    console.log('Boss NPC spawned:', npcId);
  });

  // Admin: Delete NPC
  socket.on('adminDeleteNPC', (npcId) => {
    if (!socket.isAdmin) return;
    
    const npc = npcs.get(npcId);
    if (npc) {
      npcs.delete(npcId);
      io.emit('npcRemoved', { npcId });
      socket.emit('adminActionSuccess', `Deleted ${npc.name}`);
      socket.emit('adminNPCList', {
        npcs: Array.from(npcs.values()),
        deaths: npcDeaths
      });
      console.log('NPC deleted by admin:', npcId);
    }
  });

  // Admin: Get NPC list
  socket.on('adminGetNPCs', () => {
    if (!socket.isAdmin) return;
    
    socket.emit('adminNPCList', {
      npcs: Array.from(npcs.values()),
      deaths: npcDeaths
    });
  });

  // Admin: Clear death log
  socket.on('adminClearDeaths', () => {
    if (!socket.isAdmin) return;
    
    npcDeaths.length = 0;
    socket.emit('adminNPCList', {
      npcs: Array.from(npcs.values()),
      deaths: npcDeaths
    });
    socket.emit('adminActionSuccess', 'Death log cleared');
  });

  // Admin: Toggle Clock attack
  socket.on('adminToggleClock', () => {
    if (!socket.isAdmin) return;
    
    clockActive = !clockActive;
    socket.emit('adminClockStatus', { active: clockActive });
    
    if (clockActive) {
      clockAngle = -45; // Reset to start position
      socket.emit('adminActionSuccess', 'Clock attack activated');
    } else {
      socket.emit('adminActionSuccess', 'Clock attack deactivated');
    }
  });

  // Admin: Toggle X attack
  socket.on('adminToggleX', () => {
    if (!socket.isAdmin) return;
    
    xBeamActive = !xBeamActive;
    socket.emit('adminXStatus', { active: xBeamActive });
    
    if (xBeamActive) {
      socket.emit('adminActionSuccess', 'X attack activated');
    } else {
      // Remove all X beams
      xBeams.forEach((beam) => {
        io.emit('xBeamRemoved', { id: beam.id });
      });
      xBeams.clear();
      socket.emit('adminActionSuccess', 'X attack deactivated');
    }
  });

  // NPC hit by player
  socket.on('npcHit', (data) => {
    const npc = npcs.get(data.npcId);
    const shooter = players.get(data.shooterId);
    
    if (!npc || !shooter) return;
    
    npc.health--;
    
    io.emit('npcDamaged', {
      npcId: data.npcId,
      health: npc.health
    });
    
    console.log(`${shooter.name} hit ${npc.type} - Health: ${npc.health}/${npc.maxHealth}`);
    
    // Check death
    if (npc.health <= 0) {
      shooter.kills++;
      
      // Update shooter ship size
      if (shooter.kills >= 6) shooter.shipSize = 'large';
      else if (shooter.kills >= 3) shooter.shipSize = 'medium';
      else shooter.shipSize = 'small';
      
      // Log death
      npcDeaths.push({
        npcType: npc.type,
        npcName: npc.type === 'boss' ? 'Boss' : 'Enemy',
        killerName: shooter.name,
        timestamp: Date.now()
      });
      
      // Remove NPC
      npcs.delete(data.npcId);
      
      io.emit('npcDied', {
        npcId: data.npcId,
        killerId: data.shooterId,
        killerKills: shooter.kills,
        killerShipSize: shooter.shipSize
      });
      
      // Notify all admins
      io.sockets.sockets.forEach(s => {
        if (s.isAdmin) {
          s.emit('adminNPCList', {
            npcs: Array.from(npcs.values()),
            deaths: npcDeaths
          });
        }
      });
      
      console.log(`💀 ${shooter.name} killed ${npc.type}`);
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

// NPC AI Update Loop
setInterval(() => {
  if (npcs.size === 0) return;
  
  const playerList = Array.from(players.values());
  if (playerList.length === 0) return;
  
  npcs.forEach(npc => {
    // Assign target if none or target is dead
    if (!npc.target || !players.has(npc.target)) {
      // Distribute targets evenly
      const targetCounts = new Map();
      npcs.forEach(n => {
        if (n.target) {
          targetCounts.set(n.target, (targetCounts.get(n.target) || 0) + 1);
        }
      });
      
      // Find player with fewest NPCs targeting them
      let leastTargeted = playerList[0].id;
      let minCount = targetCounts.get(leastTargeted) || 0;
      
      playerList.forEach(p => {
        const count = targetCounts.get(p.id) || 0;
        if (count < minCount) {
          minCount = count;
          leastTargeted = p.id;
        }
      });
      
      npc.target = leastTargeted;
    }
    
    const target = players.get(npc.target);
    if (!target) return;
    
    // Calculate angle to target
    const dx = target.x - npc.x;
    const dy = target.y - npc.y;
    const targetAngle = Math.atan2(dx, -dy) * 180 / Math.PI;
    
    // Smooth rotation toward target
    let angleDiff = targetAngle - npc.angle;
    while (angleDiff > 180) angleDiff -= 360;
    while (angleDiff < -180) angleDiff += 360;
    
    if (Math.abs(angleDiff) > 5) {
      npc.angle += Math.sign(angleDiff) * 3;
    }
    
    // Move toward target
    if (Math.random() < 0.3) {
      npc.speed = Math.min(npc.speed + 0.3, 3);
    } else {
      npc.speed *= 0.96;
    }
    
    const radians = npc.angle * Math.PI / 180;
    npc.x += Math.sin(radians) * npc.speed;
    npc.y -= Math.cos(radians) * npc.speed;
    
    // Screen wrap
    if (npc.x < 0) npc.x = 2560;
    if (npc.x > 2560) npc.x = 0;
    if (npc.y < 0) npc.y = 1440;
    if (npc.y > 1440) npc.y = 0;
    
    // Shoot at target
    const distance = Math.sqrt(dx*dx + dy*dy);
    const now = Date.now();
    
    if (distance < 600 && Math.abs(angleDiff) < 20 && now - npc.lastShot > 800) {
      npc.lastShot = now;
      
      const bulletX = npc.x + Math.sin(radians) * 25;
      const bulletY = npc.y - Math.cos(radians) * 25;
      const vx = Math.sin(radians) * 8;
      const vy = -Math.cos(radians) * 8;
      
      const bulletId = `${npc.id}_${now}`;
      const bullet = {
        id: bulletId,
        x: bulletX,
        y: bulletY,
        vx, vy,
        color: npc.color,
        owner: npc.id
      };
      
      bullets.set(bulletId, bullet);
      io.emit('bulletFired', bullet);
      
      setTimeout(() => bullets.delete(bulletId), 5000);
    }
  });
  
  // Broadcast NPC positions
  io.emit('npcUpdate', Array.from(npcs.values()).map(npc => ({
    id: npc.id,
    x: npc.x,
    y: npc.y,
    angle: npc.angle
  })));
}, 50); // Update 20 times per second

// Clock Attack Pattern - Sweeping bullets from bottom
setInterval(() => {
  if (!clockActive) return;
  
  // Sweep from -45° (bottom-left) to 45° (bottom-right) and back
  // Total sweep = 90°, time = 1100ms per direction
  // At 50ms intervals, that's 22 steps, so 90/22 = ~4.09° per step
  const sweepSpeed = 4.09;
  
  clockAngle += clockDirection * sweepSpeed;
  
  // Reverse direction at ends
  if (clockAngle >= 45) {
    clockAngle = 45;
    clockDirection = -1;
  } else if (clockAngle <= -45) {
    clockAngle = -45;
    clockDirection = 1;
  }
  
  // Shoot bullet from center bottom
  const startX = 1280; // Center X
  const startY = 1440; // Bottom Y
  const radians = clockAngle * Math.PI / 180;
  
  const bulletId = `clock_${Date.now()}_${Math.random()}`;
  const bullet = {
    id: bulletId,
    x: startX,
    y: startY,
    vx: Math.sin(radians) * 8,
    vy: -Math.cos(radians) * 8, // Negative because Y increases downward
    color: '#ff0000',
    owner: 'clock'
  };
  
  io.emit('clockBullet', bullet);
}, 50); // Fire every 50ms

// X Beam spawner
let lastXBeamSpawn = 0;
setInterval(() => {
  if (!xBeamActive) return;
  
  const now = Date.now();
  if (now - lastXBeamSpawn < 1100) return;
  lastXBeamSpawn = now;
  
  const beamId = `xbeam_${xBeamIdCounter++}`;
  
  // Random: either left→right or top→bottom
  const isHorizontal = Math.random() < 0.5;
  
  let startX, startY, vx, vy;
  const initialAngle = Math.random() * 360;
  
  if (isHorizontal) {
    // Start from random Y on left side, move right
    startX = -1000;
    startY = Math.random() * 1440;
    // Cross 2560px in 1100ms = ~2.33 px/ms = 116 px per 50ms
    vx = 116;
    vy = 0;
  } else {
    // Start from random X on top side, move down
    startX = Math.random() * 2560;
    startY = -1000;
    vx = 0;
    // Cross 1440px in 1100ms = 1.31 px/ms = 65.5 px per 50ms
    vy = 66;
  }
  
  const beam = {
    id: beamId,
    x: startX,
    y: startY,
    vx: vx,
    vy: vy,
    angle: initialAngle,
    rotationSpeed: 360 / (1040 / 50), // 360° in 1040ms = ~17.3° per 50ms
    startTime: now
  };
  
  xBeams.set(beamId, beam);
  io.emit('xBeamSpawned', beam);
}, 50);

// X Beam updater
setInterval(() => {
  const now = Date.now();
  
  xBeams.forEach((beam, id) => {
    // Move
    beam.x += beam.vx;
    beam.y += beam.vy;
    
    // Rotate
    beam.angle = (beam.angle + beam.rotationSpeed) % 360;
    
    // Remove if off screen or too old
    const age = now - beam.startTime;
    if (beam.x > 3560 || beam.y > 2440 || beam.x < -2000 || beam.y < -2000 || age > 3000) {
      xBeams.delete(id);
      io.emit('xBeamRemoved', { id });
      return;
    }
    
    // Broadcast update
    io.emit('xBeamUpdate', {
      id: beam.id,
      x: beam.x,
      y: beam.y,
      angle: beam.angle
    });
  });
}, 50);

