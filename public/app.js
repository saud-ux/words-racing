'use strict';

// ── LocalStorage keys ─────────────────────────────────────────────────────────
const LS_ROLE   = 'wr_role';
const LS_ROOM   = 'wr_room';
const LS_PID    = 'wr_pid';
const LS_PTOKEN = 'wr_ptoken';
const LS_HTOKEN = 'wr_htoken';
const LS_NAME   = 'wr_name';

// ── Constants ─────────────────────────────────────────────────────────────────
const RING_C = 2 * Math.PI * 45; // SVG circle circumference ≈ 282.74

// ── State ─────────────────────────────────────────────────────────────────────
let socket;
let myRole       = null;   // 'host' | 'player'
let myPlayerId   = null;
let myPlayerName = null;
let roomCode     = null;
let roomState    = null;   // latest state from server
let isEliminated = false;
let myElimReason = null;
let pendingDropId = null;  // player the host is about to drop

// ── Animation state tracking ──────────────────────────────────────────────────
let prevCurrentWord  = null;   // detect word acceptance
let prevStatus       = null;   // detect game-start transition
let prevPendingWord  = null;   // detect new pending word for host
let lastTimerSecond  = -1;     // detect second boundary for tick animation

// ── Audio & haptics ─────────────────────────────────────────────────────────
const LS_SOUND = 'wr_sound';
let audioCtx     = null;
let soundEnabled = localStorage.getItem(LS_SOUND) !== 'off';
let lastTickAt   = 0;       // perf timestamp of last tick/heartbeat

