const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});
const fs = require('fs');
const path = require('path');

app.use(express.static(__dirname + '/public'));
app.use(express.json());
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

const players = new Map();
const bullets = new Map();
const bannedUsers = new Map();
const kickedUsers = new Map();
const npcs = new Map();
const npcDeaths = [];
const powerups = new Map();
const firingModes = new Map();

let npcIdCounter = 0;
let powerupIdCounter = 0;
let firingModeIdCounter = 0;
let clockActive = false;
let clockMode = 'off';
let clockAngle = 0;
let clockDirection = 1;
let xBeamActive = false;
let xMode = 'off';
const xBeams = new Map();
let xBeamIdCounter = 0;
let npcAutoSpawn = false;
let powerupAutoSpawn = false;
let lastEnemySpawn = 0;
let lastBossSpawn = 0;
let lastPowerupSpawn = 0;
let lastFiringModeSpawn = 0;
let playerDeathCount = new Map();
let activeFiringMode = null;
let firingModeEndTime = 0;

const BANNED_WORDS_FILE = path.join(__dirname, 'banned_words.json');
let BANNED_WORDS = ['rape','nigga','nigger','fuck','shit','bitch','cunt','whore','slut','gay','homo','pussy','dick','anal','onlyfans','cum','blowjob','porn'];

function loadBannedWords() {
  try {
    if (fs.existsSync(BANNED_WORDS_FILE)) {
      BANNED_WORDS = JSON.parse(fs.readFileSync(BANNED_WORDS_FILE, 'utf8'));
      console.log('Loaded banned words');
    }
  } catch (err) { console.error('Error loading banned words:', err); }
}

function saveBannedWords() {
  try {
    fs.writeFileSync(BANNED_WORDS_FILE, JSON.stringify(BANNED_WORDS, null, 2));
  } catch (err) { console.error('Error saving:', err); }
}

loadBannedWords();

const ADMIN_PASSWORD = '3310';

function containsProfanity(text) {
  return BANNED_WORDS.some(word => text.toLowerCase().includes(word));
}

function isUserBanned(username) {
  const lowerName = username.toLowerCase();
  if (bannedUsers.has(lowerName)) {
    const expiry = bannedUsers.get(lowerName);
    if (expiry === 'permanent') return true;
    if (Date.now() < expiry) return true;
    bannedUsers.delete(lowerName);
  }
  if (kickedUsers.has(lowerName)) {
    const expiry = kickedUsers.get(lowerName);
    if (Date.now() < expiry) return true;
    kickedUsers.delete(lowerName);
  }
  return false;
}

function getActivePlayers() {
  return Array.from(players.values()).filter(p => !p.name.startsWith('SPEC_'));
}

function checkPlayerWipeout() {
  const activePlayers = getActivePlayers();
  let allDead = activePlayers.length > 0;
  for (const player of activePlayers) {
    if ((playerDeathCount.get(player.id) || 0) < 3) {
      allDead = false;
      break;
    }
  }
  if (allDead) {
    npcs.forEach(npc => io.emit('npcRemoved', { npcId: npc.id }));
    npcs.clear();
    playerDeathCount.clear();
    console.log('All players wiped - NPCs cleared');
  }
}

function spawnPowerup(type) {
  const powerupId = `powerup_${powerupIdCounter++}`;
  const powerup = {
    id: powerupId,
    type: type,
    x: 400 + Math.random() * 1760,
    y: 400 + Math.random() * 640,
    spawnTime: Date.now()
  };
  powerups.set(powerupId, powerup);
  io.emit('powerupSpawned', powerup);
  console.log(`Spawned powerup: ${type}`);
  
  setTimeout(() => {
    if (powerups.has(powerupId)) {
      powerups.delete(powerupId);
      io.emit('powerupRemoved', { powerupId });
    }
  }, 45000);
}

