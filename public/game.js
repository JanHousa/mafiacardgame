/* ========== WebSocket komunikace ========== */
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
const ws = new WebSocket(WS_URL);

// Posílání zpráv s kontrolou stavu
const send = (data) => {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  } else {
    addLog('⚠️ WebSocket není připraven.');
  }
};


// Debug info a základní obsluha
ws.onopen = () => {
  addLog('✅ Připojeno k serveru.');
  // po připojení si vyžádáme aktuální lobby+state (když se refreshne stránka uprostřed hry)
  send({ type: 'get' });
};

ws.onclose = () => addLog('❌ Spojení ukončeno.');
ws.onerror = (e) => addLog('❗ Chyba spojení: ' + (e?.message || 'neznámá'));

ws.onmessage = (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); }
  catch { addLog('❗ Neplatná zpráva ze serveru.'); return; }

  switch (msg.type) {
    case 'lobby':
      if (msg.youId) window.__myId = msg.youId;
      if (msg.lobby) updateLobby(msg.lobby);
      break;

    case 'state':
      if (msg.state) applyState(msg.state);
      break;

    case 'info':
      if (msg.message) addLog(msg.message);
      break;

    case 'error':
      if (msg.message) addLog('❗ ' + msg.message);
      break;

    // 🔔 animace hodu kostkou (pokud server posílá)
    case 'dice':
      if (msg.symbol) showDiceRoll(msg.symbol);
      break;

    default:
      // ignore unknown
      break;
  }
};



/* ========== Utility ========== */
function myId() { return window.__myId; }
function addLog(text) {
  const log = document.getElementById('log');
  if (!log) return;
  const p = document.createElement('div');
  p.textContent = text;
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
}
function findName(id) {
  if (!STATE) return '';
  if (STATE.you?.id === id) return 'Vy';
  const other = (STATE.others || []).find(x => x.id === id);
  return other ? other.name : '';
}
function short(x){ return x ? x.slice(0,4)+'…' : ''; }

/* ========== DOM prvky ========== */
const lobbyPanel = document.getElementById('lobbyPanel');
const boardPanel = document.getElementById('boardPanel');
const players = document.getElementById('players');
const lobbyInfo = document.getElementById('lobbyInfo');
const codeMirror = document.getElementById('codeMirror');
const nameInp = document.getElementById('name');
const joinIdInp = document.getElementById('joinId');
const roomTag = document.getElementById('roomTag');

const hand = document.getElementById('hand');
const table = document.getElementById('table');
const meHearts = document.getElementById('meHearts');
const turnName = document.getElementById('turnName');
const deckCountEl = document.getElementById('deckCount');
const discardCountEl = document.getElementById('discardCount');
const hud = document.getElementById('hud');
const continental = document.getElementById('continental');

const timerArea = document.getElementById('timerArea');
const timerText = document.getElementById('timerText');
const timerBar = document.getElementById('timerBar');

/* Tlačítka */
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const readyBtn = document.getElementById('readyBtn');
const startBtn = document.getElementById('startBtn');
const endTurnBtn = document.getElementById('endTurn');
const backLobbyBtn = document.getElementById('backLobby');

/* ========== Lobby funkce ========== */
createBtn.onclick = () => send({ type: 'create', name: nameInp.value });
joinBtn.onclick = () => send({ type: 'join', lobbyId: joinIdInp.value, name: nameInp.value });
readyBtn.onclick = () => {
  const me = window.__lobby?.players?.find(p => p.id === myId());
  send({ type: 'ready', ready: !me?.ready });
};
startBtn.onclick = () => send({ type: 'start' });

function updateLobby(lobby) {
  window.__lobby = lobby;

  // Seznam hráčů + indikátor připravenosti
  players.innerHTML = lobby.players.length
    ? lobby.players.map(p =>
      `<span class="dot" style="background:${p.ready ? '#34e2a0' : '#64748b'}"></span>${p.name}${p.id === lobby.hostId ? ' (host)' : ''}`
    ).join('<br/>')
    : '<span class="hint">Zatím nikdo…</span>';

  // Info a kód
  lobbyInfo.textContent = `Kód lobby: ${lobby.lobbyId}  •  Host: ${short(lobby.hostId)} • Hráčů: ${lobby.players.length}`;
  codeMirror.textContent = lobby.lobbyId;

  // Ready button text
  const me = lobby.players.find(p => p.id === myId());
  readyBtn.textContent = me?.ready ? 'Zrušit připravenost' : 'Jsem připraven';

  // Start enabled jen pro hosta a pokud jsou min. 2 hráči a všichni ready
  const allReady = lobby.players.every(p => p.ready === true);
  startBtn.disabled = !(myId() === lobby.hostId && lobby.players.length >= 2 && allReady);

  // Přepnutí na board
  if (lobby.started) {
    lobbyPanel.style.display = 'none';
    boardPanel.style.display = 'block';
    roomTag.textContent = `Lobby ${lobby.lobbyId}`;
  }
}

