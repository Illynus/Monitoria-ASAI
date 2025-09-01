let roomCode = null;
let stopTimer = null;
let pendingRankOverlay = false;

const hostNick = $('#hostNick');
const gameTypeSel = $('#gameType');
const btnCreate = $('#btnCreate');
const roomSection = $('#roomSection');
const roomCodeEl = $('#roomCode');
const pcountEl = $('#pcount');
const plistEl = $('#plist');
const btnStart = $('#btnStart');
const copyLink = $('#copyLink');

const stage = $('#stage');
const qIdx = $('#qIdx');
const qTot = $('#qTot');
const timer = $('#timer');
const qArea = $('#qArea');

const btnReveal = $('#btnReveal');
const btnNext = $('#btnNext');
const rankCard = $('#rankCard');
const rankList = $('#rankList');

const rankOverlay = $('#rankOverlay');
const rankListOverlay = $('#rankListOverlay');
const btnContinue = $('#btnContinue');

const finalOverlay = document.getElementById('finalOverlay');
const finalPodium = document.getElementById('finalPodium');
const finalList = document.getElementById('finalList');
const btnCloseFinal = document.getElementById('btnCloseFinal');

btnCreate.addEventListener('click', () => {
  const nick = hostNick.value.trim() || 'Host';
  const gameType = gameTypeSel.value;
  socket.emit('createRoom', { gameType, nick });
});

socket.on('roomCreated', ({ room }) => {
  roomCode = room.code;
  roomCodeEl.textContent = room.code;
  show(roomSection, true);
  const joinUrl = `${location.origin}/player.html?room=${room.code}`;
  QRCode.toCanvas(document.getElementById('qrCanvas'), joinUrl, { width: 220 });
  copyLink.onclick = () => {
    navigator.clipboard.writeText(joinUrl);
    copyLink.textContent = 'Link copiado!';
    setTimeout(()=> copyLink.textContent = 'Copiar link', 1500);
  };
});

socket.on('lobbyUpdate', (dto) => {
  if (!roomCode || dto.code !== roomCode) return;
  pcountEl.textContent = String(dto.playerCount);
  plistEl.innerHTML = '';
  dto.players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = `${p.nick} — ${p.score} pts`;
    plistEl.appendChild(li);
  });
  btnStart.disabled = dto.playerCount === 0;
});

btnStart.addEventListener('click', () => {
  socket.emit('startGame', { roomCode });
  show(stage, true);
  stage.classList.add('fullscreen');
  show(rankCard, false);
  btnNext.style.display = 'none';
});

socket.on('newQuestion', ({ idx, total, timeLimitMs, q }) => {
  qIdx.textContent = idx; qTot.textContent = total;
  qArea.innerHTML = ''; btnNext.disabled = true;
  if (stopTimer) stopTimer();
  stopTimer = countdown(timeLimitMs, s => { timer.textContent = s + 's'; }, () => {});

  if (q.type === 'processo_q1') {
    const h = `
      <div class="case"><strong>Caso clínico:</strong> ${q.case}</div>
      <div class="prompt">${q.prompt}</div>
      <div class="token-bank">${q.tokens.map(t => `<span class="token">${t}</span>`).join('')}</div>`;
    qArea.insertAdjacentHTML('beforeend', h);
  } else if (q.type === 'processo_qMulti') {
    const h = `
      <div class="case"><strong>Caso clínico:</strong> ${q.case}</div>
      <div class="prompt">${q.prompt} <em>(selecione ${q.selectCount})</em></div>
      <div class="options two-col">${q.options.map((opt,i)=>`<div class="option" data-idx="${i}">${opt}</div>`).join('')}</div>`;
    qArea.insertAdjacentHTML('beforeend', h);
  } else if (q.type === 'bio_abcd') {
    const h = `
      <div class="prompt">${q.question}</div>
      <div class="options two-col">${q.choices.map((c,i)=>{const L=String.fromCharCode(65+i);return `<div class="option choice-${L}" data-idx="${i}"><strong>${L})</strong> ${c}</div>`}).join('')}</div>`;
    qArea.insertAdjacentHTML('beforeend', h);
  }
});

btnReveal.addEventListener('click', () => {
  pendingRankOverlay = true;
  socket.emit('revealAnswer', { roomCode });
});

socket.on('reveal', ({ correct }) => {
  if (!correct) return;
  if (correct.answerText) {
    const div = document.createElement('div');
    div.className = 'answer-banner';
    div.innerHTML = `<strong>Resposta correta:</strong> ${correct.answerText}`;
    qArea.appendChild(div);
  }
  if (Array.isArray(correct.correct)) {
    correct.correct.forEach(idx => {
      const el = qArea.querySelector(`.option[data-idx="${idx}"]`);
      if (el) el.classList.add('correct');
    });
  }
  if (typeof correct.correct === 'number') {
    const el = qArea.querySelector(`.option[data-idx="${correct.correct}"]`);
    if (el) el.classList.add('correct');
  }
});

socket.on('leaderboard', (board) => {
  renderRank(rankList, board);
  if (pendingRankOverlay) {
    pendingRankOverlay = false;
    renderRank(rankListOverlay, board);
    rankOverlay.classList.add('show');
  }
});

btnContinue.addEventListener('click', () => {
  rankOverlay.classList.remove('show');
  socket.emit('nextQuestion', { roomCode });
});

function renderFinalPodium(board){
  finalPodium.innerHTML = '';
  const top3 = [board[1], board[0], board[2]]; // columns: 2nd, 1st, 3rd
  const max = Math.max(1, ...board.map(b=>b.score));
  const medals = ['🥈','🥇','🥉'];
  const heights = [0.7, 1.0, 0.5];
  top3.forEach((p, i)=>{
    const col = document.createElement('div'); col.className='podium-col';
    const medal = document.createElement('div'); medal.className='medal'; medal.textContent = medals[i];
    const name = document.createElement('div'); name.className='name'; name.textContent = p ? p.nick : '—';
    const score = document.createElement('div'); score.className='score'; score.textContent = p ? (p.score + ' pts') : '';
    const bar = document.createElement('div'); bar.className='podium-bar'; bar.style.height = Math.max(80, Math.round((p? p.score:0)/max*200*heights[i])) + 'px';
    const fill = document.createElement('div'); fill.className='fill';
    if (i===1) fill.style.background='linear-gradient(180deg,var(--gold),rgba(0,0,0,0))';
    if (i===0) fill.style.background='linear-gradient(180deg,var(--silver),rgba(0,0,0,0))';
    if (i===2) fill.style.background='linear-gradient(180deg,var(--bronze),rgba(0,0,0,0))';
    bar.appendChild(fill);
    col.appendChild(medal); col.appendChild(bar); col.appendChild(name); col.appendChild(score);
    finalPodium.appendChild(col);
  });
  renderRank(finalList, board);
}

if (btnCloseFinal){
  btnCloseFinal.addEventListener('click', ()=> finalOverlay.classList.remove('show'));
}

socket.on('gameOver', ({ leaderboard }) => {
  renderRank(rankListOverlay, leaderboard);
  rankOverlay.classList.add('show');
  renderFinalPodium(leaderboard);
  finalOverlay.classList.add('show');
});

socket.on('errorMsg', (msg) => alert(msg));