function spawnFiringMode(type) {
  const modeId = `mode_${firingModeIdCounter++}`;
  const mode = {
    id: modeId,
    type: type,
    x: 400 + Math.random() * 1760,
    y: 400 + Math.random() * 640,
    spawnTime: Date.now()
  };
  firingModes.set(modeId, mode);
  io.emit('firingModeSpawned', mode);
  console.log(`Spawned firing mode: ${type}`);
  
  setTimeout(() => {
    if (firingModes.has(modeId)) {
      firingModes.delete(modeId);
      io.emit('firingModeRemoved', { modeId });
    }
  }, 45000);
}

function activateFiringMode(type) {
  activeFiringMode = type;
  firingModeEndTime = Date.now() + 60000;
  io.emit('firingModeActivated', { type, duration: 60000 });
  console.log(`Firing mode activated: ${type}`);
  
  setTimeout(() => {
    activeFiringMode = null;
    firingModeEndTime = 0;
    io.emit('firingModeDeactivated');
    console.log('Firing mode deactivated');
  }, 60000);
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.emit('fullGameState', {
    players: Array.from(players.values()),
    npcs: Array.from(npcs.values()),
    powerups: Array.from(powerups.values()),
    firingModes: Array.from(firingModes.values()),
    activeFiringMode: activeFiringMode,
    firingModeEndTime: firingModeEndTime,
    clockActive: clockActive,
    clockMode: clockMode,
    xBeamActive: xBeamActive,
    xMode: xMode,
    npcAutoSpawn: npcAutoSpawn,
    powerupAutoSpawn: powerupAutoSpawn
  });

  socket.on('join', (data) => {
    const { name, color } = data;
    if (!name || name.trim().length === 0) return socket.emit('joinError', 'Name cannot be empty');
    if (name.length > 20) return socket.emit('joinError', 'Name too long');
    if (containsProfanity(name)) return socket.emit('joinError', 'Inappropriate language');
    if (isUserBanned(name)) return socket.emit('joinError', 'You are banned');
    
    if (!name.startsWith('SPEC_')) {
      for (const player of players.values()) {
        if (player.name.toLowerCase() === name.toLowerCase()) {
          return socket.emit('joinError', 'Name taken');
        }
      }
    }

    const player = {
      id: socket.id, name, color, x: 0, y: 0, angle: 0, speed: 0,
      health: 6, maxHealth: 6, shield: 0, maxShield: 6,
      kills: 0, shipSize: 'small', lastDamageTime: Date.now(),
      firingMode: activeFiringMode
    };

    players.set(socket.id, player);
    socket.emit('joinSuccess', {
      playerId: socket.id,
      players: Array.from(players.values()),
      npcs: Array.from(npcs.values()),
      powerups: Array.from(powerups.values()),
      firingModes: Array.from(firingModes.values()),
      activeFiringMode: activeFiringMode,
      firingModeEndTime: firingModeEndTime
    });
    socket.broadcast.emit('playerJoined', player);
    npcs.forEach(npc => socket.emit('npcSpawned', npc));
    powerups.forEach(pu => socket.emit('powerupSpawned', pu));
    firingModes.forEach(fm => socket.emit('firingModeSpawned', fm));
  });

  socket.on('updatePlayer', (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    Object.assign(player, data);
    socket.broadcast.emit('playerMoved', { id: socket.id, ...data });
  });

  socket.on('shoot', (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    const bulletId = `${socket.id}_${Date.now()}_${Math.random()}`;
    const bullet = { 
      id: bulletId, 
      ...data, 
      color: player.color, 
      owner: socket.id, 
      createdAt: Date.now(),
      firingMode: data.firingMode || 'normal'
    };
    bullets.set(bulletId, bullet);
    io.emit('bulletFired', bullet);
    setTimeout(() => bullets.delete(bulletId), 5000);
  });

  socket.on('playerHit', (data) => {
    const victim = players.get(data.victimId);
    if (!victim) return;
    
    if (victim.shield > 0) {
      victim.shield--;
      io.emit('playerShieldDamaged', { victimId: data.victimId, shield: victim.shield });
    } else {
      victim.health--;
      victim.lastDamageTime = Date.now();
      io.emit('playerDamaged', { victimId: data.victimId, health: victim.health });
    }
    
    if (victim.health <= 0) {
      playerDeathCount.set(data.victimId, (playerDeathCount.get(data.victimId) || 0) + 1);
      
      let shooter = null;
      const sid = data.shooterId;
      if (sid !== 'clock' && sid !== 'xbeam' && !sid.startsWith('enemy_') && !sid.startsWith('boss_')) {
        shooter = players.get(sid);
      }
      
      if (shooter) {
        shooter.kills++;
        if (shooter.kills >= 6) shooter.shipSize = 'large';
        else if (shooter.kills >= 3) shooter.shipSize = 'medium';
        else shooter.shipSize = 'small';
        io.emit('playerDied', {
          victimId: data.victimId, killerId: sid,
          killerKills: shooter.kills, killerShipSize: shooter.shipSize
        });
      } else {
        io.emit('playerDied', {
          victimId: data.victimId, killerId: 'environment',
          killerKills: 0, killerShipSize: 'small'
        });
      }
      
      victim.kills = 0;
      victim.health = 6;
      victim.shield = 0;
      victim.shipSize = 'small';
      setTimeout(() => io.emit('forceRemoveShip', { playerId: data.victimId }), 100);
      checkPlayerWipeout();
    }
  });

  socket.on('respawn', (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    Object.assign(player, { x: data.x, y: data.y, angle: 0, speed: 0 });
    socket.broadcast.emit('playerRespawned', { id: socket.id, x: data.x, y: data.y });
  });

  socket.on('powerupPickup', (data) => {
    const player = players.get(socket.id);
    const powerup = powerups.get(data.powerupId);
    if (!player || !powerup) return;
    
    if (powerup.type === 'hp') {
      player.health = Math.min(player.health + 5, player.maxHealth);
      io.emit('playerHealthUpdate', { playerId: socket.id, health: player.health });
    } else if (powerup.type === 'max') {
      player.maxHealth += 2;
      player.health = Math.min(player.health, player.maxHealth);
      io.emit('playerMaxHealthUpdate', { playerId: socket.id, maxHealth: player.maxHealth, health: player.health });
    } else if (powerup.type === 'shield') {
      player.shield = Math.min(player.shield + 6, player.maxShield);
      io.emit('playerShieldUpdate', { playerId: socket.id, shield: player.shield });
    }
    
    powerups.delete(data.powerupId);
    io.emit('powerupRemoved', { powerupId: data.powerupId });
    console.log(`${player.name} picked up ${powerup.type}`);
  });

  socket.on('firingModePickup', (data) => {
    const mode = firingModes.get(data.modeId);
    if (!mode) return;
    
    activateFiringMode(mode.type);
    players.forEach(p => { p.firingMode = mode.type; });
    
    firingModes.delete(data.modeId);
    io.emit('firingModeRemoved', { modeId: data.modeId });
  });

  socket.on('npcHit', (data) => {
    const npc = npcs.get(data.npcId);
    const shooter = players.get(data.shooterId);
    if (!npc || !shooter) return;
    
    npc.health--;
    io.emit('npcDamaged', { npcId: data.npcId, health: npc.health });
    
    if (npc.health <= 0) {
      shooter.kills++;
      if (shooter.kills >= 6) shooter.shipSize = 'large';
      else if (shooter.kills >= 3) shooter.shipSize = 'medium';
      else shooter.shipSize = 'small';
      
      npcDeaths.push({
        npcType: npc.type, npcName: npc.type === 'boss' ? 'Boss' : 'Enemy',
        killerName: shooter.name, timestamp: Date.now()
      });
      
      npcs.delete(data.npcId);
      io.emit('npcDied', {
        npcId: data.npcId, killerId: data.shooterId,
        killerKills: shooter.kills, killerShipSize: shooter.shipSize
      });
      
      io.sockets.sockets.forEach(s => {
        if (s.isAdmin) s.emit('adminNPCList', {
          npcs: Array.from(npcs.values()), deaths: npcDeaths
        });
      });
    }
  });

  socket.on('adminLogin', (password) => {
    if (password === ADMIN_PASSWORD) {
      socket.emit('adminAuthenticated');
      socket.isAdmin = true;
    } else {
      socket.emit('adminError', 'Invalid password');
    }
  });

  socket.on('adminGetPlayers', () => {
    if (!socket.isAdmin) return;
    socket.emit('adminPlayerList', {
      players: getActivePlayers(),
      banned: Array.from(bannedUsers.entries()),
      kicked: Array.from(kickedUsers.entries())
    });
  });

  socket.on('adminKick', (targetName) => {
    if (!socket.isAdmin) return;
    kickedUsers.set(targetName.toLowerCase(), Date.now() + 86400000);
    for (const [id, player] of players.entries()) {
      if (player.name.toLowerCase() === targetName.toLowerCase()) {
        io.to(id).emit('kicked', 'Kicked for 24h');
        io.sockets.sockets.get(id)?.disconnect(true);
        break;
      }
    }
    socket.emit('adminActionSuccess', `Kicked ${targetName}`);
  });

  socket.on('adminBan', (targetName) => {
    if (!socket.isAdmin) return;
    bannedUsers.set(targetName.toLowerCase(), 'permanent');
    for (const [id, player] of players.entries()) {
      if (player.name.toLowerCase() === targetName.toLowerCase()) {
        io.to(id).emit('banned', 'Permanently banned');
        io.sockets.sockets.get(id)?.disconnect(true);
        break;
      }
    }
    socket.emit('adminActionSuccess', `Banned ${targetName}`);
  });

  socket.on('adminGetBannedWords', () => {
    if (!socket.isAdmin) return;
    socket.emit('bannedWordsUpdate', BANNED_WORDS);
  });

  socket.on('adminAddBannedWord', (word) => {
    if (!socket.isAdmin) return;
    const w = word.toLowerCase().trim();
    if (!w || BANNED_WORDS.includes(w)) return;
    BANNED_WORDS.push(w);
    saveBannedWords();
    socket.emit('bannedWordsUpdate', BANNED_WORDS);
    socket.emit('adminActionSuccess', `Added "${w}"`);
  });

  socket.on('adminRemoveBannedWord', (word) => {
    if (!socket.isAdmin) return;
    const idx = BANNED_WORDS.indexOf(word.toLowerCase());
    if (idx > -1) {
      BANNED_WORDS.splice(idx, 1);
      saveBannedWords();
      socket.emit('bannedWordsUpdate', BANNED_WORDS);
      socket.emit('adminActionSuccess', `Removed "${word}"`);
    }
  });

  socket.on('adminSpawnEnemy', () => {
    if (!socket.isAdmin) return;
    spawnEnemy();
    socket.emit('adminActionSuccess', 'Enemy spawned');
  });

  socket.on('adminSpawnBoss', () => {
    if (!socket.isAdmin) return;
    spawnBoss();
    socket.emit('adminActionSuccess', 'Boss spawned');
  });

  socket.on('adminDeleteNPC', (npcId) => {
    if (!socket.isAdmin) return;
    const npc = npcs.get(npcId);
    if (npc) {
      npcs.delete(npcId);
      io.emit('npcRemoved', { npcId });
      socket.emit('adminNPCList', {
        npcs: Array.from(npcs.values()), deaths: npcDeaths
      });
    }
  });

  socket.on('adminDeleteAllNPCs', () => {
    if (!socket.isAdmin) return;
    const count = npcs.size;
    npcs.forEach(npc => io.emit('npcRemoved', { npcId: npc.id }));
    npcs.clear();
    socket.emit('adminActionSuccess', `Deleted ${count} NPCs`);
    socket.emit('adminNPCList', { npcs: [], deaths: npcDeaths });
  });

  socket.on('adminGetNPCs', () => {
    if (!socket.isAdmin) return;
    socket.emit('adminNPCList', {
      npcs: Array.from(npcs.values()), deaths: npcDeaths
    });
  });

  socket.on('adminClearDeaths', () => {
    if (!socket.isAdmin) return;
    npcDeaths.length = 0;
    socket.emit('adminNPCList', { npcs: Array.from(npcs.values()), deaths: [] });
  });

  socket.on('adminToggleClock', () => {
    if (!socket.isAdmin) return;
    if (clockMode === 'off') { clockMode = 'on'; clockActive = true; clockAngle = 0; }
    else if (clockMode === 'on') { clockMode = 'auto'; clockActive = true; }
    else { clockMode = 'off'; clockActive = false; }
    io.sockets.sockets.forEach(s => {
      if (s.isAdmin) s.emit('adminClockStatus', { mode: clockMode });
    });
  });

  socket.on('adminToggleX', () => {
    if (!socket.isAdmin) return;
    if (xMode === 'off') { xMode = 'on'; xBeamActive = true; }
    else if (xMode === 'on') { xMode = 'auto'; xBeamActive = true; }
    else {
      xMode = 'off'; xBeamActive = false;
      xBeams.forEach(b => io.emit('xBeamRemoved', { id: b.id }));
      xBeams.clear();
    }
    io.sockets.sockets.forEach(s => {
      if (s.isAdmin) s.emit('adminXStatus', { mode: xMode });
    });
  });

  socket.on('adminToggleNPCAutoSpawn', () => {
    if (!socket.isAdmin) return;
    npcAutoSpawn = !npcAutoSpawn;
    if (npcAutoSpawn) {
      lastEnemySpawn = Date.now();
      lastBossSpawn = 0;
    }
    socket.emit('adminNPCAutoStatus', { active: npcAutoSpawn });
  });

  socket.on('adminTogglePowerupAutoSpawn', () => {
    if (!socket.isAdmin) return;
    powerupAutoSpawn = !powerupAutoSpawn;
    if (powerupAutoSpawn) {
      lastPowerupSpawn = Date.now();
      lastFiringModeSpawn = Date.now();
    }
    socket.emit('adminPowerupAutoStatus', { active: powerupAutoSpawn });
  });

  socket.on('adminSpawnPowerup', (type) => {
    if (!socket.isAdmin) return;
    spawnPowerup(type);
  });

  socket.on('adminSpawnFiringMode', (type) => {
    if (!socket.isAdmin) return;
    spawnFiringMode(type);
  });

  socket.on('disconnect', () => {
    const player = players.get(socket.id);
    if (player) {
      players.delete(socket.id);
      playerDeathCount.delete(socket.id);
      io.emit('playerLeft', socket.id);
    }
  });
});