/* ========== Board funkce ========== */
let STATE = null;
let selectedCard = null;
let rafId = null;

const META = {
  SHOT:{emoji:'🔫',name:'Výstřel',desc:'Střel na cíl do dostřelu zbraně. Obránce může 🛡️.'},
  DODGE:{emoji:'🛡️',name:'Úhyb',desc:'Reakce na Výstřel.'},
  KNIFE:{emoji:'🔪',name:'Nůž',desc:'Zraň cíl ve vzdálenosti 1.'},
  MOLOTOV:{emoji:'🍾',name:'Molotov',desc:'Zraň cíl ve vzdálenosti 1.'},
  SHOOTOUT:{emoji:'🤜🤛',name:'Přestřelka',desc:'Do 10s odhoď 🔫, jinak -1.'},
  SPRAY:{emoji:'🌪️',name:'Tommy Gun Spray',desc:'Do 10s odhoď 🛡️, jinak -1.'},
  VENDETTA:{emoji:'🗡️',name:'Vendeta',desc:'Střídavě odhazujte 🔫 v 10s oknech.'},
  WHISKEY:{emoji:'🥃',name:'Whiskey',desc:'+1 život.'},
  CIGAR:{emoji:'🚬',name:'Doutník',desc:'+1 život.'},
  PRISON:{emoji:'🚔',name:'Vězení',desc:'Cíl může vynechat tah.'},
  EXTORTION:{emoji:'💰',name:'Výpalné',desc:'Vem kartu nebo vybavení.'},
  RAID:{emoji:'🔥',name:'Razie',desc:'Spal náhodnou kartu cíle.'},
  W_SAWED:{emoji:'🧩',name:'Sawed-off',desc:'Zbraň: dostřel 2.'},
  W_DOUBLE:{emoji:'🧩',name:'Double-barrel',desc:'Zbraň: dostřel 2.'},
  W_COLT:{emoji:'🧩',name:'Colt 1911',desc:'Zbraň: dostřel 3.'},
  W_TOMMY:{emoji:'🧩',name:'Tommy Gun',desc:'Zbraň: dostřel 3, neomezené 🔫.'},
  W_WINCH:{emoji:'🧩',name:'Winchester',desc:'Zbraň: dostřel 4.'},
  W_SPRING:{emoji:'🧩',name:'Springfield',desc:'Zbraň: dostřel 5.'},
  VEST:{emoji:'🦺',name:'Neprůstřelná vesta',desc:'Při 🔫 hoď kostkou; na ❤️ ignoruješ zásah.'},
};

function applyState(s) {
  STATE = s;

  // Bezpečnost – pokud ti server pošle you poprvé, uložím si myId
  if (!window.__myId && s.you?.id) window.__myId = s.you.id;

  // Základní HUD
  deckCountEl.textContent = s.deckCount ?? 0;
  discardCountEl.textContent = s.discardCount ?? 0;
  turnName.textContent = findName(s.turnPlayerId) || '—';
  continental.textContent = s.roundNote ? `🃏 Kontinentál: ${s.roundNote}` : '';

  const myRole = s.you?.role ? `• Moje role: ${s.you.role}` : '';
  hud.textContent = `Na tahu: ${findName(s.turnPlayerId) || '—'} ${isMyTurn() ? '(JÁ)' : ''} ${myRole}`;

// Moje jméno
document.getElementById('myName').textContent = s.you?.name || 'Já';

// Životy (MOJE)
meHearts.innerHTML = '';
const maxHp = s.you?.maxHp ?? 4;
const hp = s.you?.hp ?? maxHp;
for (let i = 0; i < maxHp; i++) {
  const span = document.createElement('span');
  span.className = 'heart ' + (i < hp ? 'full' : 'empty');
  span.textContent = '♥';
  meHearts.appendChild(span);
}

// Statusy
const playerStatus = document.getElementById('playerStatus');
playerStatus.innerHTML = '';
if (s.you.inPrison) {
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = '🚔 Ve vězení';
  playerStatus.appendChild(badge);
}

// Vybavení
document.getElementById('myWeapon').textContent = s.you.weapon ? s.you.weapon.name : 'Žádná';
document.getElementById('myVest').textContent = s.you.vest ? 'Ano' : 'Žádná';

// Ruka
hand.innerHTML = '';
(s.you?.hand || []).forEach(card => {
  const m = META[card.type] || { name: card.type, emoji: '🃏', desc: '' };
  const div = document.createElement('div');
  div.className = 'card';
div.setAttribute('data-card-id', card.id);

div.innerHTML = `
  <div class="corner tl">
    <span>${m.emoji}</span>
    <small>${m.name}</small>
  </div>
  <div class="corner br">
    <span>${m.emoji}</span>
    <small>${m.name}</small>
  </div>

  <div class="art">${m.emoji}</div>
  <div class="rules">${m.desc}</div>
`;

  div.onclick = () => onPlay(card);
  hand.appendChild(div);
});


  renderOpponents(true);

  // Konec tahu povolen jen když jsem na tahu a nic nečeká
  endTurnBtn.disabled = !isMyTurn() || !!s.pending;

  // Eventy / modály / globální timer
  stopGlobalTimer();
  hideAllModals();

  if (s.pending) {
    if (s.pending.type === 'SHOT' && s.pending.askYouToDodge) {
      showShotModal();
    }
    if (s.pending.type === 'SHOOTOUT' || s.pending.type === 'SPRAY') {
      const need = s.pending.need === 'SHOT' ? '🔫 Výstřel' : '🛡️ Úhyb';
      const txt = s.pending.type === 'SHOOTOUT' ? 'Přestřelka' : 'Tommy Gun Spray';
      showGlobalTimer(`${txt}: do 10s ${need} – jinak -1.`, s.pending.endsAt);
      if (s.pending.youNeedToReact) {
        showMassModal(txt, `Reaguj: odhoď ${need}, nebo přijmi zásah.`, s.pending.endsAt, s.pending.need);
      }
    }
    if (s.pending.type === 'VENDETTA') {
      showGlobalTimer(`Vendeta: brání se ${findName(s.pending.defenderId)} (10s).`, s.pending.endsAt);
      if (s.pending.youNeedToReact) {
        showVendettaModal(s.pending.endsAt);
      }
    }
  }
}