// Lazily create / resume the AudioContext (must follow a user gesture)
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch (_) { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Unlock audio on the very first interaction (browser autoplay policy)
function unlockAudio() {
  ensureAudio();
  window.removeEventListener('pointerdown', unlockAudio);
  window.removeEventListener('keydown', unlockAudio);
}

function vibrate(pattern) {
  if (soundEnabled && navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch (_) {}
  }
}

// A single enveloped oscillator note
function tone(freq, { type = 'sine', dur = 0.08, vol = 0.2, attack = 0.005, glideTo = null, when = 0 } = {}) {
  if (!soundEnabled || !audioCtx) return;
  const t0   = audioCtx.currentTime + when;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

const sfxTick = (urgent, vol) =>
  tone(urgent ? 1320 : 880, { type: 'square', dur: 0.035, vol: vol * (urgent ? 1 : 0.85), attack: 0.001 });

function sfxHeartbeat(vol) {
  tone(70, { type: 'sine', dur: 0.16, vol });
  tone(55, { type: 'sine', dur: 0.18, vol: vol * 0.9, when: 0.14 });
}

function sfxYourTurn() {
  tone(660, { type: 'triangle', dur: 0.12, vol: 0.25 });
  tone(990, { type: 'triangle', dur: 0.16, vol: 0.25, when: 0.1 });
}

function sfxEliminated(strong) {
  tone(320, { type: 'sawtooth', dur: 0.5, vol: strong ? 0.4 : 0.22, glideTo: 70 });
  if (strong) tone(150, { type: 'square', dur: 0.5, vol: 0.2, glideTo: 50 });
}

function sfxWin(big) {
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  notes.forEach((f, i) => tone(f, { type: 'triangle', dur: 0.3, vol: big ? 0.35 : 0.22, when: i * 0.12 }));
  if (big) tone(1318.5, { type: 'triangle', dur: 0.5, vol: 0.3, when: notes.length * 0.12 });
}

function sfxAccept() {
  // Bright ascending arpeggio — satisfying confirmation
  tone(523, { type: 'triangle', dur: 0.1,  vol: 0.26, when: 0    });
  tone(659, { type: 'triangle', dur: 0.12, vol: 0.26, when: 0.07 });
  tone(784, { type: 'triangle', dur: 0.22, vol: 0.30, when: 0.15 });
}

function sfxReject() {
  // Short descending growl — unmistakably wrong
  tone(280, { type: 'sawtooth', dur: 0.22, vol: 0.28, glideTo: 100 });
}

function sfxSubmit() {
  // Subtle upward flick when a word is sent
  tone(660, { type: 'sine', dur: 0.10, vol: 0.11, glideTo: 990 });
}

function sfxGameStart() {
  // Dramatic fanfare — builds excitement
  tone(392,  { type: 'triangle', dur: 0.15, vol: 0.32, when: 0    });
  tone(523,  { type: 'triangle', dur: 0.18, vol: 0.34, when: 0.15 });
  tone(784,  { type: 'triangle', dur: 0.30, vol: 0.38, when: 0.32 });
  tone(1047, { type: 'triangle', dur: 0.50, vol: 0.36, when: 0.55 });
}

function sfxCountdownBlip() {
  // Single blip for 3-2-1 countdown
  tone(440, { type: 'square', dur: 0.07, vol: 0.22 });
}

function sfxNewPending() {
  // Alert ping when a word arrives for the host to judge
  tone(1100, { type: 'sine', dur: 0.18, vol: 0.18 });
  tone(880,  { type: 'sine', dur: 0.14, vol: 0.12, when: 0.12 });
}

function flashDanger() {
  const v = document.getElementById('danger-vignette');
  if (!v) return;
  v.classList.add('flash');
  setTimeout(() => v.classList.remove('flash'), 600);
}

function clearTension() {
  const v = document.getElementById('danger-vignette');
  if (v) v.classList.remove('active', 'mine');
  document.querySelectorAll('.timer-container').forEach(el => el.classList.remove('shake'));
  lastTickAt = 0;
}

// ── Animation helpers ─────────────────────────────────────────────────────────

function animatePop(el) {
  if (!el) return;
  el.classList.remove('anim-pop');
  void el.offsetWidth;
  el.classList.add('anim-pop');
}

function animateLetterFlash(el) {
  if (!el) return;
  el.classList.remove('anim-letter-flash');
  void el.offsetWidth;
  el.classList.add('anim-letter-flash');
}

function animateTimerTick(el) {
  if (!el) return;
  el.classList.remove('anim-timer-tick');
  void el.offsetWidth;
  el.classList.add('anim-timer-tick');
}

// 3-2-1 countdown splash then انطلق
function showGameStartSplash() {
  sfxGameStart();
  const overlay = document.getElementById('splash-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  const textEl = overlay.querySelector('.splash-text');
  const steps  = ['٣', '٢', '١', 'انطلق!'];
  let i = 0;
  const tick = () => {
    if (i >= steps.length) { overlay.classList.add('hidden'); return; }
    if (i < 3) sfxCountdownBlip();
    textEl.textContent = steps[i];
    textEl.classList.remove('anim-splash');
    void textEl.offsetWidth;
    textEl.classList.add('anim-splash');
    i++;
    setTimeout(tick, i < steps.length ? 380 : 720);
  };
  tick();
}

// CSS confetti burst on win
function spawnConfetti(count = 90) {
  const container = document.createElement('div');
  container.className = 'confetti-container';
  document.body.appendChild(container);
  const colors = ['#f59e0b','#10b981','#3b82f6','#ef4444','#8b5cf6','#ec4899','#f97316'];
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-particle';
    const size = 5 + Math.random() * 9;
    p.style.cssText = [
      `left:${Math.random() * 100}%`,
      `background:${colors[Math.floor(Math.random() * colors.length)]}`,
      `width:${size}px`,
      `height:${size}px`,
      `animation-duration:${1.6 + Math.random() * 2.4}s`,
      `animation-delay:${Math.random() * 0.8}s`,
      `border-radius:${Math.random() > 0.5 ? '50%' : '2px'}`,
    ].join(';');
    container.appendChild(p);
  }
  setTimeout(() => container.remove(), 5500);
}

// Full-screen red flash when YOU are eliminated
function flashElimScreen() {
  const el = document.getElementById('elim-flash-overlay');
  if (!el) return;
  el.classList.remove('anim-elim-flash');
  void el.offsetWidth;
  el.classList.add('anim-elim-flash');
}

// Map x in [x0,x1] to [y0,y1], clamped
function mapClamp(x, x0, x1, y0, y1) {
  const t = Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
  return y0 + (y1 - y0) * t;
}

function tickIntervalMs(rem) {
  // rem in (3,6] → 900ms..380ms ; rem in [0,3] → 520ms..230ms
  return rem > 3 ? mapClamp(rem, 6, 3, 900, 380)
                 : mapClamp(rem, 3, 0, 520, 230);
}

// Drive ticking, heartbeat, vibration and the red vignette from the live timer
function updateTension(game, rem) {
  const playing  = roomState && roomState.status === 'playing';
  const liveTurn = playing && game && !game.pendingWord && !game.pausedReason && game.currentTurnPlayerId;

  if (!liveTurn) { clearTension(); return; }

  const isMyTurn  = myRole === 'player' && !isEliminated && game.currentTurnPlayerId === myPlayerId;
  const intensity = isMyTurn ? 1 : 0.45; // spectators & host hear it softer
  const now       = performance.now();

  // Audio: ticking in the final 6s, heartbeat in the final 3s
  if (rem <= 6) {
    if (now - lastTickAt >= tickIntervalMs(rem)) {
      lastTickAt = now;
      if (rem <= 3) {
        sfxHeartbeat(0.5 * intensity);
        if (isMyTurn) vibrate(55);
      } else {
        sfxTick(rem <= 4.5, 0.12 * intensity);
      }
    }
  } else {
    lastTickAt = 0;
  }

  // Visuals: red vignette + timer shake in the final 3s
  const danger = rem <= 3;
  const v = document.getElementById('danger-vignette');
  if (v) {
    v.classList.toggle('active', danger);
    v.classList.toggle('mine', danger && isMyTurn);
  }
  document.querySelectorAll('.timer-container')
    .forEach(el => el.classList.toggle('shake', danger && isMyTurn));
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  socket = io();
  setupSocketListeners();
  setupUIListeners();
  setupSoundToggle();
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);
  startTimerLoop();
  tryReconnect();
});