function spawnEnemy() {
  const npcId = `enemy_${npcIdCounter++}`;
  const angle = Math.random() * Math.PI * 2;
  const npc = {
    id: npcId, type: 'enemy', name: 'Enemy',
    x: 1280 + Math.cos(angle) * 500, y: 720 + Math.sin(angle) * 500,
    angle: Math.random() * 360, speed: 0,
    health: 6, maxHealth: 6, color: '#ff0000',
    target: null, lastShot: 0
  };
  npcs.set(npcId, npc);
  io.emit('npcSpawned', npc);
}

function spawnBoss() {
  const npcId = `boss_${npcIdCounter++}`;
  const angle = Math.random() * Math.PI * 2;
  const npc = {
    id: npcId, type: 'boss', name: 'Boss',
    x: 1280 + Math.cos(angle) * 500, y: 720 + Math.sin(angle) * 500,
    angle: Math.random() * 360, speed: 0,
    health: 25, maxHealth: 25, color: '#ff0000',
    target: null, lastShot: 0
  };
  npcs.set(npcId, npc);
  io.emit('npcSpawned', npc);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));

setInterval(() => {
  const now = Date.now();
  players.forEach(p => {
    if (!p.name.startsWith('SPEC_') && p.health < p.maxHealth && (now - p.lastDamageTime) >= 120000) {
      p.health = p.maxHealth;
      io.emit('playerHealthRegen', { playerId: p.id, health: p.health });
    }
  });
}, 5000);

