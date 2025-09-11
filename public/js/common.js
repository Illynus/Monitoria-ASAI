/* ===================== 1) Socket + sessão ===================== */

// Força websocket e reconexão automática
const socket = io({ transports: ['websocket'], autoConnect: true });

/** sessionId persistente no navegador (para jogadores reconectarem) */
(function ensureSessionId() {
  let sid = localStorage.getItem('sessionId');
  if (!sid) {
    try {
      sid = crypto?.randomUUID ? crypto.randomUUID() :
        ('sess_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
    } catch {
      sid = 'sess_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    localStorage.setItem('sessionId', sid);
  }
  window.sessionId = sid; // acessível globalmente
})();

/** Funções para gerenciar o "roomCode" atual no client */
function setCurrentRoom(code) {
  window.currentRoomCode = code || null;
  if (code) localStorage.setItem('roomCode', code);
  else localStorage.removeItem('roomCode');
}
function clearCurrentRoom() { setCurrentRoom(null); }

/** Papel atual (host | player) – útil para decidir quando fazer resume */
function setRole(role) {
  if (role) localStorage.setItem('role', role);
  else localStorage.removeItem('role');
}
function getRole() { return localStorage.getItem('role') || null; }

/* ===================== 2) Heartbeat (presença) ===================== */

let heartbeatTimer = null;
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (window.currentRoomCode && getRole() === 'player') {
      socket.emit('playerHeartbeat', { roomCode: window.currentRoomCode });
    }
  }, 25000); // 25s
}
function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/* ===================== 3) Helpers de DOM/UI ===================== */

function $(sel)    { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
function show(el, on = true) { if (el) el.classList.toggle('hidden', !on); }
function fmtCode(c){ return (c || '').toUpperCase(); }

/** Contagem regressiva simples (chama onTick e onEnd) */
function countdown(ms, onTick, onEnd) {
  const start = Date.now();
  const t = setInterval(() => {
    const left = Math.max(0, ms - (Date.now() - start));
    const s = Math.ceil(left / 1000);
    onTick && onTick(s);
    if (left <= 0) {
      clearInterval(t);
      onEnd && onEnd();
    }
  }, 250);
  return () => clearInterval(t);
}

/** Renderiza ranking (lista + barras proporcionais) */
function renderRank(listEl, board) {
  if (!listEl) return;
  listEl.innerHTML = '';
  const max = Math.max(1, ...board.map(b => b.score));
  board.forEach((item, idx) => {
    const li = document.createElement('li'); li.className = 'rank-item';
    const medal = document.createElement('div'); medal.className = 'rank-medal';
    if (idx === 0) { medal.textContent = '🥇'; li.style.color = 'var(--gold)'; }
    else if (idx === 1) { medal.textContent = '🥈'; li.style.color = 'var(--silver)'; }
    else if (idx === 2) { medal.textContent = '🥉'; li.style.color = 'var(--bronze)'; }
    else { medal.textContent = `${idx + 1}`; }

    const avatar = document.createElement('img'); avatar.className = 'avatar';
    avatar.src = '/assets/avatars/' + (item.avatar || 'stethoscope.svg'); avatar.alt = 'avatar';

    const name = document.createElement('div'); name.textContent = `${item.nick} — ${item.score} pts`;
    const bar = document.createElement('div'); bar.className = 'rank-bar';
    const fill = document.createElement('div'); fill.className = 'rank-fill';
    fill.style.width = Math.round(item.score / max * 100) + '%';
    bar.appendChild(fill);

    li.appendChild(medal);
    li.appendChild(avatar);
    li.appendChild(name);
    li.appendChild(bar);
    listEl.appendChild(li);
  });
}

/* ===================== 4) Navegação comum (sala encerrada) ===================== */

function navigateHome() {
  // Se a página definiu uma função custom, usa; senão vai para "/"
  if (typeof window.goToHome === 'function') window.goToHome();
  else window.location.href = '/';
}

/* ===================== 5) Handlers globais do socket ===================== */

socket.on('connect', () => {
  // Recupera estado salvo
  window.currentRoomCode = window.currentRoomCode || localStorage.getItem('roomCode') || null;
  const role = getRole();
  const sid  = localStorage.getItem('sessionId');

  // Apenas jogador tenta retomar sessão
  if (role === 'player' && sid && window.currentRoomCode) {
    socket.emit('resume', { roomCode: window.currentRoomCode, sessionId: sid });
  }
  startHeartbeat();
});

socket.on('disconnect', () => {
  stopHeartbeat();
});

/** Host saiu → servidor fechou sala. Limpa estado e volta para a Home. */
socket.on('roomClosed', ({ reason }) => {
  alert(reason || 'Sala encerrada pelo anfitrião.');
  clearCurrentRoom();
  stopHeartbeat();
  navigateHome();
});

/* ===================== 6) Exporta helpers no escopo global ===================== */

window.Common = {
  socket,
  get sessionId() { return window.sessionId; },
  setCurrentRoom, clearCurrentRoom, setRole, getRole,
  startHeartbeat, stopHeartbeat,
  $, $all, show, fmtCode, countdown, renderRank
};

// Backwards-compat: mantém funções globais existentes
window.$ = $; window.$all = $all; window.show = show; window.fmtCode = fmtCode;
window.countdown = countdown; window.renderRank = renderRank;
