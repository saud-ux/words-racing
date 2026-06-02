'use strict';
const { io } = require('socket.io-client');
const BASE = 'http://localhost:3000';

let passed = 0, failed = 0;
function ok(label, cond) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else       { console.error('  FAIL:', label); failed++; }
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Arabic letter helpers (duplicated from server for testing)
const strip = s => s.replace(/[ً-ْٰـ]/g, '');
const unify = ch => 'أإآٱ'.includes(ch) ? 'ا' : ch;
function rnl(word) {
  const w = strip(word).trim(); let l = w[w.length - 1];
  if (l === 'ة' || l === 'ى') l = w[w.length - 2];
  return unify(l);
}
function efl(word) {
  let w = strip(word).trim();
  if (w.length > 2 && w[0] === 'ا' && w[1] === 'ل') w = w.slice(2);
  return unify(w[0]);
}

(async () => {
  console.log('── Letter rule unit tests ──────────────────────');
  ok('rnl(نخلة) === ل',     rnl('نخلة')    === 'ل');
  ok('rnl(مستشفى) === ف',   rnl('مستشفى')  === 'ف');
  ok('rnl(كتاب) === ب',     rnl('كتاب')    === 'ب');
  ok('efl(الكتاب) === ك',   efl('الكتاب')  === 'ك');
  ok('efl(ألم) === ا',      efl('ألم')     === 'ا');
  ok('efl(إبراهيم) === ا',  efl('إبراهيم') === 'ا');

  console.log('\n── Integration tests ──────────────────────────');
  const host   = io(BASE);
  const player = io(BASE);
  const player2 = io(BASE);
  let roomCode, p1id, p2id;

  // Create room
  await new Promise(res => host.emit('createRoom', d => {
    ok('createRoom: success + 4-char code', d.success && d.code.length === 4);
    ok('code excludes 0/O/1/I', !/[0O1I]/.test(d.code));
    roomCode = d.code;
    res();
  }));

  // Join two players
  await new Promise(res => player.emit('joinRoom', { code: roomCode, name: 'أحمد' }, d => {
    ok('player1 joins', d.success);
    p1id = d.playerId;
    res();
  }));
  await new Promise(res => player2.emit('joinRoom', { code: roomCode, name: 'سارة' }, d => {
    ok('player2 joins', d.success);
    p2id = d.playerId;
    res();
  }));

  // Duplicate name rejected
  const dup = io(BASE);
  await new Promise(res => dup.emit('joinRoom', { code: roomCode, name: 'أحمد' }, d => {
    ok('duplicate name rejected', !d.success);
    dup.disconnect(); res();
  }));

  // Bad room code rejected
  await new Promise(res => player.emit('joinRoom', { code: 'XXXX', name: 'مها' }, d => {
    ok('bad room code rejected', !d.success);
    res();
  }));

  // Start game
  await new Promise(res => host.emit('startGame', d => {
    ok('startGame succeeds', d.success);
    res();
  }));
  await delay(200);

  // Player2 cannot join mid-game
  const late = io(BASE);
  await new Promise(res => late.emit('joinRoom', { code: roomCode, name: 'متأخر' }, d => {
    ok('join mid-game rejected', !d.success);
    late.disconnect(); res();
  }));

  // Turn order: p1 goes first (joined first)
  // Submit first word from p1 — free word
  let pending = null;
  host.on('pendingApproval', d => { pending = d; });

  await new Promise(res => player.emit('submitWord', { word: 'نخلة' }, d => {
    ok('submit passes auto-checks → pending', d.success && d.pending);
    res();
  }));
  await delay(200);
  ok('host receives pending word', pending?.word === 'نخلة');

  // Host accepts → requiredLetter becomes ل (نخلة ends in ة, so use ل before it)
  let stateAfterAccept = null;
  const captureState = s => { stateAfterAccept = s; };
  host.once('roomState', captureState);
  await new Promise(res => host.emit('judgeDecision', { accept: true }, d => {
    ok('judgeDecision accept succeeds', d.success);
    res();
  }));
  await delay(200);
  ok('requiredLetter after نخلة is ل', stateAfterAccept?.game?.requiredLetter === 'ل');

  // p2's turn — submit word starting with wrong letter; register listeners first
  let elimP2Reason = null;
  let gameEnded = false;
  player2.once('playerEliminated', e => { elimP2Reason = e.reason; });
  host.once('gameEnded', () => { gameEnded = true; });
  await new Promise(res => player2.emit('submitWord', { word: 'كتاب' }, d => {
    // كتاب starts with ك, required is ل → auto-eliminate
    res();
  }));
  await delay(400);
  ok('wrong letter → auto-eliminated', elimP2Reason === 'حرف خاطئ');
  ok('game ends when 1 player remains', gameEnded);

  // Host can start new game (status was ended)
  await new Promise(res => host.emit('startGame', d => {
    ok('new game starts after ended', d.success);
    res();
  }));
  await delay(100);

  // Reject word (host rejects)
  pending = null;
  await new Promise(res => player.emit('submitWord', { word: 'لعبة' }, d => res()));
  await delay(200);
  ok('pending on new game', !!pending);
  let elimP1Reason = null;
  player.once('playerEliminated', e => { elimP1Reason = e.reason; });
  await new Promise(res => host.emit('judgeDecision', { accept: false }, d => {
    ok('judge reject succeeds', d.success);
    res();
  }));
  await delay(200);
  ok('host reject → رفضها الحكم', elimP1Reason === 'رفضها الحكم');

  console.log('\n─────────────────────────────────────────────────');
  console.log(`Results: ${passed}/${passed + failed} passed`);
  host.disconnect(); player.disconnect(); player2.disconnect();
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
