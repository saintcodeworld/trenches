// ─── Market Warfare: The Trenches — Client ───
(function () {
  'use strict';

  const socket = io();

  // ─── DOM refs ───
  const lobby = document.getElementById('lobby');
  const gameContainer = document.getElementById('game-container');
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const roomInput = document.getElementById('room-input');
  const joinBtn = document.getElementById('join-btn');
  const scoreboard = document.getElementById('scoreboard');
  const scoreBulls = document.getElementById('score-bulls');
  const scoreBears = document.getElementById('score-bears');
  const hud = document.getElementById('hud');
  const teamBadge = document.getElementById('team-badge');
  const hpBar = document.getElementById('hp-bar');
  const hpText = document.getElementById('hp-text');
  const killFeed = document.getElementById('kill-feed');
  const respawnOverlay = document.getElementById('respawn-overlay');
  const roomInfo = document.getElementById('room-info');
  const roomIdDisplay = document.getElementById('room-id-display');

  // ─── Game state ───
  let myId = null;
  let myTeam = null;
  let serverState = { players: {}, bullets: [], scores: { bulls: 0, bears: 0 } };
  let config = {};
  let joined = false;

  // Client-side prediction state
  let localPlayer = null;
  let inputs = { left: false, right: false, up: false, down: false };
  let pendingInputs = [];
  let inputSeq = 0;

  // Visual effects
  let muzzleFlashes = [];
  let hitMarkers = [];
  let deathParticles = [];

  // Camera
  let camera = { x: 0, y: 0 };

  // ─── Lobby ───
  joinBtn.addEventListener('click', joinRoom);
  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
  });

  function joinRoom() {
    const roomId = roomInput.value.trim().toUpperCase();
    if (!roomId) return;
    socket.emit('join_room', roomId);
  }

  socket.on('joined', (data) => {
    myId = data.id;
    myTeam = data.team;
    config = data;
    joined = true;

    lobby.style.display = 'none';
    gameContainer.style.display = 'block';
    scoreboard.style.display = 'flex';
    hud.style.display = 'flex';
    roomInfo.style.display = 'block';
    roomIdDisplay.textContent = roomInput.value.trim().toUpperCase();

    // Team badge
    teamBadge.textContent = myTeam.toUpperCase();
    teamBadge.className = 'team-badge ' + (myTeam === 'bulls' ? 'badge-bulls' : 'badge-bears');

    resizeCanvas();
    requestAnimationFrame(gameLoop);
  });

  // ─── Resize ───
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCanvas);

  // ─── Input ───
  const keyMap = {
    'ArrowLeft': 'left', 'a': 'left', 'A': 'left',
    'ArrowRight': 'right', 'd': 'right', 'D': 'right',
    'ArrowUp': 'up', 'w': 'up', 'W': 'up',
    'ArrowDown': 'down', 's': 'down', 'S': 'down'
  };

  document.addEventListener('keydown', (e) => {
    if (!joined) return;
    const action = keyMap[e.key];
    if (action && !inputs[action]) {
      inputs[action] = true;
      socket.emit('player_input', inputs);
    }
    if (e.key === ' ' || e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      socket.emit('player_shoot');
    }
  });

  document.addEventListener('keyup', (e) => {
    if (!joined) return;
    const action = keyMap[e.key];
    if (action && inputs[action]) {
      inputs[action] = false;
      socket.emit('player_input', inputs);
    }
  });

  // ─── Server Events ───
  socket.on('game_state', (state) => {
    serverState = state;

    // Update scores
    scoreBulls.textContent = state.scores.bulls;
    scoreBears.textContent = state.scores.bears;

    // Update HUD
    const me = state.players[myId];
    if (me) {
      hpBar.style.width = me.hp + '%';
      hpBar.style.background = me.hp > 50 ? '#00ff41' : me.hp > 25 ? '#ffaa00' : '#ff4444';
      hpText.textContent = me.hp + ' HP';

      // Respawn overlay
      if (!me.alive) {
        respawnOverlay.style.display = 'flex';
      } else {
        respawnOverlay.style.display = 'none';
      }

      localPlayer = me;
    }
  });

  socket.on('player_shot', (data) => {
    muzzleFlashes.push({
      x: data.x,
      y: data.y,
      facing: data.facing,
      team: data.team,
      time: performance.now(),
      duration: 80
    });
  });

  socket.on('player_hit', (data) => {
    hitMarkers.push({
      x: serverState.players[data.playerId]?.x || 0,
      y: serverState.players[data.playerId]?.y || 0,
      time: performance.now(),
      duration: 300
    });
  });

  socket.on('player_killed', (data) => {
    const victim = serverState.players[data.playerId];
    if (victim) {
      for (let i = 0; i < 15; i++) {
        deathParticles.push({
          x: victim.x + 15,
          y: victim.y + 25,
          vx: (Math.random() - 0.5) * 6,
          vy: (Math.random() - 0.5) * 6 - 3,
          life: 1.0,
          color: victim.team === 'bulls' ? '#00ff41' : '#ff4444'
        });
      }
    }

    // Kill feed
    const killerTeam = serverState.players[data.killerId]?.team || 'bulls';
    const msg = document.createElement('div');
    msg.className = 'kill-msg';
    const kColor = killerTeam === 'bulls' ? '#00ff41' : '#ff4444';
    const vColor = data.playerId === myId ? '#fff' : (victim?.team === 'bulls' ? '#00ff41' : '#ff4444');
    const killerId = data.killerId === myId ? 'YOU' : data.killerId.slice(0, 6);
    const victimId = data.playerId === myId ? 'YOU' : data.playerId.slice(0, 6);
    msg.innerHTML = `<span style="color:${kColor}">${killerId}</span> ► <span style="color:${vColor}">${victimId}</span>`;
    killFeed.appendChild(msg);
    setTimeout(() => msg.remove(), 4000);
  });

  // ─── Rendering ───
  const GRASS_COLORS = ['#3a8c3a', '#2d7a2d', '#45a045', '#339933'];

  function drawSky(w, h) {
    // Gradient sky matching the image — hazy blue
    const grad = ctx.createLinearGradient(0, 0, 0, h * 0.55);
    grad.addColorStop(0, '#5b7ea8');
    grad.addColorStop(0.5, '#7a9dbd');
    grad.addColorStop(1, '#8aaa8a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h * 0.55);
  }

  function drawGrass(w, h, groundScreenY) {
    // Vibrant green grass below the battlefield
    const grassTop = groundScreenY + 30;
    const grad = ctx.createLinearGradient(0, grassTop, 0, h);
    grad.addColorStop(0, '#3d8b3d');
    grad.addColorStop(1, '#2a6e2a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, grassTop, w, h - grassTop);

    // Mower lines
    ctx.globalAlpha = 0.15;
    for (let y = grassTop; y < h; y += 12) {
      ctx.fillStyle = y % 24 < 12 ? '#4aa04a' : '#2d7a2d';
      ctx.fillRect(0, y, w, 6);
    }
    ctx.globalAlpha = 1.0;

    // Diagonal mower pattern
    ctx.globalAlpha = 0.06;
    ctx.strokeStyle = '#5ab85a';
    ctx.lineWidth = 2;
    for (let x = -h; x < w + h; x += 20) {
      ctx.beginPath();
      ctx.moveTo(x, grassTop);
      ctx.lineTo(x + (h - grassTop), h);
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;
  }

  function drawTrench(trench, groundScreenY) {
    const tx = trench.x1 - camera.x;
    const tw = trench.x2 - trench.x1;

    // Trench hole
    ctx.fillStyle = '#3d2b1a';
    ctx.fillRect(tx, groundScreenY - 5, tw, trench.depth + 10);

    // Darker bottom
    ctx.fillStyle = '#2a1d10';
    ctx.fillRect(tx + 5, groundScreenY + trench.depth - 10, tw - 10, 15);

    // Earth rim / dirt piles
    ctx.fillStyle = '#5a3d2b';
    // Left pile
    drawDirtPile(tx - 15, groundScreenY - 15, 40, 20);
    drawDirtPile(tx + tw - 20, groundScreenY - 18, 45, 22);

    // Sandbags on top edges
    ctx.fillStyle = '#8a7a5a';
    for (let i = 0; i < 3; i++) {
      drawSandbag(tx + 5 + i * 22, groundScreenY - 14);
      drawSandbag(tx + tw - 25 - i * 22, groundScreenY - 14);
    }

    // Wooden supports inside trench
    ctx.fillStyle = '#5a4030';
    ctx.fillRect(tx + 10, groundScreenY - 2, 4, trench.depth + 5);
    ctx.fillRect(tx + tw - 14, groundScreenY - 2, 4, trench.depth + 5);
    ctx.fillRect(tx + 10, groundScreenY - 2, tw - 20, 3);
  }

  function drawDirtPile(x, y, w, h) {
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.quadraticCurveTo(x + w / 2, y - h * 0.3, x + w, y + h);
    ctx.fill();
  }

  function drawSandbag(x, y) {
    ctx.fillStyle = '#8a7a5a';
    const r = 4;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + 18 - r, y);
    ctx.quadraticCurveTo(x + 18, y, x + 18, y + r);
    ctx.lineTo(x + 18, y + 10 - r);
    ctx.quadraticCurveTo(x + 18, y + 10, x + 18 - r, y + 10);
    ctx.lineTo(x + r, y + 10);
    ctx.quadraticCurveTo(x, y + 10, x, y + 10 - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.fill();
    // Tie line
    ctx.strokeStyle = '#6a5a3a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 9, y);
    ctx.lineTo(x + 9, y + 10);
    ctx.stroke();
  }

  function drawGround(w, groundScreenY) {
    // Main ground strip
    const grad = ctx.createLinearGradient(0, groundScreenY - 30, 0, groundScreenY + 35);
    grad.addColorStop(0, '#4a8a4a');
    grad.addColorStop(0.3, '#3d7a3d');
    grad.addColorStop(0.5, '#6b4a2a');
    grad.addColorStop(1, '#5a3d20');
    ctx.fillStyle = grad;
    ctx.fillRect(0, groundScreenY - 30, w, 65);

    // Grass tufts on top
    ctx.fillStyle = '#4a9a4a';
    for (let x = 0; x < w; x += 8) {
      const h = 3 + Math.sin(x * 0.3) * 2;
      ctx.fillRect(x, groundScreenY - 30 - h, 3, h);
    }
  }

  function drawBarbedWire(groundScreenY) {
    const centerX = config.mapWidth / 2 - camera.x;

    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1.5;

    // X-shaped barriers
    for (let i = -2; i <= 2; i++) {
      const bx = centerX + i * 50;
      const by = groundScreenY - 30;

      // Wooden X post
      ctx.strokeStyle = '#5a4030';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(bx - 12, by);
      ctx.lineTo(bx + 12, by - 30);
      ctx.moveTo(bx + 12, by);
      ctx.lineTo(bx - 12, by - 30);
      ctx.stroke();

      // Wire
      ctx.strokeStyle = '#666';
      ctx.lineWidth = 1;
      if (i < 2) {
        const nbx = centerX + (i + 1) * 50;
        for (let wy = 0; wy < 3; wy++) {
          ctx.beginPath();
          ctx.moveTo(bx + 12, by - 8 - wy * 10);
          const cp1y = by - 12 - wy * 10 + Math.sin(i + wy) * 4;
          ctx.quadraticCurveTo((bx + nbx) / 2, cp1y, nbx - 12, by - 8 - wy * 10);
          ctx.stroke();
        }
      }

      // Barbs
      ctx.fillStyle = '#888';
      for (let b = 0; b < 4; b++) {
        const bxp = bx - 8 + b * 6;
        const byp = by - 10 - b * 5;
        ctx.fillRect(bxp, byp, 2, 2);
      }
    }
  }

  function drawPlayer(p) {
    const px = p.x - camera.x;
    const pH = p.crouching ? config.playerCrouchH : config.playerH;
    const py = p.y;

    if (!p.alive) return;

    const isBull = p.team === 'bulls';
    const baseColor = isBull ? '#2d8a2d' : '#aa2222';
    const darkColor = isBull ? '#1a5a1a' : '#771515';
    const lightColor = isBull ? '#44bb44' : '#dd4444';
    const skinColor = '#d4a574';

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(px + config.playerW / 2, p.y + pH + 2, 14, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Legs
    ctx.fillStyle = darkColor;
    if (p.crouching) {
      // Crouching legs — folded
      ctx.fillRect(px + 4, py + pH - 10, 8, 10);
      ctx.fillRect(px + 18, py + pH - 10, 8, 10);
    } else {
      ctx.fillRect(px + 6, py + pH - 18, 7, 18);
      ctx.fillRect(px + 17, py + pH - 18, 7, 18);
    }

    // Boots
    ctx.fillStyle = '#2a2a2a';
    if (!p.crouching) {
      ctx.fillRect(px + 4, py + pH - 4, 10, 4);
      ctx.fillRect(px + 16, py + pH - 4, 10, 4);
    }

    // Body / torso
    ctx.fillStyle = baseColor;
    const torsoTop = p.crouching ? py + 4 : py + 8;
    const torsoH = p.crouching ? pH - 14 : pH - 26;
    ctx.fillRect(px + 3, torsoTop, 24, torsoH);

    // Tactical vest
    ctx.fillStyle = darkColor;
    ctx.fillRect(px + 5, torsoTop + 2, 20, torsoH - 4);
    // Vest pockets
    ctx.fillStyle = baseColor;
    ctx.fillRect(px + 7, torsoTop + 4, 6, 5);
    ctx.fillRect(px + 17, torsoTop + 4, 6, 5);

    // Arms
    ctx.fillStyle = baseColor;
    const armY = torsoTop + 4;
    if (p.facing === 1) {
      // Right-facing: gun arm extended
      ctx.fillRect(px + 24, armY, 12, 5);
      // Back arm
      ctx.fillRect(px - 4, armY + 2, 8, 5);
    } else {
      ctx.fillRect(px - 6, armY, 12, 5);
      ctx.fillRect(px + 26, armY + 2, 8, 5);
    }

    // Gun
    ctx.fillStyle = '#333';
    const gunY = armY + 1;
    if (p.facing === 1) {
      ctx.fillRect(px + 30, gunY, 16, 3);
      ctx.fillRect(px + 28, gunY - 2, 4, 7);
    } else {
      ctx.fillRect(px - 16, gunY, 16, 3);
      ctx.fillRect(px - 2, gunY - 2, 4, 7);
    }

    // Head
    ctx.fillStyle = skinColor;
    const headY = p.crouching ? py : py;
    ctx.fillRect(px + 8, headY, 14, 12);

    // Helmet
    ctx.fillStyle = isBull ? '#1a6a1a' : '#881111';
    ctx.fillRect(px + 6, headY - 3, 18, 7);
    ctx.fillRect(px + 8, headY - 5, 14, 5);

    // Eyes
    ctx.fillStyle = '#000';
    if (p.facing === 1) {
      ctx.fillRect(px + 17, headY + 4, 3, 2);
    } else {
      ctx.fillRect(px + 10, headY + 4, 3, 2);
    }

    // Highlight if it's me
    if (p.id === myId) {
      ctx.strokeStyle = isBull ? 'rgba(0,255,65,0.5)' : 'rgba(255,68,68,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px - 2, headY - 6, config.playerW + 4, pH + 8);

      // Name tag
      ctx.fillStyle = isBull ? '#00ff41' : '#ff4444';
      ctx.font = '8px "Press Start 2P"';
      ctx.textAlign = 'center';
      ctx.fillText('YOU', px + config.playerW / 2, headY - 10);
    }

    // HP bar above player (for others)
    if (p.id !== myId) {
      const barW = 28;
      const barH = 3;
      const barX = px + (config.playerW - barW) / 2;
      const barY = headY - 12;
      ctx.fillStyle = '#333';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = p.hp > 50 ? '#00ff41' : p.hp > 25 ? '#ffaa00' : '#ff4444';
      ctx.fillRect(barX, barY, barW * (p.hp / 100), barH);
    }
  }

  function drawBullets() {
    for (const b of serverState.bullets) {
      const bx = b.x - camera.x;
      ctx.fillStyle = b.team === 'bulls' ? '#aaff77' : '#ff7777';
      ctx.shadowColor = b.team === 'bulls' ? '#00ff41' : '#ff4444';
      ctx.shadowBlur = 6;
      ctx.fillRect(bx - 4, b.y - 1, 8, 3);
      ctx.shadowBlur = 0;

      // Trail
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = b.team === 'bulls' ? '#00ff41' : '#ff4444';
      const trailDir = b.team === 'bulls' ? -1 : 1;
      ctx.fillRect(bx + trailDir * 8, b.y, 12, 1);
      ctx.globalAlpha = 1.0;
    }
  }

  function drawMuzzleFlashes() {
    const now = performance.now();
    for (let i = muzzleFlashes.length - 1; i >= 0; i--) {
      const f = muzzleFlashes[i];
      const elapsed = now - f.time;
      if (elapsed > f.duration) {
        muzzleFlashes.splice(i, 1);
        continue;
      }
      const alpha = 1 - elapsed / f.duration;
      const fx = f.x - camera.x;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffff88';
      ctx.beginPath();
      ctx.arc(fx + f.facing * 10, f.y, 6 + Math.random() * 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(fx + f.facing * 8, f.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1.0;
    }
  }

  function drawHitMarkers() {
    const now = performance.now();
    for (let i = hitMarkers.length - 1; i >= 0; i--) {
      const h = hitMarkers[i];
      const elapsed = now - h.time;
      if (elapsed > h.duration) {
        hitMarkers.splice(i, 1);
        continue;
      }
      const alpha = 1 - elapsed / h.duration;
      const hx = h.x - camera.x + 15;
      const hy = h.y + 10;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      const s = 6 + elapsed * 0.02;
      ctx.beginPath();
      ctx.moveTo(hx - s, hy - s); ctx.lineTo(hx - s / 2, hy - s / 2);
      ctx.moveTo(hx + s, hy - s); ctx.lineTo(hx + s / 2, hy - s / 2);
      ctx.moveTo(hx - s, hy + s); ctx.lineTo(hx - s / 2, hy + s / 2);
      ctx.moveTo(hx + s, hy + s); ctx.lineTo(hx + s / 2, hy + s / 2);
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    }
  }

  function updateDeathParticles() {
    for (let i = deathParticles.length - 1; i >= 0; i--) {
      const p = deathParticles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15;
      p.life -= 0.02;
      if (p.life <= 0) {
        deathParticles.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - camera.x, p.y, 3, 3);
      ctx.globalAlpha = 1.0;
    }
  }

  // ─── Camera ───
  function updateCamera() {
    if (!localPlayer) return;
    const scale = getScale();
    const viewW = canvas.width / scale;
    const targetX = localPlayer.x - viewW / 2 + config.playerW / 2;
    camera.x += (targetX - camera.x) * 0.1;
    const maxCamX = Math.max(0, config.mapWidth - viewW);
    camera.x = Math.max(0, Math.min(maxCamX, camera.x));
  }

  // ─── Scale & coordinate mapping ───
  function getScale() {
    // Map the 600px game height to the canvas
    return canvas.height / config.mapHeight;
  }

  // ─── Main Game Loop ───
  function gameLoop() {
    if (!joined) return;

    const w = canvas.width;
    const h = canvas.height;
    const scale = getScale();

    updateCamera();

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.scale(scale, scale);

    // Adjust camera and canvas for scale
    const scaledW = w / scale;
    const scaledH = h / scale;

    // Sky
    drawSky(scaledW, scaledH);

    // Ground
    const groundScreenY = config.groundY;
    drawGround(scaledW, groundScreenY);

    // Grass below
    drawGrass(scaledW, scaledH, groundScreenY);

    // Trenches
    drawTrench(config.trenchLeft, groundScreenY);
    drawTrench(config.trenchRight, groundScreenY);

    // Barbed wire
    drawBarbedWire(groundScreenY);

    // Bullets
    drawBullets();

    // Players
    for (const pid in serverState.players) {
      drawPlayer(serverState.players[pid]);
    }

    // Effects
    drawMuzzleFlashes();
    drawHitMarkers();
    updateDeathParticles();

    ctx.restore();

    requestAnimationFrame(gameLoop);
  }

  // ─── Grain overlay animation (extra layer via canvas) ───
  // The CSS handles the main CRT effect; this adds subtle per-frame noise
  let grainCanvas, grainCtx;
  function initGrain() {
    grainCanvas = document.createElement('canvas');
    grainCanvas.width = 256;
    grainCanvas.height = 256;
    grainCtx = grainCanvas.getContext('2d');
  }
  initGrain();

})();