setInterval(() => {
  if (npcs.size === 0) return;
  const playerList = getActivePlayers();
  if (playerList.length === 0) return;
  
  npcs.forEach(npc => {
    if (!npc.target || !players.has(npc.target)) {
      const counts = new Map();
      npcs.forEach(n => { if (n.target) counts.set(n.target, (counts.get(n.target) || 0) + 1); });
      let best = playerList[0].id;
      let min = counts.get(best) || 0;
      playerList.forEach(p => {
        const c = counts.get(p.id) || 0;
        if (c < min) { min = c; best = p.id; }
      });
      npc.target = best;
    }
    
    const target = players.get(npc.target);
    if (!target) return;
    
    const dx = target.x - npc.x;
    const dy = target.y - npc.y;
    const targetAngle = Math.atan2(dx, -dy) * 180 / Math.PI;
    let diff = targetAngle - npc.angle;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    
    if (Math.abs(diff) > 5) npc.angle += Math.sign(diff) * 3;
    
    if (Math.random() < 0.4) npc.speed = Math.min(npc.speed + 0.4, 4);
    else npc.speed *= 0.96;
    
    const rad = npc.angle * Math.PI / 180;
    npc.x += Math.sin(rad) * npc.speed;
    npc.y -= Math.cos(rad) * npc.speed;
    
    if (npc.x < 0) npc.x = 2560;
    if (npc.x > 2560) npc.x = 0;
    if (npc.y < 0) npc.y = 1440;
    if (npc.y > 1440) npc.y = 0;
    
    const now = Date.now();
    if (Math.abs(diff) < 20 && now - npc.lastShot > 800) {
      npc.lastShot = now;
      const bullet = {
        id: `${npc.id}_${now}`,
        x: npc.x + Math.sin(rad) * 25,
        y: npc.y - Math.cos(rad) * 25,
        vx: Math.sin(rad) * 8,
        vy: -Math.cos(rad) * 8,
        color: npc.color,
        owner: npc.id
      };
      bullets.set(bullet.id, bullet);
      io.emit('bulletFired', bullet);
      setTimeout(() => bullets.delete(bullet.id), 5000);
    }
  });
  
  io.emit('npcUpdate', Array.from(npcs.values()).map(n => ({
    id: n.id, x: n.x, y: n.y, angle: n.angle
  })));
}, 30);

