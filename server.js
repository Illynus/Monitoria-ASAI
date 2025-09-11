const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

/* =========================================================================
 * 1) Configuração base (Express, HTTP, Socket.IO)
 * ========================================================================= */

/** CORS por ambiente:
 *  - ALLOWED_ORIGINS="https://meu-site.com,https://outrasite.com"
 *  - Se não definir, usa '*' (dev)
 */
const parseAllowedOrigins = () => {
  const env = process.env.ALLOWED_ORIGINS;
  if (!env || env.trim() === '') return '*';
  const arr = env.split(',').map(s => s.trim()).filter(Boolean);
  return arr.length ? arr : '*';
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: parseAllowedOrigins() } });

/** Porta de execução */
const PORT = process.env.PORT || 3000;

/** Fechar sala quando host sai (padrão: true) */
const CLOSE_ON_HOST_EXIT = process.env.CLOSE_ON_HOST_EXIT
  ? String(process.env.CLOSE_ON_HOST_EXIT).toLowerCase() !== 'false'
  : true;

/** Janela de graça p/ reconectar (ms) — padrão: 3 minutos */
const PLAYER_GRACE_MS = process.env.PLAYER_GRACE_MS
  ? parseInt(process.env.PLAYER_GRACE_MS, 10)
  : 180000;

/** Servir front estático */
app.use(express.static(path.join(__dirname, 'public')));

/* =========================================================================
 * 2) Utilitários puros
 * ========================================================================= */

function code() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let o = '';
  for (let i = 0; i < 5; i++) o += c[Math.floor(Math.random() * c.length)];
  return o;
}
function now() { return Date.now(); }
function shuffleIdx(n) {
  const a = [...Array(n).keys()];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function normalize(s) {
  return (s || '').toString().normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/\s+/g,' ')
    .trim()
    .toLowerCase();
}
function stemToken(tok) { return (tok || '').toLowerCase().replace(/(ado|ada|ido|ida|a|o)$/,''); }

/* =========================================================================
 * 3) Tipos/JSDoc
 * ========================================================================= */

/**
 * @typedef {Object} Player
 * @property {string} id            - socket.id atual
 * @property {string} sessionId     - id lógico persistente (localStorage no cliente)
 * @property {string} nick
 * @property {string} avatar
 * @property {number} score
 * @property {{qIdx:number,at:number,correct:boolean,points:number}|null} lastSubmit
 * @property {number|null} offlineAt
 * @property {NodeJS.Timeout|null} removalTimer
 */

/**
 * @typedef {Object} Room
 * @property {string} code
 * @property {string} hostId             - socket.id do host atual
 * @property {'processo'|'bioseg'|'gastro'} gameType
 * @property {Map<string, Player>} players       - chave = socket.id
 * @property {Map<string, string>} sessions      - sessionId -> socket.id
 * @property {Map<string, string>} sockets       - socket.id -> sessionId
 * @property {number} createdAt
 * @property {number} currentIdx
 * @property {'lobby'|'question'|'reveal'|'ended'} phase
 * @property {number|null} questionStart
 * @property {number} timeLimitMs
 * @property {any[]} questions
 * @property {Object} view
 */

/* =========================================================================
 * 4) Estado e dados
 * ========================================================================= */

const rooms = new Map();

const perguntasMonitoria1 = JSON.parse(
  fs.readFileSync(path.join(__dirname,'public','data','perguntas_monitoria_1.json'),'utf8')
);
const perguntasMonitoria2 = JSON.parse(
  fs.readFileSync(path.join(__dirname,'public','data','perguntas_monitoria_2.json'),'utf8')
);
const perguntasMonitoria3 = JSON.parse(
  fs.readFileSync(path.join(__dirname,'public','data','perguntas_monitoria_3.json'),'utf8')
);

function loadQuestions(gameType){
  if (gameType==='monitoria1')   return JSON.parse(JSON.stringify(perguntasMonitoria1));
  if (gameType==='monitoria2') return JSON.parse(JSON.stringify(perguntasMonitoria2));
  if (gameType==='monitoria3')     return JSON.parse(JSON.stringify(perguntasMonitoria3));
  return [];
}