function renderOpponents(resetTargets = false) {
  table.innerHTML = '';
  (STATE?.others || []).forEach(op => {
    const wrap = document.createElement('div');
    wrap.className = 'opponent' + (op.dead ? ' dead' : '');
    wrap.setAttribute('data-player-id', op.id);

    const roleHTML = `<div class="role-pill ${op.roleRevealed ? 'revealed' : ''}">${op.roleRevealed ? (op.role || '—') : 'Neznámá'}</div>`;
    const statusHTML = `
      <div class="status">
        ${op.inPrison ? '<span class="badge">🚔 Ve vězení</span>' : ''}
        ${op.weapon ? `<span class="badge">🔧 ${op.weapon.name}</span>` : ''}
        ${op.vest ? '<span class="badge">🦺 Vesta</span>' : ''}
      </div>`;

    // 1) Základ bez srdíček:
wrap.innerHTML = `
  <div class="who"><div>${op.name}</div>${roleHTML}</div>
  ${statusHTML}
  <div class="cards">Karty v ruce: ${op.handCount}</div>
`;

// 2) Srdíčka jako DOM uzly (stejně velké + barevně odlišené)
const hearts = document.createElement('div');
hearts.className = 'hearts';
const oMax = op.maxHp || op.hp || 0;

for (let i = 0; i < oMax; i++) {
  const h = document.createElement('span');
  h.className = 'heart ' + (i < op.hp ? 'full' : 'empty');
  h.textContent = '♥';
  hearts.appendChild(h);
}
wrap.insertBefore(hearts, wrap.querySelector('.cards'));



    table.appendChild(wrap);
  });

  if (resetTargets) {
    Array.from(table.querySelectorAll('.opponent')).forEach(n => { n.classList.remove('target'); n.onclick = null; });
    selectedCard = null;
  }
}

function isMyTurn(){ return !!(STATE && STATE.turnPlayerId && STATE.turnPlayerId === myId()); }

function onPlay(card){
  if (!isMyTurn()){ addLog('⏳ Nyní nejste na tahu.'); return; }
  const noTarget = [ 'WHISKEY','CIGAR','SHOOTOUT','SPRAY','W_SAWED','W_DOUBLE','W_COLT','W_TOMMY','W_WINCH','W_SPRING','VEST' ];
  if (noTarget.includes(card.type)){
    addLog(`▶️ Hraji ${META[card.type]?.name || card.type}.`);
    send({ type:'play', cardId: card.id });
    return;
  }
  selectedCard = card;
  addLog(`🎯 Vyberte cíl pro ${META[card.type]?.name || card.type}.`);
  highlightTargets();
}

