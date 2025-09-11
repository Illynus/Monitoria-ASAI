const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 25000, pingTimeout: 90000 });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ===== Utils =====
function code(){
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let o='';
  for(let i=0;i<5;i++) o+=c[Math.floor(Math.random()*c.length)];
  return o;
}
function now(){ return Date.now(); }

function shuffleIdx(n){
  const a=[...Array(n).keys()];
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function timeLeftMs(room){
  if (!room.questionStart || room.phase!=='question') return 0;
  const elapsed = now() - room.questionStart;
  return Math.max(0, room.timeLimitMs - elapsed);
}

function emitCurrentQuestionTo(socket, room){
  const idx0 = room.currentIdx;
  const q = room.questions[idx0];
  if (!q) return;
  let dto = null;
  if (q.type==='processo_q1'){
    const order = room.view.tokensOrder || [...Array(q.tokens.length).keys()];
    const tokensShuffled = order.map(i=>q.tokens[i]);
    dto = { type:q.type, case:q.case, tokens:tokensShuffled, prompt:q.prompt };
  } else if (q.type==='processo_qMulti'){
    const order = room.view.optionsOrder || [...Array(q.options.length).keys()];
    const optionsShuffled = order.map(i=>q.options[i]);
    dto = { type:q.type, case:q.case, options:optionsShuffled, prompt:q.prompt, selectCount:q.selectCount||3 };
  } else if (q.type==='bio_abcd'){
    dto = { type:q.type, question:q.question, choices:q.choices };
  }
  const left = room.phase==='question' ? timeLeftMs(room) : 0;
  socket.emit('newQuestion', { idx: idx0+1, total: room.questions.length, timeLimitMs: left || room.timeLimitMs, q: dto });
  if (room.phase==='reveal'){
    let payload = null;
    if (q.type==='processo_qMulti'){
      payload = { correct: (room.view && Array.isArray(room.view.correctDisplay)) ? room.view.correctDisplay : q.correct };
    } else if (q.type==='processo_q1'){
      payload = { answerText: q.answerText };
    } else if (q.type==='bio_abcd'){
      payload = { correct: q.correct };
    }
    socket.emit('reveal', { correct: payload });
  }
  socket.emit('leaderboard', leaderboard(room));
}

// ===== State =====
const rooms = new Map();
const sid2pid = new Map();
const sid2room = new Map();

// ===== Data =====
const perguntasProcesso = JSON.parse(fs.readFileSync(path.join(__dirname,'public','data','perguntas_processo.json'),'utf8'));
const perguntasBio = JSON.parse(fs.readFileSync(path.join(__dirname,'public','data','perguntas_bioseguranca.json'),'utf8'));
const perguntasGastro = JSON.parse(fs.readFileSync(path.join(__dirname,'public','data','perguntas_gastro_endocrino.json'),'utf8'));

function loadQuestions(gameType){
  if (gameType==='processo') return JSON.parse(JSON.stringify(perguntasProcesso));
  if (gameType==='bioseg') return JSON.parse(JSON.stringify(perguntasBio));
  if (gameType==='gastro') return JSON.parse(JSON.stringify(perguntasGastro));
  return [];
}

function makeRoom(gameType, hostId){
  let roomCode = code(); while (rooms.has(roomCode)) roomCode = code();
  const room = {
    code:roomCode,
    hostId,
    gameType,
    players:new Map(),
    createdAt:now(),
    currentIdx:0,
    phase:'lobby',
    questionStart:null,
    timeLimitMs:180000,
    questions:loadQuestions(gameType),
    view:{}
  };
  rooms.set(roomCode, room);
  return room;
}
function getRoom(c){ return rooms.get((c||'').toUpperCase()); }

function roomToLobbyDTO(room) {
  return {
    code: room.code,
    gameType: room.gameType,
    phase: room.phase,
    playerCount: room.players.size,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      nick: p.nick,
      avatar: p.avatar,
      score: p.score,
      offline: !!p.offline
    }))
  };
}

function leaderboard(room){
  return Array.from(room.players.values())
    .sort((a, b) => b.score - a.score)
    .map((p, idx) => ({
      pos: idx + 1,
      id: p.id,
      nick: p.nick,
      avatar: p.avatar,
      score: p.score
    }));}

