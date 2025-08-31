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

  if (msg.type === 'lobby') {
    if (msg.youId) window.__myId = msg.youId;
    updateLobby(msg.lobby);
  }
  if (msg.type === 'state') {
    // pokud se změnil hráč na tahu → zvýraznit
    const prevTurn = STATE?.turnPlayerId;
    applyState(msg.state);
    if (prevTurn !== msg.state.turnPlayerId) {
      const who = findName(msg.state.turnPlayerId) || '—';
      showNow(`🔁 Na tahu: ${who}`, 'info', 2200);
    }
  }
  if (msg.type === 'info')  {
    addLog(msg.message);
    showNow(msg.message, levelFromMessage(msg.message));
  }
  if (msg.type === 'error') {
    addLog('❗ ' + msg.message);
    showNow('❗ ' + msg.message, 'danger', 3000);
    showToast('Chyba', msg.message, 'danger', 5000);
  }

  // 🎲 kostka – už máš animaci; doplníme i nowbar
  if (msg.type === 'dice' && msg.symbol) {
    const purposeMap = { PRISON: 'vězení', VEST: 'vesta', OTHER: '—' };
    const purposeTxt = purposeMap[msg.purpose] || '—';
    const byName = msg.byName || findName(msg.byId) || 'Hráč';
    showDiceRoll(msg.symbol, `${byName} hází kostkou (${purposeTxt})`);
    const txt = `🎲 ${byName} (${purposeTxt}) → ${msg.symbol}`;
    addLog(txt);
    showNow(txt, 'info');
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

const CARD_IMG = {
  SHOT:     'img/cards/shot.png',
  DODGE:    'img/cards/dodge.png',
  KNIFE:    'img/cards/knife.png',
  MOLOTOV:  'img/cards/molotov.png',
  SHOOTOUT: 'img/cards/shootout.png',
  SPRAY:    'img/cards/spray.png',
  VENDETTA: 'img/cards/vendetta.png',
  WHISKEY:  'img/cards/whiskey.png',
  CIGAR:    'img/cards/cigar.png',
  PRISON:   'img/cards/prison.png',
  EXTORTION:'img/cards/extortion.png',
  RAID:     'img/cards/raid.png',
  W_SAWED:  'img/cards/w_sawed.png',
  W_DOUBLE: 'img/cards/w_double.png',
  W_COLT:   'img/cards/w_colt.png',
  W_TOMMY:  'img/cards/w_tommy.png',
  W_WINCH:  'img/cards/w_winch.png',
  W_SPRING: 'img/cards/w_spring.png',
  VEST:     'img/cards/vest.png',
};
const FALLBACK_CARD_IMG = 'img/cards/placeholder.png';


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

  // --- vizuální balíčky
  const deckBadge = document.getElementById('deckCountBadge');
  const discBadge = document.getElementById('discardCountBadge');
  const discImg   = document.getElementById('discardTopImg');
  const discWrap  = document.getElementById('discardPile');

  if (deckBadge) deckBadge.textContent = s.deckCount ?? 0;
  if (discBadge) discBadge.textContent = s.discardCount ?? 0;

  if (discImg){
    if (s.discardTop){
      discImg.src = CARD_IMG[s.discardTop] || FALLBACK_CARD_IMG;
      discWrap?.classList.remove('empty');
    } else {
      discImg.src = FALLBACK_CARD_IMG;
      discWrap?.classList.add('empty');
    }
  }


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
renderMyEquip(s.you);

function renderMyEquip(you) {
  const grid = document.getElementById('myEquip');
  if (!grid) return;
  grid.innerHTML = '';

  // --- Zbraň (slot)
  if (you.weapon) {
    const w = you.weapon;
    const wEl = document.createElement('div');
    wEl.className = 'equip-card';
    wEl.innerHTML = `
      <span class="chip">Zbraň</span>
      <div class="imgwrap">
        <img src="${CARD_IMG[w.type] || FALLBACK_CARD_IMG}" alt="${w.name}" title="${w.name}">
      </div>
      <div class="label">${w.name}</div>
    `;
    grid.appendChild(wEl);
  } else {
    const wEl = document.createElement('div');
    wEl.className = 'equip-card empty';
    wEl.innerHTML = `
      <span class="chip">Zbraň</span>
      <div class="imgwrap">
        <img src="${FALLBACK_CARD_IMG}" alt="Žádná zbraň">
      </div>
      <div class="label">Žádná</div>
    `;
    grid.appendChild(wEl);
  }

  // --- Vesta (slot)
  if (you.vest) {
    const vEl = document.createElement('div');
    vEl.className = 'equip-card';
    vEl.innerHTML = `
      <span class="chip">Vesta</span>
      <div class="imgwrap">
        <img src="${CARD_IMG.VEST || FALLBACK_CARD_IMG}" alt="Neprůstřelná vesta" title="Neprůstřelná vesta">
      </div>
      <div class="label">Neprůstřelná vesta</div>
    `;
    grid.appendChild(vEl);
  } else {
    const vEl = document.createElement('div');
    vEl.className = 'equip-card empty';
    vEl.innerHTML = `
      <span class="chip">Vesta</span>
      <div class="imgwrap">
        <img src="${FALLBACK_CARD_IMG}" alt="Bez vesty">
      </div>
      <div class="label">Žádná</div>
    `;
    grid.appendChild(vEl);
  }
}


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

  <div class="art">
    <img src="${CARD_IMG[card.type] || FALLBACK_CARD_IMG}" alt="${m.name}">
  </div>

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
  const others = STATE?.others || [];

  others.forEach(op => {
    const wrap = document.createElement('div');
    wrap.className = 'opponent' + (op.dead ? ' dead' : '');
    wrap.setAttribute('data-player-id', op.id);

    const roleHTML =
      `<span class="role-pill ${op.roleRevealed ? 'revealed' : ''}">
         ${op.roleRevealed ? (op.role || '—') : 'Neznámá'}
       </span>`;

    const isTurn = (STATE?.turnPlayerId === op.id);
    const turnHTML = isTurn ? `<span class="turn-badge">Na tahu</span>` : '';

    // Ikony vybavení (zbraň + vesta)
    const equipIcons = [];
    if (op.weapon) {
      equipIcons.push(
        `<img src="${CARD_IMG[op.weapon.type] || FALLBACK_CARD_IMG}"
              alt="${op.weapon.name}"
              title="${op.weapon.name}"
              class="equip-icon">`
      );
    }
    if (op.vest) {
      equipIcons.push(
        `<img src="${CARD_IMG.VEST || FALLBACK_CARD_IMG}"
              alt="Vesta"
              title="Vesta"
              class="equip-icon">`
      );
    }
    const equipHTML = equipIcons.length
      ? `<div class="equip-icons">${equipIcons.join('')}</div>` : '';

    // Sestav obsah karty oponenta
    wrap.innerHTML = `
      ${turnHTML}
      <div class="who">
        <div class="name">${op.name}</div>
        ${roleHTML}
      </div>
      ${equipHTML}
      <div class="hearts"></div>
      <div class="cards">Karty v ruce: ${op.handCount}</div>
    `;

    // ♥ Srdíčka do vyhrazeného kontejneru
    const heartsEl = wrap.querySelector('.hearts');
    const max = op.maxHp || op.hp || 0;
    for (let i = 0; i < max; i++) {
      const h = document.createElement('span');
      h.className = 'heart ' + (i < op.hp ? 'full' : 'empty');
      h.textContent = '♥';
      heartsEl.appendChild(h);
    }

    table.appendChild(wrap);
  });

  if (resetTargets) {
    Array.from(table.querySelectorAll('.opponent')).forEach(n => {
      n.classList.remove('target');
      n.onclick = null;
    });
    selectedCard = null;
  }
}