// ── Reconnect on page load ────────────────────────────────────────────────────
function tryReconnect() {
  const role = localStorage.getItem(LS_ROLE);
  const code = localStorage.getItem(LS_ROOM);
  if (!role || !code) return;

  if (role === 'host') {
    const hToken = localStorage.getItem(LS_HTOKEN);
    if (!hToken) { clearSession(); showScreen('landing'); return; }
    socket.emit('reconnectHost', { code, hostToken: hToken }, res => {
      if (!res.success) { clearSession(); showScreen('landing'); return; }
      myRole = 'host';
      roomCode = code;
      handleRoomState(res.roomState);
    });

  } else if (role === 'player') {
    const pid  = localStorage.getItem(LS_PID);
    const tok  = localStorage.getItem(LS_PTOKEN);
    const name = localStorage.getItem(LS_NAME);
    if (!pid || !tok) { clearSession(); showScreen('landing'); return; }
    socket.emit('joinRoom', { code, name, playerId: pid, token: tok }, res => {
      if (!res.success) { clearSession(); showScreen('landing'); return; }
      myRole       = 'player';
      myPlayerId   = res.playerId;
      myPlayerName = res.playerName || name;
      roomCode     = code;
      const me = res.roomState?.players?.find(p => p.id === myPlayerId);
      if (me?.eliminated) { isEliminated = true; myElimReason = me.eliminationReason; }
      handleRoomState(res.roomState);
    });
  }
}

function clearSession() {
  [LS_ROLE, LS_ROOM, LS_PID, LS_PTOKEN, LS_HTOKEN, LS_NAME].forEach(k => localStorage.removeItem(k));
}

// ── Socket listeners ──────────────────────────────────────────────────────────
function setupSocketListeners() {
  socket.on('roomState',       handleRoomState);
  socket.on('playerEliminated', handlePlayerEliminated);
  socket.on('gameEnded',        handleGameEnded);
  socket.on('gameResumed',      () => handleRoomState(roomState)); // will get fresh roomState momentarily
  socket.on('yourTurn',         handleYourTurn);
  socket.on('pendingApproval',  handlePendingApproval);
  socket.on('kickedFromRoom',   () => { clearSession(); showScreen('landing'); });
}