/* =========================================================================
 * 5) Helpers de sala/DTO/ranking
 * ========================================================================= */

function makeRoom(gameType, hostId){
  let roomCode = code(); while (rooms.has(roomCode)) roomCode = code();
  /** @type {Room} */
  const room = {
    code: roomCode,
    hostId,
    gameType,
    players: new Map(),
    sessions: new Map(),
    sockets: new Map(),
    createdAt: now(),
    currentIdx: 0,
    phase: 'lobby',
    questionStart: null,
    timeLimitMs: 180000,
    questions: loadQuestions(gameType),
    view: {}
  };
  rooms.set(roomCode, room);
  return room;
}
function getRoom(c){ return rooms.get((c||'').toUpperCase()); }
function roomToLobbyDTO(room){
  return {
    code: room.code,
    gameType: room.gameType,
    phase: room.phase,
    playerCount: room.players.size,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, nick: p.nick, avatar: p.avatar, score: p.score,
      offline: Boolean(p.offlineAt)
    }))
  };
}
function leaderboard(room){
  return Array.from(room.players.values())
    .sort((a,b)=>b.score-a.score)
    .map((p,idx)=>({ pos:idx+1, id:p.id, nick:p.nick, avatar:p.avatar, score:p.score }));
}
function expectedTokensFromAnswer(q){
  const ans = normalize(q.answerText||'');
  const required = [];
  (q.tokens||[]).forEach(t=>{ const nt = normalize(t); if (ans.includes(nt)) required.push(t); });
  const seen = new Set(); const out=[];
  required.forEach(t=>{ const k=stemToken(normalize(t)); if (!seen.has(k)){ seen.add(k); out.push(t);} });
  return out;
}

/** Promove fechamento da sala e notifica todos */
function closeRoom(room, reason='Host saiu. Sala encerrada.'){
  io.to(room.code).emit('roomClosed', { reason });
  rooms.delete(room.code);
}

/** Marca jogador como offline e agenda remoção após PLAYER_GRACE_MS */
function markPlayerOffline(room, player){
  if (player.offlineAt) return; // já marcado
  player.offlineAt = now();
  // agenda remoção
  player.removalTimer = setTimeout(() => {
    // remover de fato
    const sessionId = player.sessionId;
    // só remova se ainda estiver offline
    if (player.offlineAt) {
      room.players.delete(player.id);                 // remove pelo socket.id antigo
      const oldSock = room.sessions.get(sessionId);   // deve ser o mesmo player.id
      if (oldSock) room.sessions.delete(sessionId);
      room.sockets.delete(player.id);

      io.to(room.code).emit('lobbyUpdate', roomToLobbyDTO(room));
    }
  }, PLAYER_GRACE_MS);
}

/** Ao reconectar, transfere o player para o novo socket.id */
function rebindPlayerSocket(room, sessionId, newSocketId){
  const oldSocketId = room.sessions.get(sessionId);
  if (!oldSocketId) return null;
  const player = room.players.get(oldSocketId);
  if (!player) return null;

  // limpar timers/offline
  if (player.removalTimer) clearTimeout(player.removalTimer);
  player.removalTimer = null;
  player.offlineAt = null;

  // atualizar chaves/maps
  room.players.delete(oldSocketId);
  room.sockets.delete(oldSocketId);

  player.id = newSocketId;
  room.players.set(newSocketId, player);
  room.sessions.set(sessionId, newSocketId);
  room.sockets.set(newSocketId, sessionId);

  return player;
}

/* =========================================================================
 * 6) Fluxo do jogo
 * ========================================================================= */