setInterval(() => {
  if (!npcAutoSpawn) return;
  const active = getActivePlayers();
  if (active.length === 0) return;
  
  const now = Date.now();
  const spawnRate = activeFiringMode ? 30000 : 60000;
  
  if (now - lastEnemySpawn >= spawnRate) {
    spawnEnemy();
    lastEnemySpawn = now;
    if (lastBossSpawn === 0) lastBossSpawn = now;
  }
  if (lastBossSpawn > 0 && now - lastBossSpawn >= 180000) {
    spawnBoss();
    lastBossSpawn = now;
  }
}, 5000);

setInterval(() => {
  if (!powerupAutoSpawn) return;
  const now = Date.now();
  
  if (now - lastPowerupSpawn >= 72000) {
    const types = ['hp', 'max', 'shield'];
    const type = types[Math.floor(Math.random() * types.length)];
    spawnPowerup(type);
    lastPowerupSpawn = now;
  }
  
  if (now - lastFiringModeSpawn >= 150000) {
    const modes = ['machinegun', 'pumpshotgun', 'laserbeam'];
    const mode = modes[Math.floor(Math.random() * modes.length)];
    spawnFiringMode(mode);
    lastFiringModeSpawn = now;
  }
}, 5000);

setInterval(() => {
  if (!clockActive) return;
  clockAngle += clockDirection * 10;
  if (clockAngle >= 180) { clockAngle = 180; clockDirection = -1; }
  else if (clockAngle <= 0) { clockAngle = 0; clockDirection = 1; }
  
  const startX = 1280;
  const startY = 1440;
  const radians = clockAngle * Math.PI / 180;
  
  const bulletId = `clock_${Date.now()}_${Math.random()}`;
  const bullet = {
    id: bulletId,
    x: startX,
    y: startY,
    vx: Math.cos(radians) * 8,
    vy: -Math.sin(radians) * 8,
    color: '#ff0000',
    owner: 'clock'
  };
  io.emit('clockBullet', bullet);
}, 100);