// ── Central render dispatch ───────────────────────────────────────────────────
function handleRoomState(state) {
  if (!state) return;

  // ── Detect transitions for animations / sounds ─────────────────────────────
  const prev = roomState;
  if (prev) {
    // Lobby → Playing: show countdown splash
    if (state.status === 'playing' && prev.status === 'lobby') {
      showGameStartSplash();
    }

    // New word accepted (currentWord changed)
    const prevWord = prev.game?.currentWord;
    const newWord  = state.game?.currentWord;
    if (newWord && newWord !== prevWord && prevCurrentWord !== undefined) {
      sfxAccept();
      requestAnimationFrame(() => {
        animatePop(document.getElementById('player-current-word'));
        animatePop(document.getElementById('host-current-word'));
        animateLetterFlash(document.getElementById('player-required-letter'));
        animateLetterFlash(document.getElementById('host-required-letter'));
      });
    }
    prevCurrentWord = newWord ?? null;

    // New pending word arrived for host
    const prevPend = prev.game?.pendingWord;
    const newPend  = state.game?.pendingWord;
    if (newPend && newPend !== prevPend) {
      sfxNewPending();
      requestAnimationFrame(() => {
        const panel = document.getElementById('host-approval-panel');
        if (panel && !panel.classList.contains('hidden')) animatePop(panel);
      });
    }
    prevPendingWord = newPend ?? null;
  }

  prevStatus = state.status;

  roomState = state;
  const { status, game } = state;

  // If game restarted after winner screen, un-eliminate me (new round)
  if (status === 'playing' && isEliminated) {
    const me = state.players.find(p => p.id === myPlayerId);
    if (me && me.alive) { isEliminated = false; myElimReason = null; }
  }

  if (myRole === 'host') {
    if (status === 'ended') {
      showScreen('winner');
      renderWinner(state, /* isHost */ true);
    } else if (status === 'lobby') {
      showScreen('host-lobby');
      renderHostLobby(state);
    } else {
      showScreen('host-game');
      renderHostGame(state);
    }
    return;
  }

  if (myRole === 'player') {
    if (status === 'ended') {
      showScreen('winner');
      renderWinner(state, /* isHost */ false);
      hidePausedOverlay();
      return;
    }
    if (isEliminated) {
      showScreen('eliminated');
      renderEliminated(state);
      updatePausedOverlay(state);
      return;
    }
    if (status === 'lobby') {
      showScreen('player-lobby');
      renderPlayerLobby(state);
      hidePausedOverlay();
    } else {
      showScreen('player-game');
      renderPlayerGame(state);
      updatePausedOverlay(state);
    }
  }
}

// ── Screen switching ──────────────────────────────────────────────────────────
const ALL_SCREENS = [
  'landing', 'host-lobby', 'player-lobby',
  'host-game', 'player-game', 'eliminated', 'winner',
];

function showScreen(name) {
  ALL_SCREENS.forEach(s => {
    const el = document.getElementById('screen-' + s);
    el.classList.toggle('hidden', s !== name);
    // Clear the inline display:none (added to each screen to avoid a pre-CSS
    // load flash); from here on the .hidden / .screen classes govern visibility.
    el.style.display = '';
  });
}

// ── Render: host lobby ────────────────────────────────────────────────────────
function renderHostLobby(state) {
  document.getElementById('host-room-code').textContent  = state.code;
  document.getElementById('host-lobby-count').textContent = state.players.length;
  renderPlayerList('host-lobby-players', state.players, null, null);
  // Show new-game hint if returning from ended game
  const startBtn = document.getElementById('btn-start-game');
  startBtn.textContent = state.lastWinner ? '🔄 بدء لعبة جديدة' : 'بدء اللعبة';
  // Sync timer mode buttons
  const currentMode = state.timerMode ?? 'dynamic';
  document.querySelectorAll('#host-timer-opts .timer-opt').forEach(btn => {
    const val = btn.dataset.secs === 'dynamic' ? 'dynamic' : parseInt(btn.dataset.secs, 10);
    btn.classList.toggle('active', val === currentMode || (btn.dataset.secs === 'dynamic' && currentMode === 'dynamic'));
  });
}

// ── Render: player lobby ──────────────────────────────────────────────────────
function renderPlayerLobby(state) {
  document.getElementById('player-lobby-code').textContent  = state.code;
  document.getElementById('player-lobby-count').textContent = state.players.length;
  renderPlayerList('player-lobby-players', state.players, null, myPlayerId);
}

