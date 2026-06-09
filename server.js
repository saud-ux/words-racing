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
const MAX_EVENTS  = 80;                                  // host activity feed cap
const MAX_TIMER_SECS = 60;                               // hard cap for ±5s adjustments
// ─────────────────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room store
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

// ── Event log (host activity feed) ────────────────────────────────────────────
function pushEvent(room, event) {
  if (!room.gameState) return;
  if (!Array.isArray(room.gameState.events)) room.gameState.events = [];
  room.gameState.events.push({ id: uid().slice(0, 8), ts: Date.now(), ...event });
  const overflow = room.gameState.events.length - MAX_EVENTS;
  if (overflow > 0) room.gameState.events.splice(0, overflow);
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
    timerMode: room.timerMode,
    players,
    game: gs ? {
      currentWord:         gs.currentWord,
      requiredLetter:      gs.requiredLetter,
      usedWords:           gs.usedWords, // [{word, playerId, playerName}]
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
      events:              gs.events || [],
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
  const fixed = room.timerMode !== 'dynamic' && typeof room.timerMode === 'number';
  gs.timerSeconds        = fixed ? room.timerMode : timerSecs(alive);
  gs.tierLabel           = fixed ? `${room.timerMode} ثانية (ثابت)` : tierLabel(alive);
  gs.timerStartedAt      = Date.now();
  gs.timerStoppedAt      = null;
  gs.frozenTimeRemaining = null;
  clearTimeout(gs.timerHandle);
  gs.timerHandle = setTimeout(() => timeoutCurrent(room), gs.timerSeconds * 1000);
}

function timeoutCurrent(room) {
  const gs = room.gameState;
  if (!gs || room.status !== 'playing' || gs.pendingWord) return;
  const pid = gs.currentTurnPlayerId;
  pushEvent(room, {
    type: 'timeout',
    playerId: pid,
    playerName: room.players.get(pid)?.name,
  });
  doEliminate(room, pid, 'انتهى الوقت');
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
  // Restore timerStartedAt so computeRemaining yields the saved remaining
  gs.timerStartedAt = Date.now() - (gs.timerSeconds - (remaining ?? gs.timerSeconds)) * 1000;
  broadcast(room);
  io.to(room.code).emit('gameResumed', {});
  if (gs.pendingWord) return;
  clearTimeout(gs.timerHandle);
  const delay = (remaining !== null ? remaining : gs.timerSeconds) * 1000;
  gs.timerHandle = setTimeout(() => timeoutCurrent(room), delay);
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
      timerMode: 'dynamic', // 'dynamic' or a fixed number of seconds
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

    // Reconnection
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

    for (const p of room.players.values()) {
      p.alive = true; p.eliminated = false; p.eliminationReason = null;
    }
    const alive = aliveSorted(room);
    if (alive.length === 0) return cb?.({ success: false, reason: 'لا يوجد لاعبون' });

    const first = alive[0];
    const fixedTimer = room.timerMode !== 'dynamic' && typeof room.timerMode === 'number';
    room.status    = 'playing';
    room.gameState = {
      currentWord: null, requiredLetter: null,
      usedWords: [], usedWordKeys: new Set(),
      currentTurnPlayerId: first.id,
      timerSeconds: fixedTimer ? room.timerMode : timerSecs(alive.length),
      timerStartedAt: Date.now(),
      timerStoppedAt: null, frozenTimeRemaining: null, timerHandle: null,
      pendingWord: null, pendingPlayerId: null,
      pausedReason: null, pausedForPlayerId: null,
      tierLabel: fixedTimer ? `${room.timerMode} ثانية (ثابت)` : tierLabel(alive.length),
      events: [],
    };
    pushEvent(room, {
      type: 'gameStarted',
      count: alive.length,
      firstPlayerName: first.name,
    });
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

    clearTimeout(gs.timerHandle);
    gs.timerHandle    = null;
    gs.timerStoppedAt = Date.now();

    const playerName = room.players.get(playerId)?.name;

    if (gs.requiredLetter !== null) {
      if (!startsCorrectly(w, gs.requiredLetter)) {
        pushEvent(room, {
          type: 'wrongLetter',
          playerId, playerName, word: w,
          expectedLetter: gs.requiredLetter,
        });
        doEliminate(room, playerId, 'حرف خاطئ');
        return cb?.({ success: false, reason: 'حرف خاطئ' });
      }
    }
    if (gs.usedWordKeys.has(repeatKey(w))) {
      pushEvent(room, {
        type: 'repeatedWord',
        playerId, playerName, word: w,
      });
      doEliminate(room, playerId, 'كلمة مكررة');
      return cb?.({ success: false, reason: 'كلمة مكررة' });
    }

    gs.pendingWord     = w;
    gs.pendingPlayerId = playerId;
    broadcast(room);
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('pendingApproval', {
        word: w, playerId, playerName,
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
    const playerName = room.players.get(pid)?.name;
    gs.pendingWord = null; gs.pendingPlayerId = null; gs.timerStoppedAt = null;

    if (accept) {
      const nextLetter = requiredNextLetter(word);
      pushEvent(room, {
        type: 'wordAccepted',
        playerId: pid, playerName, word, nextLetter,
      });
      // #10 — words list tracks who said each accepted word
      gs.usedWords.push({ word, playerId: pid, playerName });
      gs.usedWordKeys.add(repeatKey(word));
      gs.currentWord    = word;
      gs.requiredLetter = nextLetter;
      advanceTurn(room);
    } else {
      pushEvent(room, {
        type: 'wordRejected',
        playerId: pid, playerName, word,
      });
      doEliminate(room, pid, 'رفضها الحكم');
    }
    cb?.({ success: true });
  });

  // ── hostDropPlayer (existing: drop a disconnected player) ───────────────────
  socket.on('hostDropPlayer', ({ playerId }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.gameState || socket.data.role !== 'host') return;
    if (room.status !== 'paused') return;
    const player = room.players.get(playerId);
    if (!player || !player.alive) return;

    const wasTurn = room.gameState.currentTurnPlayerId === playerId;
    pushEvent(room, { type: 'dropped', playerId, playerName: player.name });
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

  // ── #1 hostKickPlayer — kick at any time, any state ─────────────────────────
  socket.on('hostKickPlayer', ({ playerId }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return cb?.({ success: false });
    const player = room.players.get(playerId);
    if (!player) return cb?.({ success: false });

    const kickedSocketId = player.socketId;

    // Lobby or ended: remove player from room entirely
    if (room.status === 'lobby' || room.status === 'ended') {
      room.players.delete(playerId);
      if (kickedSocketId) {
        io.to(kickedSocketId).emit('kickedFromRoom', { reason: 'طردك الحكم' });
      }
      broadcast(room);
      return cb?.({ success: true });
    }

    // Playing or paused: eliminate
    if (!player.alive) return cb?.({ success: false });
    const gs = room.gameState;
    if (!gs) return cb?.({ success: false });

    const wasTurn = gs.currentTurnPlayerId === playerId;
    pushEvent(room, { type: 'kicked', playerId, playerName: player.name });

    player.alive = false;
    player.eliminated = true;
    player.eliminationReason = 'طُرد من الحكم';

    // Clear pending if it belonged to the kicked player
    if (gs.pendingPlayerId === playerId) {
      gs.pendingWord = null;
      gs.pendingPlayerId = null;
      gs.timerStoppedAt = null;
    }

    io.to(room.code).emit('playerEliminated', {
      playerId, playerName: player.name, reason: 'طُرد من الحكم',
    });

    const alive = aliveSorted(room);
    if (alive.length <= 1) { endGame(room, alive[0]); return cb?.({ success: true }); }

    // If the game was paused for THIS player's disconnect, the pause is now moot
    const wasPausedForKicked =
      room.status === 'paused' && gs.pausedForPlayerId === playerId;

    if (wasTurn) {
      const next = alive.find(p => p.joinIndex > player.joinIndex) || alive[0];
      gs.currentTurnPlayerId = next.id;
    }

    if (wasPausedForKicked) {
      // Resume the game cleanly
      room.status = 'playing';
      gs.pausedReason = null;
      gs.pausedForPlayerId = null;
      gs.frozenTimeRemaining = null;
      gs.timerStartedAt = Date.now();
      broadcast(room);
      io.to(room.code).emit('gameResumed', {});
      startTimer(room);
      io.to(room.code).emit('yourTurn', { playerId: gs.currentTurnPlayerId });
    } else if (room.status === 'playing' && wasTurn) {
      broadcast(room);
      startTimer(room);
      io.to(room.code).emit('yourTurn', { playerId: gs.currentTurnPlayerId });
    } else {
      broadcast(room);
    }
    cb?.({ success: true });
  });

  // ── #4 hostPauseTimer — manual pause during play ────────────────────────────
  socket.on('hostPauseTimer', cb => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return cb?.({ success: false });
    if (room.status !== 'playing' || !room.gameState) return cb?.({ success: false });
    if (room.gameState.pendingWord) return cb?.({ success: false, reason: 'هناك كلمة بانتظار قرارك' });
    pauseGame(room, 'manual', null);
    cb?.({ success: true });
  });

  // ── #4 hostResumeTimer — release manual pause ───────────────────────────────
  socket.on('hostResumeTimer', cb => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return cb?.({ success: false });
    if (room.status !== 'paused' || !room.gameState) return cb?.({ success: false });
    if (room.gameState.pausedReason !== 'manual') return cb?.({ success: false });

    // If someone disconnected during the manual pause, switch to player-pause
    // so the host gets the proper drop/wait controls instead of silently resuming
    // into a half-broken state.
    const dc = aliveSorted(room).find(p => !p.socketId);
    if (dc) {
      room.gameState.pausedReason = 'player';
      room.gameState.pausedForPlayerId = dc.id;
      broadcast(room);
      return cb?.({ success: true, switchedToPlayerPause: true });
    }

    resumeGame(room);
    cb?.({ success: true });
  });

  // ── #5 hostAdjustTimer — +5s or -5s on the current turn's clock ─────────────
  socket.on('hostAdjustTimer', ({ delta }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return cb?.({ success: false });
    const gs = room.gameState;
    if (!gs || room.status !== 'playing') return cb?.({ success: false });
    if (gs.pendingWord) return cb?.({ success: false });
    if (typeof delta !== 'number' || !isFinite(delta)) return cb?.({ success: false });

    const elapsed = (Date.now() - gs.timerStartedAt) / 1000;
    const currentRem = Math.max(0, gs.timerSeconds - elapsed);
    let newRem = currentRem + delta;

    if (newRem <= 0) {
      // Subtracting beyond zero → immediate timeout
      clearTimeout(gs.timerHandle);
      gs.timerHandle = null;
      timeoutCurrent(room);
      return cb?.({ success: true, triggeredTimeout: true });
    }

    // Cap total clock at MAX_TIMER_SECS for sanity
    if (newRem > MAX_TIMER_SECS) newRem = MAX_TIMER_SECS;

    // Bump timerSeconds so the timer ring's full-circle reference can hold the
    // new remaining (otherwise ring fraction > 1 looks broken). Also reset
    // timerStartedAt to "now" with the new remaining as the full duration —
    // simplest correct math, ring stays visually clean.
    gs.timerSeconds = newRem;
    gs.timerStartedAt = Date.now();

    clearTimeout(gs.timerHandle);
    gs.timerHandle = setTimeout(() => timeoutCurrent(room), newRem * 1000);
    broadcast(room);
    cb?.({ success: true, newRemaining: newRem });
  });

  // ── #7 hostEndGame — finish now with a chosen winner or none ────────────────
  socket.on('hostEndGame', ({ winnerId }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return cb?.({ success: false });
    if (room.status !== 'playing' && room.status !== 'paused')
      return cb?.({ success: false });

    let winner = null;
    if (winnerId) {
      const p = room.players.get(winnerId);
      if (p && p.alive) winner = p;
      else return cb?.({ success: false, reason: 'اللاعب غير موجود أو خارج اللعبة' });
    }
    endGame(room, winner);
    cb?.({ success: true });
  });

  // ── setTimerMode — host sets per-turn time before game starts ───────────────
  socket.on('setTimerMode', ({ mode }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'host') return cb?.({ success: false });
    if (room.status !== 'lobby' && room.status !== 'ended') return cb?.({ success: false });
    const valid = mode === 'dynamic' || (typeof mode === 'number' && [5, 10, 15, 20, 30].includes(mode));
    if (!valid) return cb?.({ success: false, reason: 'قيمة غير صالحة' });
    room.timerMode = mode;
    broadcast(room);
    cb?.({ success: true });
  });

  // ── leaveRoom — player voluntarily leaves ────────────────────────────────────
  socket.on('leaveRoom', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'player') return cb?.({ success: false });
    const { playerId } = socket.data;
    const player = room.players.get(playerId);
    if (!player) return cb?.({ success: false });

    if (room.status === 'lobby' || room.status === 'ended') {
      room.players.delete(playerId);
      socket.leave(room.code);
      broadcast(room);
    } else if (room.status === 'playing' || room.status === 'paused') {
      if (player.alive) {
        pushEvent(room, { type: 'dropped', playerId, playerName: player.name });
        doEliminate(room, playerId, 'انسحب');
      }
      socket.leave(room.code);
    }
    cb?.({ success: true });
  });

  // ── disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.role === 'host') {
      if (room.status === 'playing') pauseGame(room, 'host', null);
      // If already paused (manual/player), host leaving doesn't change the
      // pause reason — when host reconnects, resume logic handles it.
    } else if (socket.data.role === 'player') {
      const p = room.players.get(socket.data.playerId);
      if (p) {
        p.socketId = null;
        if (room.status === 'playing' && p.alive) {
          pauseGame(room, 'player', p.id);
        } else {
          // Already paused (don't overwrite manual/host pause), or player not
          // alive, or game not running — just broadcast the new connection state.
          broadcast(room);
        }
      }
    }
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`سباق الكلمات — http://localhost:${PORT}`)
);
