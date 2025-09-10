let roomCode = null;
let you = null;
let stopTimer = null;
let currentQ = null;

const joinForm = $('#joinForm');
const joinCode = $('#joinCode');
const joinNick = $('#joinNick');
const joinAvatar = $('#joinAvatar');
const btnJoin = $('#btnJoin');

const wait = $('#wait');
const qCard = $('#qCard');
const finalCard = $('#final');

const pQIdx = $('#pQIdx');
const pQTot = $('#pQTot');
const pTimer = $('#pTimer');
const pQArea = $('#pQArea');
const sendAnswer = $('#sendAnswer');

const AVATARS = [
  "stethoscope.svg","syringe.svg","heart.svg","mask.svg","gloves.svg",
  "thermometer.svg","clipboard.svg","bed.svg","ivbag.svg","tray.svg",
  "nurse_m.svg","nurse_f.svg","microscope.svg","dna.svg","ambulance.svg",
  "xray.svg","tablet.svg","bio_shield.svg","n95.svg","vaccine.svg"
];
function buildAvatarGrid(){
  const grid = document.getElementById('avatarGrid'); if (!grid) return;
  const hidden = document.getElementById('joinAvatar');
  grid.innerHTML = '';
  AVATARS.forEach((file, idx)=>{
    const tile = document.createElement('div'); tile.className='avatar-tile' + (idx===0?' selected':'');
    const img = document.createElement('img'); img.className='avatar-img'; img.src='/assets/avatars/' + file; img.alt=file;
    tile.appendChild(img);
    tile.onclick = () => {
      Array.from(grid.children).forEach(el=>el.classList.remove('selected'));
      tile.classList.add('selected');
      hidden.value = file;
    };
    grid.appendChild(tile);
  });
  hidden.value = AVATARS[0];
}
document.addEventListener('DOMContentLoaded', buildAvatarGrid);

btnJoin.addEventListener('click', () => {
  roomCode = fmtCode(joinCode.value);
  const nick = joinNick.value.trim() || 'Jogador';
  const avatar = joinAvatar.value || 'stethoscope.svg';
  if (!roomCode || roomCode.length !== 5) return alert('Código inválido');
  socket.emit('joinRoom', { roomCode, nick, avatar, playerId: getPlayerId() });
  saveLastSession(roomCode, nick, avatar);
});

socket.on('joined', ({ room, you: me }) => {
  saveLastSession(room.code, joinNick.value.trim()||'Jogador', joinAvatar.value||'stethoscope.svg');
  you = me;
  show(joinForm, false);
  show(wait, true);
});