// ── Render: player game ───────────────────────────────────────────────────────
function renderPlayerGame(state) {
  const game = state.game;
  if (!game) return;

  const isMeTurn   = game.currentTurnPlayerId === myPlayerId;
  const isPending  = !!game.pendingWord;
  const isPaused   = !!game.pausedReason;
  const canSubmit  = isMeTurn && !isPending && !isPaused && state.status === 'playing';

  // Turn status banner
  const banner = document.getElementById('turn-status');
  if (isPending && isMeTurn) {
    banner.className = 'turn-status turn-pending';
    banner.textContent = '⏳ في انتظار قرار الحكم...';
  } else if (isMeTurn) {
    banner.className = 'turn-status turn-active';
    banner.textContent = '🎯 دورك الآن!';
  } else {
    banner.className = 'turn-status turn-waiting';
    const turnPlayer = state.players.find(p => p.id === game.currentTurnPlayerId);
    banner.textContent = `في انتظار: ${turnPlayer?.name || '...'}`;
  }

  // Current word & required letter
  document.getElementById('player-current-word').textContent   = game.currentWord || '—';
  document.getElementById('player-required-letter').textContent = game.requiredLetter || '—';

  // Submit area
  const input   = document.getElementById('player-word-input');
  const btn     = document.getElementById('btn-submit-word');
  input.disabled = !canSubmit;
  btn.disabled   = !canSubmit;
  document.querySelector('.submit-area')?.classList.toggle('my-turn', canSubmit);

  document.getElementById('pending-notice').classList.toggle('hidden', !(isPending && isMeTurn));

  // Players list
  renderPlayerList('player-game-players', state.players, game.currentTurnPlayerId, myPlayerId);

  // Words list
  renderWordsList('player-used-words', 'player-words-count', game.usedWords, game.requiredLetter);
}

// ── Render: host game ─────────────────────────────────────────────────────────
function renderHostGame(state) {
  const game   = state.game;
  const status = state.status;

  document.getElementById('host-game-code').textContent = state.code;

  if (!game) {
    // Ended state while on host-game screen shouldn't happen, but guard anyway
    document.getElementById('host-new-game-panel').classList.remove('hidden');
    return;
  }

  document.getElementById('host-tier-badge').textContent    = game.tierLabel || '—';
  document.getElementById('host-current-word').textContent  = game.currentWord || '—';
  document.getElementById('host-required-letter').textContent = game.requiredLetter || '—';

  // Approval panel
  const approvalPanel = document.getElementById('host-approval-panel');
  if (game.pendingWord) {
    approvalPanel.classList.remove('hidden');
    document.getElementById('approval-player-name').textContent = game.pendingPlayerName || '';
    document.getElementById('approval-word-text').textContent   = game.pendingWord;
  } else {
    approvalPanel.classList.add('hidden');
  }

  // Pause controls (only when paused due to player disconnect)
  const pausePanel = document.getElementById('host-pause-controls');
  if (status === 'paused' && game.pausedReason === 'player' && game.pausedForPlayerId) {
    pausePanel.classList.remove('hidden');
    pendingDropId = game.pausedForPlayerId;
    document.getElementById('host-pause-msg').textContent =
      `انقطع اتصال اللاعب: ${game.pausedForPlayerName || ''}`;
  } else {
    pausePanel.classList.add('hidden');
    pendingDropId = null;
  }

  // New game panel
  document.getElementById('host-new-game-panel').classList.add('hidden');

  // Players & words
  renderPlayerList('host-game-players', state.players, game.currentTurnPlayerId, null);
  renderWordsList('host-used-words', 'host-words-count', game.usedWords, game.requiredLetter);
}

// ── Render: eliminated spectator ──────────────────────────────────────────────
function renderEliminated(state) {
  const game = state.game;
  document.getElementById('elim-reason').textContent        = myElimReason || '';
  document.getElementById('elim-current-word').textContent  = game?.currentWord || '—';
  document.getElementById('elim-required-letter').textContent = game?.requiredLetter || '—';
  renderPlayerList('elim-players', state.players.filter(p => p.alive), game?.currentTurnPlayerId, null);
  renderWordsList('elim-used-words', 'elim-words-count', game?.usedWords || [], game?.requiredLetter);
}

// ── Render: winner ────────────────────────────────────────────────────────────
function renderWinner(state, isHost) {
  const w = state.lastWinner;
  document.getElementById('winner-name').textContent = w?.name || 'لا يوجد فائز';
  const btn = document.getElementById('btn-winner-new-game');
  btn.classList.toggle('hidden', !isHost);
}