let lastXSpawn = 0;
setInterval(() => {
  if (!xBeamActive) return;
  const now = Date.now();
  if (now - lastXSpawn < 2000) return;
  lastXSpawn = now;
  
  const isH = Math.random() < 0.5;
  const beam = {
    id: `xbeam_${xBeamIdCounter++}`,
    x: isH ? -500 : Math.random() * 2560,
    y: isH ? Math.random() * 1440 : -500,
    vx: isH ? 70 : 0,
    vy: isH ? 0 : 40,
    angle: Math.random() * 360,
    rotationSpeed: 360 / (1040 / 50),
    startTime: now
  };
  xBeams.set(beam.id, beam);
  io.emit('xBeamSpawned', beam);
}, 50);

setInterval(() => {
  const now = Date.now();
  xBeams.forEach((b, id) => {
    b.x += b.vx;
    b.y += b.vy;
    b.angle = (b.angle + b.rotationSpeed) % 360;
    if (b.x > 3560 || b.y > 2440 || b.x < -2000 || b.y < -2000 || (now - b.startTime) > 5000) {
      xBeams.delete(id);
      io.emit('xBeamRemoved', { id });
      return;
    }
    io.emit('xBeamUpdate', { id: b.id, x: b.x, y: b.y, angle: b.angle });
  });
}, 50);