function highlightTargets(){
  const nodes = Array.from(table.querySelectorAll('.opponent'));
  nodes.forEach(n => { n.classList.remove('target'); n.onclick = null; });
  if (!selectedCard) return;

  for (const n of nodes){
    const pid = n.getAttribute('data-player-id');
    const op = (STATE?.others || []).find(o => o.id === pid);
    if (!op || op.dead) continue;

    n.classList.add('target');
    n.onclick = () => {
      addLog(`▶️ ${META[selectedCard.type]?.name || selectedCard.type} na ${op.name}.`);
      send({ type:'play', cardId: selectedCard.id, targetId: pid });
      selectedCard = null;
      nodes.forEach(x => { x.classList.remove('target'); x.onclick = null; });
    };
  }
}

/* Zpět do lobby */
backLobbyBtn.onclick = () => {
  boardPanel.style.display = 'none';
  lobbyPanel.style.display = 'block';
};

/* Konec tahu */
endTurnBtn.onclick = () => {
  if (!isMyTurn()) { 
    addLog('⏳ Nyní nejste na tahu.'); 
    return; 
  }

  // Pokud byl hráč ve vězení, po tomto tahu se resetuje
  if (STATE.you?.inPrison) {
    send({ type: 'statusUpdate', field: 'inPrison', value: false });
  }

  send({ type: 'endTurn' });
};


/* ---------- Timer helpers ---------- */
function showGlobalTimer(text, endsAtMs){
  timerArea.style.display='block';
  timerText.textContent=text;
  animateBar(timerBar, endsAtMs);
}
function stopGlobalTimer(){
  timerArea.style.display='none';
  if (rafId) cancelAnimationFrame(rafId);
  rafId=null;
  if (timerBar) timerBar.style.width='100%';
}
function animateBar(barEl, endsAt){
  const DURATION = Math.max(0, (endsAt || (Date.now()+10000)) - Date.now());
  const start = performance.now();
  function step(now){
    const t = Math.min(1, (now - start) / DURATION);
    const remainingPct = 100 * (1 - t);
    barEl.style.width = remainingPct + '%';
    if (t < 1) { rafId = requestAnimationFrame(step); } else { barEl.style.width='0%'; }
  }
  rafId = requestAnimationFrame(step);
}

/* ---------- Modals ---------- */
const askShot = document.getElementById('askShot');
const shotYes = document.getElementById('askShotYes');
const shotNo  = document.getElementById('askShotNo');
const shotTimer = document.getElementById('shotTimer');

const askMass = document.getElementById('askMass');
const massTitle = document.getElementById('massTitle');
const massBody  = document.getElementById('massBody');
const massYes   = document.getElementById('massYes');
const massNo    = document.getElementById('massNo');
const massTimer = document.getElementById('massTimer');

const askVend = document.getElementById('askVend');
const vendYes = document.getElementById('vendYes');
const vendNo  = document.getElementById('vendNo');
const vendTimer = document.getElementById('vendTimer');

function hideAllModals(){ askShot.classList.remove('show'); askMass.classList.remove('show'); askVend.classList.remove('show'); }

function showShotModal(){
  askShot.classList.add('show');
  animateBar(shotTimer, Date.now()+10000); // animace 10s
  shotYes.onclick = () => { send({ type:'reaction', choice:'DODGE' }); hideAllModals(); };
  shotNo .onclick = () => { send({ type:'reaction', choice:'TAKE_HIT' }); hideAllModals(); };
}
function showMassModal(title, body, endsAt, needType){
  askMass.classList.add('show');
  massTitle.textContent = title;
  massBody.textContent = body;
  animateBar(massTimer, endsAt);
  massYes.onclick = () => { send({ type:'eventReaction', choice:'DISCARD', expect: needType }); hideAllModals(); };
  massNo .onclick = () => { send({ type:'eventReaction', choice:'PASS' }); hideAllModals(); };
}
function showVendettaModal(endsAt){
  askVend.classList.add('show');
  animateBar(vendTimer, endsAt);
  vendYes.onclick = () => { send({ type:'eventReaction', choice:'DISCARD' }); hideAllModals(); };
  vendNo .onclick = () => { send({ type:'eventReaction', choice:'PASS' }); hideAllModals(); };
}

function showDiceRoll(symbol) {
  const overlay = document.getElementById('diceOverlay');
  const diceEl = document.getElementById('diceResult');

  overlay.classList.add('show');
  diceEl.textContent = '🎲';

  const symbols = ['🎲','💥','🚔','❤️','🔫','💰','🃏'];
  let i = 0;
  const interval = setInterval(() => {
    diceEl.textContent = symbols[i % symbols.length];
    i++;
  }, 90);

  setTimeout(() => {
    clearInterval(interval);
    diceEl.textContent = symbol;
    // krátký „hold“, ať si každý výsledek přečte
    setTimeout(() => overlay.classList.remove('show'), 1800);
  }, 2200);
}