// ── Render: player list ───────────────────────────────────────────────────────
function renderPlayerList(listId, players, currentTurnId, selfId) {
  const ul = document.getElementById(listId);
  if (!ul) return;
  ul.innerHTML = '';
  players.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'player-item';
    if (p.id === currentTurnId) li.classList.add('is-current-turn');
    if (p.id === selfId)        li.classList.add('is-me');
    if (p.eliminated)           li.classList.add('is-eliminated');
    if (!p.connected && !p.eliminated) li.classList.add('is-disconnected');

    const avatarClass = p.eliminated ? 'dead' : (p.id === currentTurnId ? 'current' : 'alive');
    const avatarChar  = p.name.charAt(0);

    const tags = [];
    if (p.id === selfId)        tags.push({ text: 'أنت',       cls: 'tag-me' });
    if (p.id === currentTurnId) tags.push({ text: 'دوره الآن', cls: 'tag-turn' });
    if (!p.connected && !p.eliminated) tags.push({ text: 'منقطع', cls: 'tag-dc' });
    if (p.eliminated)           tags.push({ text: p.eliminationReason || 'خرج', cls: 'tag-elim' });

    li.innerHTML = `
      <div class="player-avatar ${avatarClass}">${avatarChar}</div>
      <span class="player-name">${escHtml(p.name)}</span>
      ${tags.map(t => `<span class="player-tag ${t.cls}">${t.text}</span>`).join('')}
    `;
    ul.appendChild(li);
  });
}

// ── Render: words list ────────────────────────────────────────────────────────
function renderWordsList(listId, countId, words, nextLetter) {
  const ul = document.getElementById(listId);
  const ct = document.getElementById(countId);
  if (!ul) return;
  if (ct) ct.textContent = (words || []).length;
  ul.innerHTML = '';
  (words || []).slice().reverse().forEach((entry, ri) => {
    const wordText   = typeof entry === 'object' ? entry.word       : entry;
    const playerName = typeof entry === 'object' ? entry.playerName : null;
    const idx  = (words.length - ri);
    const next = (ri === 0 && nextLetter) ? nextLetter : '';
    const li   = document.createElement('li');
    li.className = 'word-item';
    li.innerHTML = `
      <span class="word-index">${idx}</span>
      <span class="word-text">${escHtml(wordText)}</span>
      ${playerName ? `<span class="word-by">${escHtml(playerName)}</span>` : ''}
      ${next ? `<span class="word-letter">→ ${next}</span>` : ''}
    `;
    ul.appendChild(li);
  });
}

// ── Paused overlay (for players) ──────────────────────────────────────────────
function updatePausedOverlay(state) {
  const game = state.game;
  if (state.status === 'paused' && game?.pausedReason) {
    showPausedOverlay(game.pausedReason, game.pausedForPlayerName);
  } else {
    hidePausedOverlay();
  }
}

function showPausedOverlay(reason, playerName) {
  document.getElementById('overlay-paused').classList.remove('hidden');
  if (reason === 'host') {
    document.getElementById('overlay-title').textContent = 'اللعبة متوقفة';
    document.getElementById('overlay-msg').textContent   = 'في انتظار عودة الحكم...';
  } else {
    document.getElementById('overlay-title').textContent = 'اللعبة متوقفة مؤقتاً';
    document.getElementById('overlay-msg').textContent   = `انقطع اتصال اللاعب: ${playerName || ''}`;
  }
}

function hidePausedOverlay() {
  document.getElementById('overlay-paused').classList.add('hidden');
}

// ── Elimination event ─────────────────────────────────────────────────────────
function handlePlayerEliminated(data) {
  const isMe = data.playerId === myPlayerId;
  if (data.reason === 'رفضها الحكم') sfxReject();
  sfxEliminated(isMe);
  clearTension();
  if (isMe) {
    vibrate([200, 80, 200]);
    flashDanger();
    flashElimScreen();
    isEliminated  = true;
    myElimReason  = data.reason;
    showScreen('eliminated');
    if (roomState) renderEliminated(roomState);
  }
}

// ── Game ended event ──────────────────────────────────────────────────────────
function handleGameEnded(data) {
  const iWon = data.winnerId && data.winnerId === myPlayerId;
  sfxWin(iWon || myRole === 'host');
  if (iWon) vibrate([100, 50, 100, 50, 220]);
  clearTension();
  if (iWon || myRole === 'host') spawnConfetti(iWon ? 110 : 70);
  // roomState with status='ended' will follow; just ensure we reset input state
  const input = document.getElementById('player-word-input');
  if (input) { input.value = ''; input.disabled = true; }
}

