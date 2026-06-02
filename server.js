'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const crypto  = require('crypto');

// ── Tunable constants ─────────────────────────────────────────────────────────
const SPEED_TIERS = [
  { minAlive: 11, seconds: 15 },   // more than 10 players alive
  { minAlive: 4,  seconds: 10 },   // 4–10 players alive
  { minAlive: 0,  seconds: 5  },   // 3 or fewer players alive
];
const MAX_PLAYERS = 20;
const CODE_CHARS  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // excludes 0/O/1/I
// ─────────────────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room store
// room shape: { code, hostToken, hostSocketId, players: Map<id,player>,
//               gameState: null|gs, status: 'lobby'|'playing'|'paused'|'ended',
//               joinCounter: number, lastWinner: null|{id,name} }
const rooms = new Map();

// ── Arabic letter rules (pure functions) ─────────────────────────────────────

const stripDiacritics = s => s.replace(/[ً-ْٰـ]/g, '');
const unifyHamza      = ch => ('أإآٱ'.includes(ch) ? 'ا' : ch);

function requiredNextLetter(word) {
  const w = stripDiacritics(word).trim();
  let last = w[w.length - 1];
  if (last === 'ة' || last === 'ى') last = w[w.length - 2];
  return unifyHamza(last);
}

function effectiveFirstLetter(word) {
  let w = stripDiacritics(word).trim();
  // Strip leading definite article "ال" before hamza unification
  if (w.length > 2 && w[0] === 'ا' && w[1] === 'ل') w = w.slice(2);
  return unifyHamza(w[0]);
}

function startsCorrectly(submitted, requiredLetter) {
  return effectiveFirstLetter(submitted) === unifyHamza(requiredLetter);
}