function isMyTurn(){ return !!(STATE && STATE.turnPlayerId && STATE.turnPlayerId === myId()); }

function onPlay(card){
  if (!isMyTurn()){ 
    const m = '⏳ Nyní nejste na tahu.';
    addLog(m); showNow(m, 'warn'); 
    return; 
  }
  const name = META[card.type]?.name || card.type;
  const m = `▶️ Hraji ${name}.`;
  if (['WHISKEY','CIGAR','SHOOTOUT','SPRAY','W_SAWED','W_DOUBLE','W_COLT','W_TOMMY','W_WINCH','W_SPRING','VEST'].includes(card.type)){
    addLog(m); showNow(m, 'info');
    send({ type:'play', cardId: card.id });
    return;
  }
  selectedCard = card;
  const pick = `🎯 Vyber cíl pro ${name}.`;
  addLog(pick); showNow(pick, 'info');
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

function showDiceRoll(symbol, titleText = '🎲 Hod kostkou') {
  const overlay = document.getElementById('diceOverlay');
  const diceEl = document.getElementById('diceResult');
  const titleEl = document.getElementById('diceTitle') 
               || document.querySelector('#diceOverlay h3');

  if (titleEl) titleEl.textContent = titleText;

  overlay.classList.add('show');
  diceEl.textContent = '🎲';

  const symbols = ['🎲','💥','🚔','❤️','🔫','💰','🃏'];
  let i = 0;
  const interval = setInterval(() => {
    diceEl.textContent = symbols[i % symbols.length];
    i++;
  }, 110);

  setTimeout(() => {
    clearInterval(interval);
    diceEl.textContent = symbol;
    setTimeout(() => overlay.classList.remove('show'), 1500);
  }, 1800);
}

/* ===== Notifier ===== */
let nowTimeout = null;

function levelFromMessage(text){
  // hrubé mapování podle emoji/klíčových slov
  if (/☠|❌|⚠️|error|chyba|zranění|padl/i.test(text)) return 'danger';
  if (/🚔|pozor|varování|stanné/i.test(text)) return 'warn';
  if (/🥃|vyléčí|vyhr|✔|✅/i.test(text)) return 'ok';
  return 'info';
}

function showNow(text, level='info', holdMs=2400){
  const bar = document.getElementById('nowBar');
  if (!bar) return;
  bar.className = `nowbar show ${level}`;
  bar.textContent = text;
  clearTimeout(nowTimeout);
  nowTimeout = setTimeout(()=> { bar.classList.remove('show'); }, holdMs);
}

// volitelné – queue toasts
function showToast(title, body='', level='info', ttl=4000){
  const box = document.getElementById('toasts'); if(!box) return;
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.innerHTML = `
    <span class="close">×</span>
    <div class="title">${title}</div>
    ${body ? `<div class="body">${body}</div>` : '' }
  `;
  const close = ()=>{ el.style.animation = 'toastOut .2s ease forwards'; setTimeout(()=>el.remove(), 180); };
  el.querySelector('.close').onclick = close;
  box.appendChild(el);
  setTimeout(close, ttl);
}