// ── Your turn ─────────────────────────────────────────────────────────────────
function handleYourTurn(data) {
  // roomState update follows; focus input if it's my turn
  if (data.playerId === myPlayerId) {
    sfxYourTurn();
    vibrate([40, 40, 40]);
    setTimeout(() => {
      const input = document.getElementById('player-word-input');
      if (input && !input.disabled) input.focus();
    }, 100);
  }
}

// ── Pending approval (host only) ──────────────────────────────────────────────
function handlePendingApproval(data) {
  // roomState will reflect this; just ensure host is on game screen
  if (myRole === 'host' && roomState) handleRoomState(roomState);
}

// ── Timer loop ────────────────────────────────────────────────────────────────
function startTimerLoop() {
  setInterval(updateTimers, 100);
}

function computeRemaining(game) {
  if (!game) return 0;
  if (game.pausedReason) return game.frozenTimeRemaining ?? game.timerSeconds;
  if (game.pendingWord) {
    // Timer was stopped when word was submitted
    if (game.timerStoppedAt && game.timerStartedAt) {
      return Math.max(0, game.timerSeconds - (game.timerStoppedAt - game.timerStartedAt) / 1000);
    }
    return game.timerSeconds;
  }
  if (!game.timerStartedAt) return game.timerSeconds;
  return Math.max(0, game.timerSeconds - (Date.now() - game.timerStartedAt) / 1000);
}

function updateTimers() {
  const game  = roomState?.game;
  const total = game?.timerSeconds || 10;
  const rem   = computeRemaining(game);
  const pct   = total > 0 ? rem / total : 0;
  const color = rem <= 2 ? '#ef4444'
              : rem <= 4 ? '#f97316'
              : rem <= 7 ? '#f59e0b'
              : '#10b981';
  const offset  = RING_C * (1 - pct);
  const display = Math.ceil(rem);

  // Pulse the timer number on each new second
  if (game && display !== lastTimerSecond && display >= 0) {
    lastTimerSecond = display;
    document.querySelectorAll('.timer-number').forEach(animateTimerTick);
  }

  for (const prefix of ['player', 'host']) {
    const ring = document.getElementById(`${prefix}-ring-fg`);
    const num  = document.getElementById(`${prefix}-timer-number`);
    if (ring) {
      ring.style.strokeDashoffset = offset;
      ring.style.stroke = color;
    }
    if (num) {
      num.textContent = game ? display : '—';
      // Grow the number slightly as urgency increases
      num.style.fontSize = rem <= 2 ? '2.6rem' : rem <= 4 ? '2.2rem' : '2rem';
      num.style.color    = rem <= 4 ? color : '';
    }
  }

  updateTension(game, rem);
}

// ── UI event listeners ────────────────────────────────────────────────────────
function setupUIListeners() {

  // Create room (host)
  document.getElementById('btn-create').addEventListener('click', () => {
    socket.emit('createRoom', res => {
      if (!res.success) return;
      myRole   = 'host';
      roomCode = res.code;
      localStorage.setItem(LS_ROLE,   'host');
      localStorage.setItem(LS_ROOM,   res.code);
      localStorage.setItem(LS_HTOKEN, res.hostToken);
      showScreen('host-lobby');
      document.getElementById('host-room-code').textContent = res.code;
      document.getElementById('host-lobby-count').textContent = '0';
      document.getElementById('host-lobby-players').innerHTML = '';
    });
  });

  // Join room (player)
  document.getElementById('btn-join').addEventListener('click', joinRoom);
  document.getElementById('input-room-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('input-player-name').focus();
  });
  document.getElementById('input-player-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinRoom();
  });

  // Start game (host lobby)
  document.getElementById('btn-start-game').addEventListener('click', () => {
    socket.emit('startGame', res => {
      if (res && !res.success) alert(res.reason || 'خطأ في بدء اللعبة');
    });
  });

  // Submit word (player game)
  document.getElementById('btn-submit-word').addEventListener('click', submitWord);
  document.getElementById('player-word-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitWord();
  });

  // Judge: accept / reject
  document.getElementById('btn-accept').addEventListener('click', () => {
    socket.emit('judgeDecision', { accept: true });
  });
  document.getElementById('btn-reject').addEventListener('click', () => {
    socket.emit('judgeDecision', { accept: false });
  });

  // Host: wait for player
  document.getElementById('btn-wait-player').addEventListener('click', () => {
    // Default state — just close the panel UI, game stays paused
    // (Nothing to emit; game is already paused waiting)
  });

  // Host: drop player
  document.getElementById('btn-drop-player').addEventListener('click', () => {
    if (!pendingDropId) return;
    socket.emit('hostDropPlayer', { playerId: pendingDropId }, res => {
      if (res && !res.success) alert('تعذّر إزالة اللاعب');
    });
  });

  // New game (host game screen)
  document.getElementById('btn-new-game').addEventListener('click', startNewGame);

  // New game (winner screen — host only)
  document.getElementById('btn-winner-new-game').addEventListener('click', startNewGame);

  // Timer mode selector (host lobby)
  document.getElementById('host-timer-opts').addEventListener('click', e => {
    const btn = e.target.closest('.timer-opt');
    if (!btn) return;
    const raw  = btn.dataset.secs;
    const mode = raw === 'dynamic' ? 'dynamic' : parseInt(raw, 10);
    socket.emit('setTimerMode', { mode });
  });

  // Leave lobby (player)
  document.getElementById('btn-leave-lobby').addEventListener('click', () => {
    socket.emit('leaveRoom', {}, () => {
      clearSession();
      myRole = null; myPlayerId = null; myPlayerName = null; roomCode = null; roomState = null;
      isEliminated = false; myElimReason = null;
      showScreen('landing');
    });
  });

  // Leave game (player during game)
  document.getElementById('btn-leave-game').addEventListener('click', () => {
    if (!confirm('هل أنت متأكد أنك تريد مغادرة اللعبة؟')) return;
    socket.emit('leaveRoom', {}, () => {
      clearSession();
      myRole = null; myPlayerId = null; myPlayerName = null; roomCode = null; roomState = null;
      isEliminated = false; myElimReason = null;
      showScreen('landing');
    });
  });
}