socket.on('newQuestion', ({ idx, total, timeLimitMs, q }) => {
  currentQ = q;
  sendAnswer.disabled = true;
  pQIdx.textContent = idx; pQTot.textContent = total;
  pQArea.innerHTML = '';
  show(wait, false); show(qCard, true);

  if (stopTimer) stopTimer();
  stopTimer = countdown(timeLimitMs, s => { pTimer.textContent = s + 's'; }, () => {});

  if (q.type === 'processo_q1') {
    const prompt = document.createElement('div'); prompt.className = 'prompt'; prompt.textContent = q.prompt;
    const build = document.createElement('div'); build.className = 'token-build'; build.id = 'build';
    const bank = document.createElement('div'); bank.className = 'token-bank';
    q.tokens.forEach(tok => {
      const t = document.createElement('span'); t.className = 'token'; t.textContent = tok;
      t.onclick = () => { if (t.classList.contains('used')) return; t.classList.add('used');
        const b = document.createElement('span'); b.className = 'token'; b.textContent = tok;
        b.onclick = () => { b.remove(); t.classList.remove('used'); updateBtn(); };
        build.appendChild(b); updateBtn(); };
      bank.appendChild(t);
    });
    pQArea.appendChild(prompt);
    const tip = document.createElement('div'); tip.className='small';
    tip.textContent='Toque nos blocos para montar o diagnóstico. Toque no bloco montado para removê-lo.';
    pQArea.appendChild(tip); pQArea.appendChild(build); pQArea.appendChild(bank);
    function updateBtn(){ const text = Array.from(build.querySelectorAll('.token')).map(x=>x.textContent).join(' '); sendAnswer.disabled = text.trim().length < 5; }
    sendAnswer.onclick = () => { const arr = Array.from(build.querySelectorAll('.token')).map(x=>x.textContent); const text = arr.join(' '); socket.emit('submitAnswer', { roomCode, payload: { text, tokens: arr } }); sendAnswer.disabled = true; };
  }

  if (q.type === 'processo_qMulti') {
    const prompt = document.createElement('div'); prompt.className='prompt';
    prompt.innerHTML = `${q.prompt} <em>(selecione ${q.selectCount})</em>`;
    const grid = document.createElement('div'); grid.className='options two-col';
    const picked = new Set();
    q.options.forEach((opt,i)=>{
      const el = document.createElement('div'); el.className='option'; el.textContent=opt; el.dataset.idx=i;
      el.onclick = () => {
        if (picked.has(i)) { picked.delete(i); el.classList.remove('selected'); }
        else if (picked.size < (q.selectCount||3)) { picked.add(i); el.classList.add('selected'); }
        sendAnswer.disabled = picked.size !== (q.selectCount||3);
      };
      grid.appendChild(el);
    });
    pQArea.appendChild(prompt); pQArea.appendChild(grid);
    sendAnswer.onclick = () => { const sel = Array.from(picked.values()); socket.emit('submitAnswer', { roomCode, payload: { selected: sel } }); sendAnswer.disabled = true; };
  }

  if (q.type === 'bio_abcd') {
    const prompt = document.createElement('div'); prompt.className='prompt'; prompt.textContent = q.question;
    const grid = document.createElement('div'); grid.className='options two-col';
    let choice = null;
    q.choices.forEach((opt,i)=>{
      const L = String.fromCharCode(65+i);
      const el = document.createElement('div'); el.className='option choice-'+L;
      el.innerHTML = `<strong>${L})</strong> ${opt}`; el.dataset.idx=i;
      el.onclick = () => { $all('.option').forEach(x=>x.classList.remove('selected')); el.classList.add('selected'); choice=i; sendAnswer.disabled=false; };
      grid.appendChild(el);
    });
    pQArea.appendChild(prompt); pQArea.appendChild(grid);
    sendAnswer.onclick = () => { socket.emit('submitAnswer', { roomCode, payload: { choice } }); sendAnswer.disabled = true; };
  }
});

socket.on('reveal', ({ correct }) => {
  if (currentQ?.type === 'bio_abcd' && typeof correct.correct === 'number') {
    const el = pQArea.querySelector(`.option[data-idx="${correct.correct}"]`); if (el) el.classList.add('correct');
  }
  if (currentQ?.type === 'processo_qMulti' && Array.isArray(correct.correct)) {
    correct.correct.forEach(i=>{ const el = pQArea.querySelector(`.option[data-idx="${i}"]`); if (el) el.classList.add('correct'); });
  }
  if (currentQ?.type === 'processo_q1' && correct.answerText) {
    const div = document.createElement('div'); div.className='answer-banner'; div.innerHTML = `<strong>Resposta correta:</strong> ${correct.answerText}`; pQArea.appendChild(div);
  }
});

socket.on('gameOver', ({ leaderboard }) => {
  const pos = leaderboard.findIndex(x => x.id === you?.id) + 1;
  const total = leaderboard.length;
  $('#finalPos').textContent = pos>0 ? `Você ficou em ${pos}º de ${total}!` : 'Jogo encerrado.';
  show(qCard, false); show(wait, false); show(finalCard, true);
});

socket.on('errorMsg', (msg)=> alert(msg));