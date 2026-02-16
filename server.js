const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game Constants ───
const TICK_RATE = 60;
const MAP_WIDTH = 1600;
const MAP_HEIGHT = 600;
const GROUND_Y = 420;
const PLAYER_W = 30;
const PLAYER_H = 50;
const PLAYER_CROUCH_H = 28;
const GRAVITY = 0.6;
const JUMP_FORCE = -12;
const MOVE_SPEED = 4;
const BULLET_SPEED = 12;
const BULLET_DAMAGE = 15;
const RESPAWN_TIME = 3000;

// Trench zones (x ranges where crouching is allowed)
const TRENCH_LEFT = { x1: 50, x2: 350, depth: 40 };
const TRENCH_RIGHT = { x1: 1250, x2: 1550, depth: 40 };

// ─── Room State ───
const rooms = {};

function createRoom(roomId) {
  return {
    id: roomId,
    players: {},
    bullets: [],
    scores: { bulls: 0, bears: 0 },
    lastTick: Date.now()
  };
}

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = createRoom(roomId);
  }
  return rooms[roomId];
}

function assignTeam(room) {
  let bulls = 0, bears = 0;
  for (const pid in room.players) {
    if (room.players[pid].team === 'bulls') bulls++;
    else bears++;
  }
  return bulls <= bears ? 'bulls' : 'bears';
}

function isInTrench(x) {
  return (x >= TRENCH_LEFT.x1 && x <= TRENCH_LEFT.x2) ||
         (x >= TRENCH_RIGHT.x1 && x <= TRENCH_RIGHT.x2);
}

function spawnPosition(team) {
  if (team === 'bulls') {
    return { x: 100 + Math.random() * 200, y: GROUND_Y - PLAYER_H };
  } else {
    return { x: 1300 + Math.random() * 200, y: GROUND_Y - PLAYER_H };
  }
}

function createPlayer(id, team) {
  const pos = spawnPosition(team);
  return {
    id,
    team,
    x: pos.x,
    y: pos.y,
    vx: 0,
    vy: 0,
    hp: 100,
    alive: true,
    crouching: false,
    jumping: false,
    onGround: true,
    facing: team === 'bulls' ? 1 : -1,
    inputs: { left: false, right: false, up: false, down: false },
    lastShot: 0,
    respawnAt: 0
  };
}

// ─── Physics Tick ───
function tickRoom(room) {
  const now = Date.now();
  room.lastTick = now;

  // Update players
  for (const pid in room.players) {
    const p = room.players[pid];

    if (!p.alive) {
      if (p.respawnAt && now >= p.respawnAt) {
        const pos = spawnPosition(p.team);
        p.x = pos.x;
        p.y = pos.y;
        p.vx = 0;
        p.vy = 0;
        p.hp = 100;
        p.alive = true;
        p.crouching = false;
        p.respawnAt = 0;
      }
      continue;
    }

    // Horizontal movement
    p.vx = 0;
    if (p.inputs.left) { p.vx = -MOVE_SPEED; p.facing = -1; }
    if (p.inputs.right) { p.vx = MOVE_SPEED; p.facing = 1; }

    // Crouching — only in trench
    p.crouching = p.inputs.down && isInTrench(p.x + PLAYER_W / 2) && p.onGround;

    // Jumping
    if (p.inputs.up && p.onGround && !p.crouching) {
      p.vy = JUMP_FORCE;
      p.onGround = false;
    }

    // Gravity
    p.vy += GRAVITY;

    // Apply velocity
    p.x += p.vx;
    p.y += p.vy;

    // Ground collision
    const groundLevel = GROUND_Y - (p.crouching ? PLAYER_CROUCH_H : PLAYER_H);
    // If in trench and crouching, player sinks into trench
    const inTrench = isInTrench(p.x + PLAYER_W / 2);
    const effectiveGround = inTrench && p.crouching
      ? GROUND_Y - PLAYER_CROUCH_H + TRENCH_LEFT.depth
      : GROUND_Y - (p.crouching ? PLAYER_CROUCH_H : PLAYER_H);

    if (p.y >= effectiveGround) {
      p.y = effectiveGround;
      p.vy = 0;
      p.onGround = true;
    }

    // Clamp to map
    if (p.x < 0) p.x = 0;
    if (p.x > MAP_WIDTH - PLAYER_W) p.x = MAP_WIDTH - PLAYER_W;
  }

  // Update bullets
  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const b = room.bullets[i];
    b.x += b.vx;

    // Off screen
    if (b.x < -20 || b.x > MAP_WIDTH + 20) {
      room.bullets.splice(i, 1);
      continue;
    }

    // Hit detection
    let hit = false;
    for (const pid in room.players) {
      const p = room.players[pid];
      if (!p.alive || p.id === b.ownerId || p.team === b.team) continue;

      const pH = p.crouching ? PLAYER_CROUCH_H : PLAYER_H;
      const pTop = p.y;
      const pBot = p.y + pH;
      const pLeft = p.x;
      const pRight = p.x + PLAYER_W;

      // Bullet y is at shooting height
      if (b.x >= pLeft && b.x <= pRight && b.y >= pTop && b.y <= pBot) {
        // If crouching in trench, bullet only hits if it's in the head zone (top 12px)
        if (p.crouching && isInTrench(p.x + PLAYER_W / 2)) {
          const headBottom = pTop + 12;
          if (b.y > headBottom) {
            continue; // bullet passes over
          }
        }
        p.hp -= BULLET_DAMAGE;
        hit = true;

        // Notify hit
        io.to(room.id).emit('player_hit', { playerId: p.id, hp: p.hp, shooterId: b.ownerId });

        if (p.hp <= 0) {
          p.hp = 0;
          p.alive = false;
          p.respawnAt = now + RESPAWN_TIME;
          if (b.team === 'bulls') room.scores.bulls++;
          else room.scores.bears++;
          io.to(room.id).emit('player_killed', { playerId: p.id, killerId: b.ownerId, scores: room.scores });
        }
        break;
      }
    }
    if (hit) {
      room.bullets.splice(i, 1);
    }
  }

  // Broadcast state
  const state = {
    players: {},
    bullets: room.bullets.map(b => ({ x: b.x, y: b.y, team: b.team })),
    scores: room.scores
  };
  for (const pid in room.players) {
    const p = room.players[pid];
    state.players[pid] = {
      id: p.id,
      team: p.team,
      x: p.x,
      y: p.y,
      hp: p.hp,
      alive: p.alive,
      crouching: p.crouching,
      facing: p.facing
    };
  }
  io.to(room.id).emit('game_state', state);
}

