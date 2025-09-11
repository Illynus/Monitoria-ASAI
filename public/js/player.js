// public/js/player.js — Reconexão + force join + limpeza de sessão
(function(){
  const socket = (window.socket) ? window.socket : io();

  function showJoinUI() {
    const joinView = document.getElementById('join-view');
    const gameView = document.getElementById('game-view');
    if (joinView) joinView.style.display = 'block';
    if (gameView) gameView.style.display = 'none';
  }
  function enterGameUI() {
    const joinView = document.getElementById('join-view');
    const gameView = document.getElementById('game-view');
    if (joinView) joinView.style.display = 'none';
    if (gameView) gameView.style.display = 'block';
  }
  function showError(code, msg) {
    console.error('[Erro]', code, msg || '');
    alert(`Não foi possível entrar: ${code || 'ERRO'}`);
  }

  function getSession() {
    try { return JSON.parse(localStorage.getItem('asai.session') || 'null'); } catch(e){ return null; }
  }
  function setSession(sess) {
    try { localStorage.setItem('asai.session', JSON.stringify(sess)); } catch(e){}
  }
  function clearSession() {
    try { localStorage.removeItem('asai.session'); } catch(e){}
  }

  function getOrCreatePlayerId() {
    let pid = null;
    try { pid = localStorage.getItem('asai.playerId'); } catch(e){}
    if (!pid) {
      pid = 'p_' + (Date.now().toString(16) + Math.random().toString(16).slice(2,10));
      try { localStorage.setItem('asai.playerId', pid); } catch(e){}
    }
    return pid;
  }

  function attemptAutoRejoin() {
    const sess = getSession();
    if (!sess || !sess.roomCode || !sess.playerId) return;
    socket.emit('rejoin', { roomCode: sess.roomCode, playerId: sess.playerId }, (res) => {
      if (res && res.ok) {
        enterGameUI();
      } else {
        clearSession();
        showJoinUI();
      }
    });
  }

  function joinRoom(roomCode, name) {
    clearSession();
    const payload = {
      roomCode: String(roomCode || '').trim(),
      name: String(name || '').trim() || 'Jogador',
      playerId: getOrCreatePlayerId(),
      force: true
    };
    socket.emit('join', payload, (res) => {
      if (!res || !res.ok) {
        return showError(res?.code || 'JOIN_FAILED', res?.msg);
      }
      setSession({ roomCode: res.room.code, playerId: res.playerId, role: 'player' });
      enterGameUI();
    });
  }

  socket.on('joined', (data) => {
    const sess = getSession() || {};
    const roomCode = (data?.room?.code || sess.roomCode || '').toUpperCase();
    const playerId = (data?.you?.playerId || sess.playerId || getOrCreatePlayerId());
    setSession({ roomCode, playerId, role: 'player' });
  });

  socket.on('roomClosed', () => {
    clearSession();
    showJoinUI();
  });

  socket.on('gameOver', () => {
    clearSession();
    showJoinUI();
  });

  socket.on('connect', attemptAutoRejoin);

  window.ASAIPlayer = { joinRoom, attemptAutoRejoin, getOrCreatePlayerId };
})();