setInterval(() => {
  const playerStates = Array.from(players.values()).map(p => ({
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    angle: p.angle,
    health: p.health,
    maxHealth: p.maxHealth,
    shield: p.shield,
    kills: p.kills,
    shipSize: p.shipSize,
    color: p.color
  }));
  io.emit('playerStateSync', playerStates);

  const now = Date.now();
  bullets.forEach((bullet, id) => {
    if (now - (bullet.createdAt || now) > 6000) {
      bullets.delete(id);
    }
  });

  const npcIds = Array.from(npcs.keys());
  io.emit('npcListSync', npcIds);
}, 2000);

setInterval(() => {
  io.sockets.sockets.forEach(socket => {
    if (socket.isAdmin) {
      socket.emit('adminNPCList', {
        npcs: Array.from(npcs.values()),
        deaths: npcDeaths
      });
      socket.emit('adminPlayerList', {
        players: getActivePlayers(),
        banned: Array.from(bannedUsers.entries()),
        kicked: Array.from(kickedUsers.entries())
      });
      socket.emit('adminClockStatus', { mode: clockMode });
      socket.emit('adminXStatus', { mode: xMode });
      socket.emit('adminNPCAutoStatus', { active: npcAutoSpawn });
      socket.emit('adminPowerupAutoStatus', { active: powerupAutoSpawn });
    }
  });
}, 1000);
