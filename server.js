// server.js — Patch de reconexão com “force join” e limpeza de sessão fantasma
// ---------------------------------------------------------------
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const GRACE_MS = 180000; // 3 minutos
const rooms = Object.create(null);

function now() { return Date.now(); }

function buildLeaderboard(room) {
  const arr = Object.entries(room.players || {}).map(([pid, p]) => ({
    playerId: pid,
    name: p.name || 'Jogador',
    score: p.score || 0,
    online: !!p.isOnline
  }));
  arr.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
  return arr;
}

function destroyRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  try {
    Object.values(room.players || {}).forEach(p => {
      if (p?.kickTimer) {
        clearTimeout(p.kickTimer);
        p.kickTimer = null;
      }
    });
  } catch (e) {}
  delete rooms[roomCode];
}

function closeRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  room.status = 'closed';
  io.in(roomCode).emit('roomClosed');
  destroyRoom(roomCode);
}

function findPlayerInAnyRoom(playerId) {
  for (const code of Object.keys(rooms)) {
    const r = rooms[code];
    if (r?.players?.[playerId]) {
      return { roomCode: code, room: r, player: r.players[playerId] };
    }
  }
  return null;
}

function sendCurrentStateToPlayer(room, socket) {
  socket.emit('joined', {
    room: { code: room.code },
    you: { playerId: socket.data.playerId }
  });
  if (room.status === 'over') {
    socket.emit('gameOver', { reason: room.gameOverReason || 'finished' });
    return;
  }
  if (room.status === 'question') {
    const timeLeft = Math.max(0, (room.state?.questionEndsAt || now()) - now());
    socket.emit('newQuestion', {
      q: room.state?.currentQuestion || null,
      timeLeft
    });
    return;
  }
  if (room.status === 'reveal') {
    socket.emit('reveal', {
      result: room.state?.lastResult || null
    });
    return;
  }
  socket.emit('lobby', {});
}

io.on('connection', (socket) => {
  socket.data = {};

  socket.on('host:createRoom', ({ roomCode }, cb) => {
    roomCode = String(roomCode || '').trim().toUpperCase();
    if (!roomCode) return cb && cb({ ok:false, code:'INVALID_CODE' });
    if (rooms[roomCode]) return cb && cb({ ok:false, code:'ROOM_EXISTS' });
    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      status: 'lobby',
      players: Object.create(null),
      state: { createdAt: now() }
    };
    socket.join(roomCode);
    socket.data = { roomCode, role: 'host' };
    return cb && cb({ ok:true, room: { code: roomCode } });
  });

  socket.on('host:closeRoom', (cb) => {
    const { roomCode } = socket.data || {};
    if (!roomCode || !rooms[roomCode]) return cb && cb({ ok:false, code:'ROOM_NOT_FOUND' });
    if (rooms[roomCode].hostId !== socket.id) return cb && cb({ ok:false, code:'NOT_HOST' });
    closeRoom(roomCode);
    return cb && cb({ ok:true });
  });

  socket.on('join', ({ roomCode, name, playerId, force }, cb) => {
    roomCode = String(roomCode || '').trim().toUpperCase();
    name = String(name || '').trim() || 'Jogador';
    playerId = String(playerId || '').trim() || socket.id;

    const room = rooms[roomCode];
    if (!room || room.status === 'closed') {
      return cb && cb({ ok:false, code:'ROOM_NOT_FOUND' });
    }

    const prev = findPlayerInAnyRoom(playerId);
    if (prev) {
      const prevClosed = !rooms[prev.roomCode] || rooms[prev.roomCode].status === 'closed';
      const canMigrate = !!force || prevClosed || !prev.player.isOnline;
      if (!canMigrate) {
        return cb && cb({ ok:false, code:'ALREADY_IN_GAME' });
      }
      if (rooms[prev.roomCode]?.players?.[playerId]) {
        if (rooms[prev.roomCode].players[playerId].kickTimer) {
          clearTimeout(rooms[prev.roomCode].players[playerId].kickTimer);
        }
        delete rooms[prev.roomCode].players[playerId];
      }
    }

    room.players = room.players || Object.create(null);
    room.players[playerId] = {
      name,
      socketId: socket.id,
      isOnline: true,
      score: room.players[playerId]?.score || 0
    };

    socket.join(roomCode);
    socket.data = { roomCode, role:'player', playerId };

    sendCurrentStateToPlayer(room, socket);
    io.in(roomCode).emit('leaderboard', buildLeaderboard(room));

    return cb && cb({ ok:true, room: { code: roomCode }, playerId });
  });

  socket.on('rejoin', ({ roomCode, playerId }, cb) => {
    roomCode = String(roomCode || '').trim().toUpperCase();
    playerId = String(playerId || '').trim();

    const room = rooms[roomCode];
    if (!room || room.status === 'closed') {
      return cb && cb({ ok:false, code:'SESSION_INVALID' });
    }
    const player = room.players?.[playerId];
    if (!player) {
      return cb && cb({ ok:false, code:'PLAYER_NOT_FOUND' });
    }

    player.isOnline = true;
    player.socketId = socket.id;
    if (player.kickTimer) { clearTimeout(player.kickTimer); player.kickTimer = null; }

    socket.join(roomCode);
    socket.data = { roomCode, role:'player', playerId };

    sendCurrentStateToPlayer(room, socket);
    io.in(roomCode).emit('leaderboard', buildLeaderboard(room));

    return cb && cb({ ok:true });
  });

  socket.on('disconnect', () => {
    const { roomCode, role, playerId } = socket.data || {};
    const room = rooms[roomCode];
    if (!room) return;

    if (role === 'host') {
      closeRoom(roomCode);
      return;
    }

    const player = room.players?.[playerId];
    if (player) {
      player.isOnline = false;
      if (player.kickTimer) { clearTimeout(player.kickTimer); }
      player.kickTimer = setTimeout(() => {
        const r = rooms[roomCode];
        if (r?.players?.[playerId] && !r.players[playerId].isOnline) {
          delete r.players[playerId];
          io.in(roomCode).emit('leaderboard', buildLeaderboard(r));
        }
      }, GRACE_MS);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[ASAI] Servidor iniciado em http://localhost:${PORT}`);
});