// ─── Socket Handling ───
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerId = socket.id;

  socket.on('join_room', (roomId) => {
    if (currentRoom) {
      socket.leave(currentRoom);
      const oldRoom = rooms[currentRoom];
      if (oldRoom) {
        delete oldRoom.players[playerId];
        io.to(currentRoom).emit('player_left', playerId);
      }
    }

    currentRoom = roomId;
    socket.join(roomId);
    const room = getRoom(roomId);
    const team = assignTeam(room);
    room.players[playerId] = createPlayer(playerId, team);

    socket.emit('joined', {
      id: playerId,
      team,
      mapWidth: MAP_WIDTH,
      mapHeight: MAP_HEIGHT,
      groundY: GROUND_Y,
      trenchLeft: TRENCH_LEFT,
      trenchRight: TRENCH_RIGHT,
      playerW: PLAYER_W,
      playerH: PLAYER_H,
      playerCrouchH: PLAYER_CROUCH_H
    });

    io.to(roomId).emit('player_joined', { id: playerId, team });
  });

  socket.on('player_input', (inputs) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players[playerId];
    if (!player || !player.alive) return;
    player.inputs = inputs;
  });

  socket.on('player_shoot', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players[playerId];
    if (!player || !player.alive) return;

    const now = Date.now();
    if (now - player.lastShot < 250) return; // fire rate limit
    player.lastShot = now;

    const pH = player.crouching ? PLAYER_CROUCH_H : PLAYER_H;
    const bulletY = player.y + pH * 0.3; // shoot from upper body
    const bulletX = player.facing === 1 ? player.x + PLAYER_W : player.x;

    room.bullets.push({
      x: bulletX,
      y: bulletY,
      vx: BULLET_SPEED * player.facing,
      ownerId: playerId,
      team: player.team
    });

    io.to(currentRoom).emit('player_shot', {
      playerId,
      x: bulletX,
      y: bulletY,
      facing: player.facing,
      team: player.team
    });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom].players[playerId];
      io.to(currentRoom).emit('player_left', playerId);

      // Clean up empty rooms
      if (Object.keys(rooms[currentRoom].players).length === 0) {
        delete rooms[currentRoom];
      }
    }
  });
});

// ─── Game Loop ───
setInterval(() => {
  for (const roomId in rooms) {
    tickRoom(rooms[roomId]);
  }
}, 1000 / TICK_RATE);

// ─── Start Server ───
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Market Warfare: The Trenches — Server running on port ${PORT}`);
});
