const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

function code(){ const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let o=''; for(let i=0;i<5;i++) o+=c[Math.floor(Math.random()*c.length)]; return o; }
function now(){ return Date.now(); }
function shuffleIdx(n){ const a=[...Array(n).keys()]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

const rooms = new Map();

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
  const room = { code:roomCode, hostId, gameType, players:new Map(), createdAt:now(), currentIdx:0, phase:'lobby', questionStart:null, timeLimitMs:180000, questions:loadQuestions(gameType), view:{} };
  rooms.set(roomCode, room); return room;
}
function getRoom(c){ return rooms.get((c||'').toUpperCase()); }
function roomToLobbyDTO(room){ return { code:room.code, gameType:room.gameType, phase:room.phase, playerCount:room.players.size, players:Array.from(room.players.values()).map(p=>({id:p.id,nick:p.nick,avatar:p.avatar,score:p.score})) }; }
function leaderboard(room){ return Array.from(room.players.values()).sort((a,b)=>b.score-a.score).map((p,idx)=>({pos:idx+1,id:p.id,nick:p.nick,avatar:p.avatar,score:p.score})); }
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

io.on('connection', (socket)=>{
  socket.on('createRoom', ({gameType, nick})=>{
    try{
      if (!['processo','bioseg','gastro'].includes(gameType)) return socket.emit('errorMsg','Tipo de jogo inválido.');
      const room = makeRoom(gameType, socket.id);
      socket.join(room.code);
      io.to(socket.id).emit('roomCreated', { room: roomToLobbyDTO(room) });
      io.to(room.code).emit('lobbyUpdate', roomToLobbyDTO(room));
    }catch(e){ socket.emit('errorMsg','Falha ao criar sala.'); }
  });

  socket.on('joinRoom', ({roomCode, nick, avatar})=>{
    roomCode = (roomCode||'').toUpperCase(); const room = getRoom(roomCode);
    if (!room) return socket.emit('errorMsg','Sala não encontrada.');
    if (room.phase!=='lobby') return socket.emit('errorMsg','A partida já começou.');
    if (room.players.size>=40) return socket.emit('errorMsg','Sala cheia (máx. 40).');
    socket.join(room.code);
    const player = { id:socket.id, nick:(nick||'Jogador').slice(0,18), avatar:avatar||'stethoscope.svg', score:0, lastSubmit:null };
    room.players.set(socket.id, player);
    socket.emit('joined',{room:roomToLobbyDTO(room), you:player});
    io.to(room.code).emit('lobbyUpdate', roomToLobbyDTO(room));
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
    const player = room.players.get(socket.id); if (!player) return;
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
    for (const room of rooms.values()){
      const isPlayer = room.players.has(socket.id);
      const isHost = room.hostId===socket.id;
      if (!isPlayer && !isHost) continue;
      if (isPlayer) room.players.delete(socket.id);
      if (isHost){
        const first = room.players.values().next().value;
        if (first){ room.hostId = first.id; io.to(first.id).emit('youAreHost', { room: roomToLobbyDTO(room) }); }
        else { rooms.delete(room.code); continue; }
      }
      io.to(room.code).emit('lobbyUpdate', roomToLobbyDTO(room));
    }
  });
});

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