function normalize(s){ return (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toLowerCase(); }
function stemToken(tok){ return (tok||'').toLowerCase().replace(/(ado|ada|ido|ida|a|o)$/,''); }
function expectedTokensFromAnswer(q){
  const ans = normalize(q.answerText||'');
  const required = [];
  (q.tokens||[]).forEach(t=>{ const nt = normalize(t); if (ans.includes(nt)) required.push(t); });
  const seen = new Set(); const out=[];
  required.forEach(t=>{ const k=stemToken(normalize(t)); if (!seen.has(k)){ seen.add(k); out.push(t);} });
  return out;
}

// ===== Socket.IO =====
io.on('connection', (socket)=>{

  socket.on('rejoinRoom', ({roomCode, playerId})=>{
    roomCode = (roomCode||'').toUpperCase(); const room = getRoom(roomCode);
    if (!room || !playerId) return socket.emit('errorMsg','Reentrada inválida.');
    if (!room.players.has(playerId)) return socket.emit('errorMsg','Jogador não encontrado nesta sala.');
    socket.join(room.code);
    sid2pid.set(socket.id, playerId);
    sid2room.set(socket.id, room.code);
    const player = room.players.get(playerId);
    player.offline = false; player.removeAt = null;
    socket.emit('joined',{room:roomToLobbyDTO(room), you:player});
    io.to(room.code).emit('lobbyUpdate', roomToLobbyDTO(room));
    if (room.phase==='question' || room.phase==='reveal'){
      emitCurrentQuestionTo(socket, room);
    } else if (room.phase==='ended'){
      socket.emit('gameOver', { leaderboard: leaderboard(room) });
    }
  });

  socket.on('createRoom', ({gameType, nick})=>{
    try{
      if (!['processo','bioseg','gastro'].includes(gameType)) return socket.emit('errorMsg','Tipo de jogo inválido.');
      const room = makeRoom(gameType, socket.id);
      socket.join(room.code);
      socket.emit('roomCreated', { room: roomToLobbyDTO(room) });
      io.to(room.code).emit('lobbyUpdate', roomToLobbyDTO(room));
    }catch(e){ socket.emit('errorMsg','Falha ao criar sala.'); }
  });

  socket.on('joinRoom', ({roomCode, nick, avatar, playerId})=>{
    roomCode = (roomCode||'').toUpperCase(); const room = getRoom(roomCode);
    if (!room) return socket.emit('errorMsg','Sala não encontrada.');
    if (room.phase!=='lobby' && room.phase!=='question' && room.phase!=='reveal') return socket.emit('errorMsg','A partida já começou.');
    if (!playerId) playerId = 'p_'+Math.random().toString(36).slice(2);
    if (!room.players.has(playerId) && room.players.size>=40) return socket.emit('errorMsg','Sala cheia (máx. 40).');

    socket.join(room.code);
    sid2pid.set(socket.id, playerId);
    sid2room.set(socket.id, room.code);

    let player = room.players.get(playerId);
    if (!player){
      player = { id: playerId, nick:(nick||'Jogador').slice(0,18), avatar:avatar||'stethoscope.svg', score:0, lastSubmit:null, offline:false, removeAt:null };
      room.players.set(playerId, player);
    } else {
      if (nick) player.nick = (nick||'Jogador').slice(0,18);
      if (avatar) player.avatar = avatar||'stethoscope.svg';
      player.offline = false; player.removeAt = null;
    }

    socket.emit('joined',{room:roomToLobbyDTO(room), you:player});
    io.to(room.code).emit('lobbyUpdate', roomToLobbyDTO(room));
    if (room.phase==='question' || room.phase==='reveal'){
      emitCurrentQuestionTo(socket, room);
    }
  });

  socket.on('startGame', ({roomCode})=>{
    const room = getRoom(roomCode); if (!room) return;
    if (socket.id!==room.hostId) return;
    if (!room.questions.length) return io.to(room.code).emit('errorMsg','Sem perguntas.');
    room.phase='question'; room.currentIdx=0; startQuestion(room);
  });

  socket.on('revealAnswer', ({roomCode})=>{ const room=getRoom(roomCode); if (!room || socket.id!==room.hostId) return; revealCurrent(room); });
  socket.on('nextQuestion', ({roomCode})=>{ const room=getRoom(roomCode); if (!room || socket.id!==room.hostId) return; nextQuestion(room); });

  socket.on('submitAnswer', ({roomCode, payload})=>{
    const room = getRoom(roomCode); if (!room) return;
    const pid = sid2pid.get(socket.id); if (!pid) return; const player = room.players.get(pid); if (!player) return;
    if (room.phase!=='question') return;
    if (player.lastSubmit && player.lastSubmit.qIdx===room.currentIdx) return;

    const q = room.questions[room.currentIdx];
    const elapsed = now()-room.questionStart;
    const speedWindow = Math.min(room.timeLimitMs, 180000); // bônus até 3 min
    const speedFactor = Math.max(0, 1 - (elapsed/speedWindow));
    let correct=false;
    if (q.type==='processo_q1'){
      const sel = Array.isArray(payload?.tokens) ? payload.tokens.map(String) : (payload?.text||'').split(/\s+/);
      const req = expectedTokensFromAnswer(q);
      const setSel = new Set(sel.map(s=>stemToken(normalize(s))));
      const setReq = new Set(req.map(s=>stemToken(normalize(s))));
      if (setSel.size === setReq.size){
        let ok=true; setReq.forEach(k=>{ if (!setSel.has(k)) ok=false; });
        correct = ok;
      } else { correct = false; }
    }
    else if (q.type==='processo_qMulti'){
      const ans = (room.view && Array.isArray(room.view.correctDisplay)) ? room.view.correctDisplay : q.correct;
      const sel = Array.isArray(payload?.selected)?payload.selected.slice().sort().join(','):'';
      const gab = ans.slice().sort().join(',');
      correct = sel===gab;
    }
    else if (q.type==='bio_abcd'){ correct = Number(payload?.choice)===Number(q.correct); }
    const base = correct?1000:0; const bonus = correct?Math.floor(700*speedFactor):0; const points=base+bonus;
    if (correct) player.score+=points; player.lastSubmit={qIdx:room.currentIdx,at:now(),correct,points};
    socket.emit('answerAck', { correct, points, yourScore: player.score });
    io.to(room.code).emit('leaderboard', leaderboard(room));
  });

  socket.on('disconnect', ()=>{
    const pid = sid2pid.get(socket.id);
    const code = sid2room.get(socket.id);
    sid2pid.delete(socket.id); sid2room.delete(socket.id);
    if (!pid || !code) return;
    const room = getRoom(code);
    if (!room) return;
    const player = room.players.get(pid);
    if (player){
      player.offline = true;
      player.removeAt = now() + 120000; // 2 min para reconectar
      setTimeout(()=>{
        const r = getRoom(code);
        if (!r) return;
        const p = r.players.get(pid);
        if (p && p.offline && p.removeAt && p.removeAt <= now()){
          r.players.delete(pid);
          io.to(r.code).emit('lobbyUpdate', roomToLobbyDTO(r));
        }
      }, 125000);
    }
    io.to(room.code).emit('lobbyUpdate', roomToLobbyDTO(room));
  });
});

// ===== Game flow =====
function startQuestion(room){
  const q = room.questions[room.currentIdx];
  room.phase='question'; room.questionStart=now();
  const view = { type:q.type }; let dto = null;
  if (q.type==='processo_q1'){
    const order = shuffleIdx(q.tokens.length);
    const tokensShuffled = order.map(i=>q.tokens[i]);
    view.tokensOrder = order;
    dto = { type:q.type, case:q.case, tokens:tokensShuffled, prompt:q.prompt };
  } else if (q.type==='processo_qMulti'){
    const order = shuffleIdx(q.options.length);
    const optionsShuffled = order.map(i=>q.options[i]);
    // mapeia índices originais -> posição atual (embaralhada)
    const correctDisplay = q.correct.map(oi => order.indexOf(oi)).filter(i=>i>=0);
    view.optionsOrder = order; view.correctDisplay = correctDisplay;
    dto = { type:q.type, case:q.case, options:optionsShuffled, prompt:q.prompt, selectCount:q.selectCount||3 };
  } else if (q.type==='bio_abcd'){
    dto = { type:q.type, question:q.question, choices:q.choices };
  }
  room.view = view;
  io.to(room.code).emit('newQuestion', { idx: room.currentIdx+1, total: room.questions.length, timeLimitMs: room.timeLimitMs, q: dto });
}
function revealCurrent(room){
  const q = room.questions[room.currentIdx]; if (!q) return;
  room.phase='reveal';
  let payload = null;
  if (q.type==='processo_qMulti'){
    payload = { correct: (room.view && Array.isArray(room.view.correctDisplay)) ? room.view.correctDisplay : q.correct };
  } else if (q.type==='processo_q1'){
    payload = { answerText: q.answerText };
  } else if (q.type==='bio_abcd'){
    payload = { correct: q.correct };
  } else {
    payload = { };
  }
  io.to(room.code).emit('reveal', { correct: payload });
  io.to(room.code).emit('leaderboard', leaderboard(room));
}
function nextQuestion(room){
  if (room.currentIdx+1 >= room.questions.length){ room.phase='ended'; io.to(room.code).emit('gameOver', { leaderboard: leaderboard(room) }); return; }
  room.currentIdx+=1; startQuestion(room);
}

server.listen(PORT, ()=> console.log('Servidor rodando em http://localhost:'+PORT));