// ── Sound / haptics toggle ────────────────────────────────────────────────────
function setupSoundToggle() {
  const btn = document.getElementById('btn-sound-toggle');
  if (!btn) return;
  const render = () => {
    btn.textContent = soundEnabled ? '🔊' : '🔇';
    btn.classList.toggle('muted', !soundEnabled);
  };
  render();
  btn.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem(LS_SOUND, soundEnabled ? 'on' : 'off');
    render();
    if (soundEnabled) { ensureAudio(); sfxYourTurn(); }   // unlock + sample
    else { if (navigator.vibrate) navigator.vibrate(0); clearTension(); }
  });
}

function joinRoom() {
  const code = document.getElementById('input-room-code').value.trim().toUpperCase();
  const name = document.getElementById('input-player-name').value.trim();
  const errEl = document.getElementById('landing-error');

  if (!code || code.length !== 4) { showError(errEl, 'أدخل رمز الغرفة (4 أحرف)'); return; }
  if (!name)                       { showError(errEl, 'أدخل اسمك'); return; }

  errEl.classList.add('hidden');

  socket.emit('joinRoom', { code, name }, res => {
    if (!res.success) { showError(errEl, res.reason || 'خطأ في الانضمام'); return; }
    myRole       = 'player';
    myPlayerId   = res.playerId;
    myPlayerName = res.playerName || name;
    roomCode     = res.roomState?.code || code;
    localStorage.setItem(LS_ROLE,   'player');
    localStorage.setItem(LS_ROOM,   roomCode);
    localStorage.setItem(LS_PID,    res.playerId);
    localStorage.setItem(LS_PTOKEN, res.token);
    localStorage.setItem(LS_NAME,   myPlayerName);
    handleRoomState(res.roomState);
  });
}

function submitWord() {
  const input = document.getElementById('player-word-input');
  const errEl = document.getElementById('submit-error');
  const word  = input.value.trim();

  if (!word) { showError(errEl, 'الكلمة فارغة'); return; }
  if (/\s/.test(word)) { showError(errEl, 'كلمة واحدة فقط بدون مسافات'); return; }

  errEl.classList.add('hidden');
  input.disabled = true;
  document.getElementById('btn-submit-word').disabled = true;
  sfxSubmit();

  socket.emit('submitWord', { word }, res => {
    if (res && !res.success && !res.pending) {
      // Auto-eliminated — handled by playerEliminated event
      input.value = '';
    } else if (res?.pending) {
      input.value = '';
      document.getElementById('pending-notice').classList.remove('hidden');
    }
  });
}

function startNewGame() {
  socket.emit('startGame', res => {
    if (res && !res.success) alert(res.reason || 'خطأ في بدء اللعبة');
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