function repeatKey(word) {
  return stripDiacritics(word).trim().split('').map(unifyHamza).join('');
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function generateCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function uid() { return crypto.randomBytes(12).toString('hex'); }

function timerSecs(aliveCount) {
  for (const t of SPEED_TIERS) if (aliveCount >= t.minAlive) return t.seconds;
  return 5;
}

function tierLabel(aliveCount) {
  for (const t of SPEED_TIERS) {
    if (aliveCount >= t.minAlive)
      return `${t.seconds} ثانية (${t.minAlive}+ لاعبين)`;
  }
  return '5 ثوان';
}

// ── Public view builders ──────────────────────────────────────────────────────

function pubPlayer(p) {
  return {
    id: p.id, name: p.name, alive: p.alive,
    eliminated: p.eliminated, eliminationReason: p.eliminationReason,
    joinIndex: p.joinIndex, connected: !!p.socketId,
  };
}

function pubRoom(room) {
  const players = [...room.players.values()]
    .map(pubPlayer).sort((a, b) => a.joinIndex - b.joinIndex);
  const gs = room.gameState;
  return {
    code: room.code,
    status: room.status,
    lastWinner: room.lastWinner || null,
    players,
    game: gs ? {
      currentWord:         gs.currentWord,
      requiredLetter:      gs.requiredLetter,
      usedWords:           gs.usedWords,
      currentTurnPlayerId: gs.currentTurnPlayerId,
      timerSeconds:        gs.timerSeconds,
      timerStartedAt:      gs.timerStartedAt,
      timerStoppedAt:      gs.timerStoppedAt,
      frozenTimeRemaining: gs.frozenTimeRemaining,
      pendingWord:         gs.pendingWord,
      pendingPlayerId:     gs.pendingPlayerId,
      pendingPlayerName:   gs.pendingPlayerId ? room.players.get(gs.pendingPlayerId)?.name : null,
      pausedReason:        gs.pausedReason,
      pausedForPlayerId:   gs.pausedForPlayerId,
      pausedForPlayerName: gs.pausedForPlayerId ? room.players.get(gs.pausedForPlayerId)?.name : null,
      tierLabel:           gs.tierLabel,
    } : null,
  };
}

function broadcast(room) {
  io.to(room.code).emit('roomState', pubRoom(room));
}

// ── Game helpers ──────────────────────────────────────────────────────────────

function aliveSorted(room) {
  return [...room.players.values()]
    .filter(p => p.alive)
    .sort((a, b) => a.joinIndex - b.joinIndex);
}

function startTimer(room) {
  const gs = room.gameState;
  const alive = aliveSorted(room).length;
  gs.timerSeconds        = timerSecs(alive);
  gs.tierLabel           = tierLabel(alive);
  gs.timerStartedAt      = Date.now();
  gs.timerStoppedAt      = null;
  gs.frozenTimeRemaining = null;
  clearTimeout(gs.timerHandle);
  gs.timerHandle = setTimeout(() => {
    if (room.status !== 'playing' || gs.pendingWord) return;
    doEliminate(room, gs.currentTurnPlayerId, 'انتهى الوقت');
  }, gs.timerSeconds * 1000);
}

function doEliminate(room, playerId, reason) {
  const player = room.players.get(playerId);
  if (!player || !player.alive) return;
  player.alive             = false;
  player.eliminated        = true;
  player.eliminationReason = reason;
  const gs = room.gameState;
  gs.pendingWord      = null;
  gs.pendingPlayerId  = null;
  gs.timerStoppedAt   = null;
  io.to(room.code).emit('playerEliminated', {
    playerId, playerName: player.name, reason,
  });
  const alive = aliveSorted(room);
  if (alive.length <= 1) { endGame(room, alive[0]); return; }
  if (gs.currentTurnPlayerId === playerId) advanceTurnFrom(room, player.joinIndex);
  else broadcast(room);
}

function advanceTurnFrom(room, fromJoinIndex) {
  const gs    = room.gameState;
  const alive = aliveSorted(room);
  const next  = alive.find(p => p.joinIndex > fromJoinIndex) || alive[0];
  gs.currentTurnPlayerId = next.id;
  broadcast(room);
  startTimer(room);
  io.to(room.code).emit('yourTurn', { playerId: next.id });
}

function advanceTurn(room) {
  const gs    = room.gameState;
  const alive = aliveSorted(room);
  if (alive.length <= 1) { endGame(room, alive[0]); return; }
  const idx  = alive.findIndex(p => p.id === gs.currentTurnPlayerId);
  const next = alive[(idx + 1) % alive.length];
  gs.currentTurnPlayerId = next.id;
  broadcast(room);
  startTimer(room);
  io.to(room.code).emit('yourTurn', { playerId: next.id });
}

function pauseGame(room, reason, forPlayerId) {
  const gs           = room.gameState;
  room.status        = 'paused';
  gs.pausedReason    = reason;
  gs.pausedForPlayerId = forPlayerId;
  clearTimeout(gs.timerHandle);
  gs.timerHandle = null;
  const elapsed = (Date.now() - (gs.timerStartedAt || Date.now())) / 1000;
  gs.frozenTimeRemaining = Math.max(0, gs.timerSeconds - elapsed);
  broadcast(room);
}

function resumeGame(room) {
  const gs          = room.gameState;
  const remaining   = gs.frozenTimeRemaining;
  room.status       = 'playing';
  gs.pausedReason   = null;
  gs.pausedForPlayerId = null;
  gs.frozenTimeRemaining = null;
  gs.timerStartedAt = Date.now();
  broadcast(room);
  io.to(room.code).emit('gameResumed', {});
  // If a word is pending, host still needs to decide — don't restart timer
  if (gs.pendingWord) return;
  clearTimeout(gs.timerHandle);
  const delay = (remaining !== null ? remaining : gs.timerSeconds) * 1000;
  gs.timerHandle = setTimeout(() => {
    if (room.status !== 'playing' || gs.pendingWord) return;
    doEliminate(room, gs.currentTurnPlayerId, 'انتهى الوقت');
  }, delay);
  io.to(room.code).emit('yourTurn', { playerId: gs.currentTurnPlayerId });
}

function endGame(room, winner) {
  clearTimeout(room.gameState?.timerHandle);
  room.lastWinner = winner ? { id: winner.id, name: winner.name } : null;
  room.status     = 'ended';
  room.gameState  = null;
  io.to(room.code).emit('gameEnded', {
    winnerId: winner?.id, winnerName: winner?.name,
  });
  broadcast(room);
}

// ── Socket handlers ───────────────────────────────────────────────────────────

io.on('connection', socket => {

  // ── createRoom ──────────────────────────────────────────────────────────────
  socket.on('createRoom', cb => {
    const code      = generateCode();
    const hostToken = uid();
    rooms.set(code, {
      code, hostToken, hostSocketId: socket.id,
      players: new Map(), gameState: null,
      status: 'lobby', joinCounter: 0, lastWinner: null,
    });
    socket.join(code);
    Object.assign(socket.data, { roomCode: code, role: 'host', token: hostToken });
    cb?.({ success: true, code, hostToken });
  });

  // ── reconnectHost ────────────────────────────────────────────────────────────
  socket.on('reconnectHost', ({ code, hostToken }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostToken !== hostToken) return cb?.({ success: false });
    room.hostSocketId = socket.id;
    socket.join(code);
    Object.assign(socket.data, { roomCode: code, role: 'host', token: hostToken });
    if (room.status === 'paused' && room.gameState?.pausedReason === 'host') {
      resumeGame(room);
    } else {
      broadcast(room);
    }
    cb?.({ success: true, roomState: pubRoom(room) });
  });

  // ── joinRoom ─────────────────────────────────────────────────────────────────
  socket.on('joinRoom', ({ code, name, playerId, token }, cb) => {
    const upperCode = (code || '').toUpperCase();
    const room = rooms.get(upperCode);
    if (!room) return cb?.({ success: false, reason: 'الغرفة غير موجودة' });

    // Reconnection attempt
    if (playerId && token) {
      const p = room.players.get(playerId);
      if (p && p.token === token) {
        p.socketId = socket.id;
        socket.join(room.code);
        Object.assign(socket.data, { roomCode: room.code, role: 'player', playerId, token });
        if (room.status === 'paused' && room.gameState?.pausedReason === 'player'
            && room.gameState?.pausedForPlayerId === playerId) {
          resumeGame(room);
        } else {
          broadcast(room);
        }
        return cb?.({
          success: true, reconnected: true, playerId, token,
          playerName: p.name, roomState: pubRoom(room),
        });
      }
    }

    // New join validation
    if (room.status === 'playing' || room.status === 'paused')
      return cb?.({ success: false, reason: 'اللعبة جارية بالفعل' });
    if (room.status === 'ended')
      return cb?.({ success: false, reason: 'انتهت اللعبة — انتظر لعبة جديدة' });
    if (room.players.size >= MAX_PLAYERS)
      return cb?.({ success: false, reason: 'الغرفة ممتلئة (20 لاعب)' });

    const trimmedName = (name || '').trim();
    if (!trimmedName) return cb?.({ success: false, reason: 'الاسم فارغ' });
    for (const p of room.players.values()) {
      if (p.name === trimmedName)
        return cb?.({ success: false, reason: 'هذا الاسم مستخدم — اختر اسماً آخر' });
    }

    const pid = uid().slice(0, 12);
    const tok = uid();
    room.players.set(pid, {
      id: pid, name: trimmedName, token: tok, socketId: socket.id,
      alive: true, eliminated: false, eliminationReason: null,
      joinIndex: room.joinCounter++,
    });
    socket.join(room.code);
    Object.assign(socket.data, { roomCode: room.code, role: 'player', playerId: pid, token: tok });
    broadcast(room);
    cb?.({ success: true, playerId: pid, token: tok, playerName: trimmedName, roomState: pubRoom(room) });
  });

  // ── startGame ────────────────────────────────────────────────────────────────
  socket.on('startGame', cb => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return;
    if (room.status !== 'lobby' && room.status !== 'ended') return;

    // Reset all players (lets previously-dropped players rejoin)
    for (const p of room.players.values()) {
      p.alive = true; p.eliminated = false; p.eliminationReason = null;
    }
    const alive = aliveSorted(room);
    if (alive.length === 0) return cb?.({ success: false, reason: 'لا يوجد لاعبون' });

    const first = alive[0];
    room.status    = 'playing';
    room.gameState = {
      currentWord: null, requiredLetter: null,
      usedWords: [], usedWordKeys: new Set(),
      currentTurnPlayerId: first.id,
      timerSeconds: timerSecs(alive.length), timerStartedAt: Date.now(),
      timerStoppedAt: null, frozenTimeRemaining: null, timerHandle: null,
      pendingWord: null, pendingPlayerId: null,
      pausedReason: null, pausedForPlayerId: null,
      tierLabel: tierLabel(alive.length),
    };
    startTimer(room);
    broadcast(room);
    io.to(room.code).emit('yourTurn', { playerId: first.id });
    cb?.({ success: true });
  });

  // ── submitWord ───────────────────────────────────────────────────────────────
  socket.on('submitWord', ({ word }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.gameState || room.status !== 'playing') return;
    const { playerId } = socket.data;
    const gs = room.gameState;
    if (gs.currentTurnPlayerId !== playerId || gs.pendingWord) return;

    const w = (word || '').trim();
    if (!w || /\s/.test(w)) return cb?.({ success: false });

    // Stop server-side timer
    clearTimeout(gs.timerHandle);
    gs.timerHandle    = null;
    gs.timerStoppedAt = Date.now();

    // Letter check (skipped for the very first word)
    if (gs.requiredLetter !== null) {
      if (!startsCorrectly(w, gs.requiredLetter)) {
        doEliminate(room, playerId, 'حرف خاطئ');
        return cb?.({ success: false, reason: 'حرف خاطئ' });
      }
    }
    // No-repeat check
    if (gs.usedWordKeys.has(repeatKey(w))) {
      doEliminate(room, playerId, 'كلمة مكررة');
      return cb?.({ success: false, reason: 'كلمة مكررة' });
    }

    // Passed auto-checks — send to host for approval
    gs.pendingWord     = w;
    gs.pendingPlayerId = playerId;
    broadcast(room);
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('pendingApproval', {
        word: w, playerId, playerName: room.players.get(playerId)?.name,
      });
    }
    cb?.({ success: true, pending: true });
  });

  // ── judgeDecision ────────────────────────────────────────────────────────────
  socket.on('judgeDecision', ({ accept }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.gameState || socket.data.role !== 'host') return;
    const gs = room.gameState;
    if (!gs.pendingWord) return;

    const word = gs.pendingWord;
    const pid  = gs.pendingPlayerId;
    gs.pendingWord = null; gs.pendingPlayerId = null; gs.timerStoppedAt = null;

    if (accept) {
      gs.usedWords.push(word);
      gs.usedWordKeys.add(repeatKey(word));
      gs.currentWord     = word;
      gs.requiredLetter  = requiredNextLetter(word);
      advanceTurn(room);
    } else {
      doEliminate(room, pid, 'رفضها الحكم');
    }
    cb?.({ success: true });
  });

  // ── hostDropPlayer ───────────────────────────────────────────────────────────
  socket.on('hostDropPlayer', ({ playerId }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.gameState || socket.data.role !== 'host') return;
    if (room.status !== 'paused') return;
    const player = room.players.get(playerId);
    if (!player || !player.alive) return;

    const wasTurn = room.gameState.currentTurnPlayerId === playerId;
    // Eliminate but keep in room (they rejoin next game)
    player.alive = false; player.eliminated = true; player.eliminationReason = 'انسحب';
    room.gameState.pendingWord = null; room.gameState.pendingPlayerId = null;
    io.to(room.code).emit('playerEliminated', {
      playerId, playerName: player.name, reason: 'انسحب',
    });

    const alive = aliveSorted(room);
    if (alive.length <= 1) { endGame(room, alive[0]); return cb?.({ success: true }); }

    if (wasTurn) {
      const next = alive.find(p => p.joinIndex > player.joinIndex) || alive[0];
      room.gameState.currentTurnPlayerId = next.id;
    }

    // Resume without the dropped player
    room.status = 'playing';
    room.gameState.pausedReason    = null;
    room.gameState.pausedForPlayerId = null;
    room.gameState.frozenTimeRemaining = null;
    room.gameState.timerStartedAt  = Date.now();
    broadcast(room);
    io.to(room.code).emit('gameResumed', {});
    startTimer(room);
    io.to(room.code).emit('yourTurn', { playerId: room.gameState.currentTurnPlayerId });
    cb?.({ success: true });
  });

  // ── disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.role === 'host') {
      if (room.status === 'playing') pauseGame(room, 'host', null);
    } else if (socket.data.role === 'player') {
      const p = room.players.get(socket.data.playerId);
      if (p) {
        p.socketId = null;
        if (room.status === 'playing' && p.alive) pauseGame(room, 'player', p.id);
        else broadcast(room);
      }
    }
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`سباق الكلمات — http://localhost:${PORT}`)
);
