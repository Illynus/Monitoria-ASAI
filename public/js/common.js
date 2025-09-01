const socket = io();
function $(sel){ return document.querySelector(sel); }
function $all(sel){ return Array.from(document.querySelectorAll(sel)); }
function show(el, on=true){ el.classList.toggle('hidden', !on); }
function fmtCode(c){ return (c||'').toUpperCase(); }
function countdown(ms, onTick, onEnd){
  const start = Date.now();
  const t = setInterval(()=>{
    const left = Math.max(0, ms - (Date.now()-start));
    const s = Math.ceil(left/1000);
    onTick(s);
    if (left<=0){ clearInterval(t); onEnd && onEnd(); }
  }, 250);
  return ()=> clearInterval(t);
}
function renderRank(listEl, board){
  listEl.innerHTML = '';
  const max = Math.max(1, ...board.map(b=>b.score));
  board.forEach((item, idx)=>{
    const li = document.createElement('li'); li.className = 'rank-item';
    const medal = document.createElement('div'); medal.className = 'rank-medal';
    if (idx===0){ medal.textContent='🥇'; li.style.color='var(--gold)'; }
    else if (idx===1){ medal.textContent='🥈'; li.style.color='var(--silver)'; }
    else if (idx===2){ medal.textContent='🥉'; li.style.color='var(--bronze)'; }
    else { medal.textContent = `${idx+1}`; }

    const avatar = document.createElement('img'); avatar.className='avatar';
    avatar.src = '/assets/avatars/' + (item.avatar || 'stethoscope.svg'); avatar.alt = 'avatar';

    const name = document.createElement('div'); name.textContent = `${item.nick} — ${item.score} pts`;
    const bar = document.createElement('div'); bar.className = 'rank-bar';
    const fill = document.createElement('div'); fill.className = 'rank-fill';
    fill.style.width = Math.round(item.score/max*100)+'%';
    bar.appendChild(fill);

    li.appendChild(medal);
    li.appendChild(avatar);
    li.appendChild(name);
    li.appendChild(bar);
    listEl.appendChild(li);
  });
}