function startQuestion(room){
  const q = room.questions[room.currentIdx]; if (!q) return;
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
  io.to(room.code).emit('newQuestion', {
    idx: room.currentIdx+1, total: room.questions.length,
    timeLimitMs: room.timeLimitMs, q: dto
  });
}
function revealCurrent(room){
  const q = room.questions[room.currentIdx]; if (!q) return;
  room.phase='reveal';
  let payload = {};
  if (q.type==='processo_qMulti'){
    payload = { correct: (room.view && Array.isArray(room.view.correctDisplay)) ? room.view.correctDisplay : q.correct };
  } else if (q.type==='processo_q1'){
    payload = { answerText: q.answerText };
  } else if (q.type==='bio_abcd'){
    payload = { correct: q.correct };
  }
  io.to(room.code).emit('reveal', { correct: payload });
  io.to(room.code).emit('leaderboard', leaderboard(room));
}
function nextQuestion(room){
  if (room.currentIdx+1 >= room.questions.length){
    room.phase='ended';
    io.to(room.code).emit('gameOver', { leaderboard: leaderboard(room) });
    return;
  }
  room.currentIdx+=1; startQuestion(room);
}

/* =========================================================================
 * 7) Eventos Socket.IO
 * ========================================================================= */

io.on('connection', (socket)=>{

  /** Ping/heartbeat opcional do cliente para marcar presença */
  socket.on('playerHeartbeat', ({roomCode})=>{
    const room = getRoom(roomCode); if (!room) return;
    const sessionId = room.sockets.get(socket.id); if (!sessionId) return;
    const player = room.players.get(socket.id); if (!player) return;
    player.offlineAt = null;
  });

  /* ---------------------- createRoom ---------------------- */
  socket.on('createRoom', ({gameType, nick})=>{
    try{
      if (!['monitoria1','monitoria2','monitoria3'].includes(gameType))
        return socket.emit('errorMsg','Tipo de jogo inválido.');
      const room = makeRoom(gameType, socket.id);
      socket.join(room.code);
      io.to(socket.id).emit('roomCreated', { room: roomToLobbyDTO(room) });
      io.to(room.code).emit('lobbyUpdate', roomToLobbyDTO(room));
    }catch(e){ socket.emit('errorMsg','Falha ao criar sala.'); }
  });

  /* ---------------------- joinRoom (com reconexão) -------- */
  // Espera: { roomCode, nick, avatar, sessionId }
  socket.on('joinRoom', ({roomCode, nick, avatar, sessionId})=>{
    roomCode = (roomCode||'').toUpperCase();
    const room = getRoom(roomCode);
    if (!room) return socket.emit('errorMsg','Sala não encontrada.');

    const hasSession = typeof sessionId === 'string' && sessionId.trim() !== '';

    if (hasSession && room.sessions.has(sessionId)) {
      // ===== REENTRADA =====
      socket.join(room.code);
      const player = rebindPlayerSocket(room, sessionId, socket.id);
      if (!player) return socket.emit('errorMsg','Falha ao retomar sua sessão.');

      // pode reentrar mesmo fora do lobby
      socket.emit('joined', { room: roomToLobbyDTO(room), you: player });
      io.to(room.code).emit('lobbyUpdate', roomToLobbyDTO(room));
      return;
    }

    // ===== ENTRADA NOVA =====
    if (room.phase!=='lobby')
      return socket.emit('errorMsg','A partida já começou.');

    if (room.players.size>=40)
      return socket.emit('errorMsg','Sala cheia (máx. 40).');

    // se não mandou sessionId, gera um temporário (não reconecta)
    const sess = hasSession ? sessionId : `sess_${socket.id}`;

    socket.join(room.code);
    /** @type {Player} */
    const player = {
      id: socket.id,
      sessionId: sess,
      nick: (nick||'Jogador').slice(0,18),
      avatar: avatar || 'stethoscope.svg',
      score: 0,
      lastSubmit: null,
      offlineAt: null,
      removalTimer: null
    };

    room.players.set(socket.id, player);
    room.sessions.set(sess, socket.id);
    room.sockets.set(socket.id, sess);

    socket.emit('joined',{room:roomToLobbyDTO(room), you:player});
    io.to(room.code).emit('lobbyUpdate', roomToLobbyDTO(room));
  });

  /* ---------------------- resume (atalho p/ reentrada) ---- */
  // Espera: { roomCode, sessionId }
  socket.on('resume', ({roomCode, sessionId})=>{
    roomCode = (roomCode||'').toUpperCase();
    const room = getRoom(roomCode);
    if (!room) return socket.emit('errorMsg','Sala não encontrada.');
    if (!sessionId || !room.sessions.has(sessionId))
      return socket.emit('errorMsg','Sessão não localizada para retomar.');

    socket.join(room.code);
    const player = rebindPlayerSocket(room, sessionId, socket.id);
    if (!player) return socket.emit('errorMsg','Falha ao retomar sua sessão.');

    socket.emit('joined', { room: roomToLobbyDTO(room), you: player });
    io.to(room.code).emit('lobbyUpdate', roomToLobbyDTO(room));
  });

  /* ---------------------- startGame ----------------------- */
  socket.on('startGame', ({roomCode})=>{
    const room = getRoom(roomCode); if (!room) return;
    if (socket.id!==room.hostId) return;
    if (!room.questions.length) return io.to(room.code).emit('errorMsg','Sem perguntas.');
    room.phase='question'; room.currentIdx=0; startQuestion(room);
  });

  /* ---------------------- revealAnswer -------------------- */
  socket.on('revealAnswer', ({roomCode})=>{
    const room=getRoom(roomCode); if (!room || socket.id!==room.hostId) return;
    revealCurrent(room);
  });

  /* ---------------------- nextQuestion -------------------- */
  socket.on('nextQuestion', ({roomCode})=>{
    const room=getRoom(roomCode); if (!room || socket.id!==room.hostId) return;
    nextQuestion(room);
  });

  /* ---------------------- submitAnswer -------------------- */
  socket.on('submitAnswer', ({roomCode, payload})=>{
    const room = getRoom(roomCode); if (!room) return;

    const sessionId = room.sockets.get(socket.id);
    const player = room.players.get(socket.id);
    if (!player || !sessionId) return;

    if (room.phase!=='question') return;
    if (player.lastSubmit && player.lastSubmit.qIdx===room.currentIdx) return;

    const q = room.questions[room.currentIdx];
    if (!q) return;

    const elapsed = now()-room.questionStart;
    const speedWindow = Math.min(room.timeLimitMs, 180000);
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

  /* ---------------------- disconnect ---------------------- */
  socket.on('disconnect', ()=>{
    // Percorre todas as salas para ver onde este socket está
    for (const room of rooms.values()){
      const sessionId = room.sockets.get(socket.id);
      const isHost = room.hostId===socket.id;
      const player = room.players.get(socket.id);

      // se não achou nada relevante, segue
      if (!isHost && !player) continue;

      if (isHost) {
        // Política: encerrar sala ao sair o host
        if (CLOSE_ON_HOST_EXIT) {
          closeRoom(room, 'O anfitrião encerrou a sala.');
          continue;
        } else {
          // (opcional) promoção do primeiro jogador a host (não usado pois CLOSE_ON_HOST_EXIT=true)
          const first = Array.from(room.players.values()).find(p => p.id !== socket.id && !p.offlineAt);
          if (first){
            room.hostId = first.id;
            io.to(first.id).emit('youAreHost', { room: roomToLobbyDTO(room) });
          } else {
            rooms.delete(room.code);
            continue;
          }
          io.to(room.code).emit('lobbyUpdate', roomToLobbyDTO(room));
        }
      }

      // Jogador comum: não remove imediatamente — marca offline e agenda remoção
      if (player) {
        markPlayerOffline(room, player);
        io.to(room.code).emit('lobbyUpdate', roomToLobbyDTO(room));
        // mantém mapeamentos (players/sessions/sockets) até expirar o grace
      }
    }
  });
});

/* =========================================================================
 * 8) Inicialização do servidor HTTP
 * ========================================================================= */

server.listen(PORT, ()=> console.log('Servidor rodando em http://localhost:'+PORT));
