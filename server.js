import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

/* ===== Utils ===== */
const shuffle = (a)=>{ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };
const id = ()=> Math.random().toString(36).slice(2,10);
const now = ()=> new Date().toISOString();
const rand = (n)=> Math.floor(Math.random()*n);

/* ===== Constants ===== */
const ROLE = {
  DON:"Don", MAFIA:"Mafián", POLICE:"Policie", TRAITOR:"Zrádce", OPPORTUNIST:"Oportunista"
};
const CARD = {
  // attacks & reactions
  SHOT:"SHOT", DODGE:"DODGE", KNIFE:"KNIFE", MOLOTOV:"MOLOTOV",
  SHOOTOUT:"SHOOTOUT", SPRAY:"SPRAY", VENDETTA:"VENDETTA",
  // heals
  WHISKEY:"WHISKEY", CIGAR:"CIGAR",
  // control
  PRISON:"PRISON", EXTORTION:"EXTORTION", RAID:"RAID",
  // weapons (equipment)
  W_SAWED:"W_SAWED", W_DOUBLE:"W_DOUBLE", W_COLT:"W_COLT", W_TOMMY:"W_TOMMY", W_WINCH:"W_WINCH", W_SPRING:"W_SPRING",
  // armor
  VEST:"VEST",
  // continentál (jen ke zobrazení – v balíčku **není**, server má svůj „deck“)
};
const WEAPON_META = {
  W_SAWED:{name:"Sawed-off Shotgun", range:2, multi:false},
  W_DOUBLE:{name:"Double-barrel Shotgun", range:2, multi:false},
  W_COLT:{name:"Colt 1911", range:3, multi:false},
  W_TOMMY:{name:"Thompson M1928", range:3, multi:true}, // multi-shot
  W_WINCH:{name:"Winchester 1894", range:4, multi:false},
  W_SPRING:{name:"Springfield M1903", range:5, multi:false},
};
const CONTINENTAL = [
  "Zrada v rodině – každý hráč si vymění ruku s hráčem po levici",
  "Velká loupež – všichni odhodí zbraně a vybavení",
  "Velká čistka – hráč s nejvíce vybavením o něj přijde",
  "Noc dlouhých nožů – všechny útoky způsobují +1 zranění",
  "Krvavá neděle – hráči s nejvíce životy ztrácí 1 život",
  "Poslední kolo whisky – všichni líznou 1 kartu navíc, ale ztratí 1 život",
  "Zabij nebo zemři – pokud v tomto kole hráč nezpůsobí aspoň 1 dmg, na konci kola ztratí 1 život",
  "Rodinná hostina – všichni si vyléčí 1 život",
  "Poslední přání – hráč s nejméně životy si smí vzít jakékoli vybavení ze stolu",
  "Stanné právo – v tomto kole nikdo nesmí střílet",
  "Vydírání novinářů – hráč s nejvíce kartami v ruce ukáže ruku a dá 1 kartu hráči s nejméně kartami",
];

/* ===== Deck ===== */
let gid = 0;
const newCard = (type)=>({ id: ++gid, type });

/** hrubý mix karet – klidně upravíš podle testů */
const makeDeck = ()=>{
  const d=[];
  // attacks
  for(let i=0;i<20;i++) d.push(newCard(CARD.SHOT));
  for(let i=0;i<6;i++)  d.push(newCard(CARD.KNIFE));
  for(let i=0;i<6;i++)  d.push(newCard(CARD.MOLOTOV));
  for(let i=0;i<4;i++)  d.push(newCard(CARD.SPRAY));
  for(let i=0;i<4;i++)  d.push(newCard(CARD.SHOOTOUT));
  for(let i=0;i<3;i++)  d.push(newCard(CARD.VENDETTA));
  // reactions
  for(let i=0;i<14;i++) d.push(newCard(CARD.DODGE));
  // heals
  for(let i=0;i<10;i++) d.push(newCard(CARD.WHISKEY));
  for(let i=0;i<8;i++)  d.push(newCard(CARD.CIGAR));
  // control
  for(let i=0;i<5;i++)  d.push(newCard(CARD.PRISON));
  for(let i=0;i<6;i++)  d.push(newCard(CARD.EXTORTION));
  for(let i=0;i<4;i++)  d.push(newCard(CARD.RAID));
  // weapons
  for(let i=0;i<3;i++)  d.push(newCard(CARD.W_SAWED));
  for(let i=0;i<3;i++)  d.push(newCard(CARD.W_DOUBLE));
  for(let i=0;i<4;i++)  d.push(newCard(CARD.W_COLT));
  for(let i=0;i<3;i++)  d.push(newCard(CARD.W_TOMMY));
  for(let i=0;i<2;i++)  d.push(newCard(CARD.W_WINCH));
  for(let i=0;i<2;i++)  d.push(newCard(CARD.W_SPRING));
  // armor
  for(let i=0;i<5;i++)  d.push(newCard(CARD.VEST));

  return shuffle(d);
};

/* ===== Server state ===== */
const lobbies = new Map(); // lobbyId -> lobby

function distanceAlive(lobby, a, b){
  // kruhová vzdálenost mezi živými hráči podle aktuálního pořadí ve "players"
  const alive = lobby.players.filter(p=>!p.dead);
  const idx = (x)=> alive.findIndex(p=>p.id===x.id);
  const ia = idx(a), ib = idx(b);
  if (ia<0 || ib<0) return Infinity;
  const n = alive.length;
  const cw = (ib - ia + n) % n;
  const ccw = (ia - ib + n) % n;
  return Math.min(cw, ccw);
}

function equipRange(player){
  if (!player.weapon) return 1;
  return WEAPON_META[player.weapon.type]?.range || 1;
}
function canMultiShot(player){
  if (!player.weapon) return false;
  return !!WEAPON_META[player.weapon.type]?.multi;
}

/* ===== Lobby helpers ===== */
function joinLobby(lobby, ws, name){
  const player = {
    id: id(), ws,
    name: (name||"Hráč").trim(),
    ready: false,
    role: null,
    hp: 0, maxHp: 0,
    hand: [],
    dead: false,
    revealedRole: false,
    inPrison: false,
    weapon: null, // {id,type}
    vest: false,
    _shotThisTurn: 0,
    _dealtDamageThisRound: false, // pro Continental „Zabij nebo zemři“ (zatím jen indikace)
  };
  lobby.players.push(player);
  ws._playerId = player.id;
  ws._lobbyId  = lobby.id;
  return player;
}
function makeLobby(hostWs, hostName){
  const lobbyId = Math.random().toString(36).slice(2,6).toUpperCase();
  const lobby = {
    id: lobbyId,
    players: [],
    hostId: null,
    started: false,
    turnIdx: 0,
    deck: [],
    discard: [],
    pending: null, // {type:'SHOT', attackerId, defenderId}
    createdAt: now(),
    continental: shuffle(CONTINENTAL.slice()), // jen texty
    roundNote: null, // aktuální text kontinentálu pro kolo (jen info)
  };
  lobbies.set(lobbyId, lobby);
  const hostPlayer = joinLobby(lobby, hostWs, hostName);
  lobby.hostId = hostPlayer.id;
  return { lobby, hostPlayer };
}
function lobbySummary(lobby){
  return {
    lobbyId: lobby.id,
    hostId: lobby.hostId,
    started: lobby.started,
    players: lobby.players.map(p=>({ id:p.id, name:p.name, ready:p.ready }))
  };
}
function broadcast(lobby, type, payloadPerClient=null){
  for(const p of lobby.players){
    if (!p.ws || p.ws.readyState!==1) continue;
    const payload = payloadPerClient ? payloadPerClient(p) : {};
    p.ws.send(JSON.stringify({ type, ...payload }));
  }
}
function personalizedState(lobby, viewer){
  const you = redactPlayer(viewer, viewer, true);
  const others = lobby.players.filter(p=>p.id!==viewer.id).map(p=>redactPlayer(p, viewer, false));
  const turnPlayer = lobby.players[lobby.turnIdx];
  return {
    state: {
      you, others,
      deckCount: lobby.deck.length,
      discardCount: lobby.discard.length,
      turnPlayerId: turnPlayer?.id || null,
      started: lobby.started,
      pending: redactPending(lobby.pending, viewer),
      roundNote: lobby.roundNote || null,
    }
  };
}
function redactPlayer(p, viewer, isYou){
  return {
    id: p.id,
    name: p.name,
    hp: p.hp, maxHp: p.maxHp, dead: p.dead,
    roleRevealed: p.revealedRole || p.id===viewer.id,
    role: (p.revealedRole || isYou) ? p.role : null,
    hand: isYou ? p.hand : null,
    handCount: p.hand.length,
    weapon: p.weapon ? {type:p.weapon.type, name:WEAPON_META[p.weapon.type]?.name||"Zbraň"} : null,
    vest: !!p.vest,
    inPrison: !!p.inPrison,
  };
}
function redactPending(pending, viewer){
  if (!pending) return null;
  if (pending.type==="SHOT"){
    return {
      type:"SHOT",
      attackerId: pending.attackerId,
      defenderId: pending.defenderId,
      askYouToDodge: pending.defenderId===viewer.id
    };
  }
  return null;
}

/* ===== Game flow ===== */
function assignRoles(lobby){
  const n = lobby.players.length;
  // mřížka rolí (rozumné defaulty)
  // 2: Don + Zrádce
  // 3: Don + Mafián + Policie
  // 4: Don + Mafián + Policie + Zrádce
  // 5: Don + 2x Mafián + 2x Policie
  // 6: Don + 2x Mafián + 2x Policie + Zrádce
  // 7: Don + 2x Mafián + 2x Policie + Zrádce + Oportunista
  const templates = {
    2:[ROLE.DON, ROLE.TRAITOR],
    3:[ROLE.DON, ROLE.MAFIA, ROLE.POLICE],
    4:[ROLE.DON, ROLE.MAFIA, ROLE.POLICE, ROLE.TRAITOR],
    5:[ROLE.DON, ROLE.MAFIA, ROLE.MAFIA, ROLE.POLICE, ROLE.POLICE],
    6:[ROLE.DON, ROLE.MAFIA, ROLE.MAFIA, ROLE.POLICE, ROLE.POLICE, ROLE.TRAITOR],
    7:[ROLE.DON, ROLE.MAFIA, ROLE.MAFIA, ROLE.POLICE, ROLE.POLICE, ROLE.TRAITOR, ROLE.OPPORTUNIST],
  };
  const roles = templates[n];
  const order = shuffle(lobby.players.slice());
  roles.forEach((r, i)=>{
    const p = order[i];
    p.role = r;
    p.maxHp = (r===ROLE.DON ? 5 : 4);
    p.hp = p.maxHp;
    p.revealedRole = (r===ROLE.DON); // Don je odhalený
  });
}

function startGame(lobby){
  const n = lobby.players.length;
  if (n<2 || n>7) return;
  lobby.started = true;
  gid = 0;
  lobby.deck = makeDeck();
  lobby.discard = [];
  lobby.pending = null;
  lobby.roundNote = null;
  for (const p of lobby.players){
    p.inPrison=false; p.weapon=null; p.vest=false; p.dead=false;
    p._shotThisTurn=0; p._dealtDamageThisRound=false;
    p.hand.length=0;
  }

  assignRoles(lobby);

  // rozdej 4
  for(let i=0;i<4;i++) for(const p of lobby.players) drawCard(lobby, p, 1);

  // Don začíná
  lobby.turnIdx = lobby.players.findIndex(p=>p.role===ROLE.DON);
  startTurn(lobby);

  // rozeslat
  broadcast(lobby,"lobby",(viewer)=>({ lobby:lobbySummary(lobby), youId: viewer.id }));
  broadcast(lobby,"state",(viewer)=> personalizedState(lobby, viewer));
  info(lobby,"Hra začíná. Don je odhalený a je na tahu.");
}

function startTurn(lobby){
  const p = currentPlayer(lobby);
  if (!p || p.dead){ nextTurn(lobby); return; }

  // reset turn flags
  for(const x of lobby.players) x._shotThisTurn=0;

  // Kontinentál – jen Don otáčí
  if (p.role===ROLE.DON){
    if (lobby.continental.length===0) lobby.continental = shuffle(CONTINENTAL.slice());
    lobby.roundNote = lobby.continental.pop();
    info(lobby, `🃏 Kontinentál: ${lobby.roundNote} (prototyp – bez efektu)`);
  } else {
    lobby.roundNote = null;
  }

  // vězení?
  if (p.inPrison){
    const dice = rollDice();
    if (dice.symbol==="🚔"){ // ven
      p.inPrison = false;
      info(lobby, `🚔 ${p.name} se dostal z vězení a hraje normálně.`);
    } else {
      info(lobby, `🚔 ${p.name} zůstává ve vězení a kolo vynechává.`);
      nextTurn(lobby);
      return;
    }
  }

  // lízni 2
  drawCard(lobby, p, 2);
  info(lobby, `Na tahu: ${p.name}`);
}

function drawCard(lobby, player, n=1){
  for(let i=0;i<n;i++){
    if (lobby.deck.length===0){
      if (lobby.discard.length===0) return;
      lobby.deck = shuffle(lobby.discard.splice(0));
      info(lobby,"Balíček došel. Zamícháno odhazoviště.");
    }
    player.hand.push(lobby.deck.pop());
  }
}

function discard(lobby, card){ lobby.discard.push(card); }
function info(lobby, message){ broadcast(lobby,"info",()=>({ message, at:now() })); }
function currentPlayer(lobby){ return lobby.players[lobby.turnIdx]; }

function nextTurn(lobby){
  // „Zabij nebo zemři“ – jen indikace (bez efektu v prototypu)
  for (const p of lobby.players) p._dealtDamageThisRound=false;

  let idx = lobby.turnIdx;
  do { idx = (idx+1) % lobby.players.length; } while(lobby.players[idx].dead && idx!==lobby.turnIdx);
  lobby.turnIdx = idx;

  startTurn(lobby);
  broadcast(lobby,"state",(viewer)=> personalizedState(lobby, viewer));
}

function equipWeapon(player, card){
  player.weapon = { id: card.id, type: card.type };
}
function unequipWeapon(lobby, player){
  if (player.weapon){
    discard(lobby, { id: player.weapon.id, type: player.weapon.type }); // zahoď
    player.weapon = null;
  }
}

/* ===== Dice ===== */
function rollDice(){
  const faces = [
    {symbol:"💥", name:"Dynamit"},
    {symbol:"🚔", name:"Vězení"},
    {symbol:"❤️", name:"Srdce"},
    {symbol:"🔫", name:"Zbraň"},
    {symbol:"💰", name:"Úplatek"},
    {symbol:"🃏", name:"Joker"},
  ];
  const r = faces[rand(faces.length)];
  return r;
}

/* ===== Combat & effects ===== */
function weaponRange(player){ return equipRange(player); }

function withinRange(lobby, attacker, defender){
  const dist = distanceAlive(lobby, attacker, defender);
  const r = weaponRange(attacker);
  return dist <= r;
}

function handleDamage(lobby, target, amount, srcType=null, from=null){
  if (target.dead) return;

  // Neprůstřelná vesta chrání proti Výstřelu (jen SHOT)
  if (srcType===CARD.SHOT && target.vest){
    const dice = rollDice();
    info(lobby, `🦺 Vesta: ${target.name} hází kostkou… ${dice.symbol}`);
    if (dice.symbol==="❤️"){
      info(lobby, `🦺 ❤️ Zásah negován vestou!`);
      return;
    }
  }

  target.hp -= amount;
  if (from) from._dealtDamageThisRound = true;
  if (target.hp<=0){ target.hp=0; kill(lobby, target, from); }
  else { info(lobby, `💥 ${target.name} utržil ${amount} zranění${from?` (od ${from.name})`:''}.`); }
}

function kill(lobby, p, from=null){
  p.dead = true; p.revealedRole = true;
  // zahoď ruku a vybavení
  while(p.hand.length) discard(lobby, p.hand.pop());
  if (p.weapon){ discard(lobby, { id:p.weapon.id, type:p.weapon.type }); p.weapon=null; }
  if (p.vest){ discard(lobby, newCard(CARD.VEST)); p.vest=false; }
  info(lobby, `☠️ ${p.name} padl. (${p.role})`);
  checkWin(lobby);
}

function checkWin(lobby){
  if (!lobby.started) return false;
  const alive = lobby.players.filter(p=>!p.dead);
  const don = lobby.players.find(p=>p.role===ROLE.DON);
  const maf = lobby.players.filter(p=>!p.dead && (p.role===ROLE.DON || p.role===ROLE.MAFIA));
  const policeAlive = lobby.players.some(p=>!p.dead && p.role===ROLE.POLICE);
  const traitorAlive = lobby.players.some(p=>!p.dead && p.role===ROLE.TRAITOR);
  const opportunistAlive = lobby.players.some(p=>!p.dead && p.role===ROLE.OPPORTUNIST);

  // Zrádce/Oportunista – poslední přeživší
  if (alive.length===1){
    const last = alive[0];
    if (last.role===ROLE.TRAITOR){ info(lobby, "🃏 Zrádce vítězí jako poslední přeživší!"); lobby.started=false; return true; }
    if (last.role===ROLE.OPPORTUNIST){ info(lobby, "🃏 Oportunista vítězí – přežil do konce!"); lobby.started=false; return true; }
  }

  // Don padl → Policie vyhrává (pokud poslední není Zrádce – to by chytl výhru výše)
  if (!don || don.dead){
    info(lobby, "🚔 Don padl – Policie vítězí!");
    // Oportunista (pokud existuje a žije) – získá svou výhru „přežil do konce“
    if (opportunistAlive) info(lobby, "🃏 Oportunista také vítězí (přežil do konce).");
    lobby.started=false; return true;
  }

  // Mafia (Don + Mafiáni) vyhrává, když Policie i Zrádce jsou pryč
  if (!policeAlive && !traitorAlive){
    info(lobby, "🕴️ Don a Mafiáni ovládli město – vítězství Mafie!");
    if (opportunistAlive) info(lobby, "🃏 Oportunista také vítězí (přežil do konce).");
    lobby.started=false; return true;
  }

  return false;
}

/* ===== Actions ===== */
function playCard(lobby, player, cardId, targetId=null){
  if (!lobby.started) return;
  const cur = currentPlayer(lobby);
  if (!cur || player.id!==cur.id) return;            // ne můj tah
  if (lobby.pending) return;                          // čekáme reakci

  const i = player.hand.findIndex(c=>c.id===cardId);
  if (i<0) return;
  const card = player.hand.splice(i,1)[0];

  const target = targetId ? lobby.players.find(p=>p.id===targetId) : null;

  const oneShotLimit = !canMultiShot(player);

  switch(card.type){

    /* --- EQUIPMENT --- */
    case CARD.W_SAWED: case CARD.W_DOUBLE: case CARD.W_COLT: case CARD.W_TOMMY: case CARD.W_WINCH: case CARD.W_SPRING:{
      // vylož zbraň (mít lze jen jednu)
      if (player.weapon) unequipWeapon(lobby, player);
      equipWeapon(player, card);
      info(lobby, `🔧 ${player.name} vykládá zbraň: ${WEAPON_META[card.type].name} (dostřel ${WEAPON_META[card.type].range}${WEAPON_META[card.type].multi?', bez limitu výstřelů':''}).`);
      break;
    }
    case CARD.VEST:{
      if (!player.vest){
        player.vest = true;
        info(lobby, `🦺 ${player.name} obléká Neprůstřelnou vestu.`);
      } else {
        // už má vestu → kartu vrať do ruky (nebo ji povolit stack? zvolíme "jen 1")
        player.hand.push(card); return;
      }
      break;
    }

    /* --- HEALS --- */
    case CARD.WHISKEY: case CARD.CIGAR:{
      const before = player.hp; player.hp = Math.min(player.maxHp, player.hp+1);
      if (player.hp>before) info(lobby, `🥃 ${player.name} léčí +1.`);
      discard(lobby, card);
      break;
    }

    /* --- PRISON / CONTROL --- */
    case CARD.PRISON:{
      if (!target || target.dead || target.id===player.id){ player.hand.push(card); return; }
      target.inPrison = true;
      info(lobby, `🚔 ${player.name} posílá ${target.name} do vězení.`);
      discard(lobby, card);
      break;
    }
    case CARD.EXTORTION:{ // vezmi náhodně kartu nebo vybavení
      if (!target || target.dead || target.id===player.id){ player.hand.push(card); return; }
      const pool = [];
      for(const c of target.hand) pool.push({kind:"hand", card:c});
      if (target.weapon) pool.push({kind:"weapon", card:{ id:target.weapon.id, type:target.weapon.type }});
      if (target.vest) pool.push({kind:"vest", card:{ id: -1, type:CARD.VEST }});
      if (pool.length===0){ info(lobby, `💼 ${target.name} nemá co vzít.`); discard(lobby, card); break; }
      const pick = pool[rand(pool.length)];
      if (pick.kind==="hand"){
        const idx = target.hand.findIndex(c=>c.id===pick.card.id);
        const stolen = target.hand.splice(idx,1)[0];
        player.hand.push(stolen);
        info(lobby, `💰 ${player.name} (Výpalné) – bere kartu z ruky ${target.name}.`);
      } else if (pick.kind==="weapon"){
        player.hand.push({ id:pick.card.id, type:pick.card.type }); // dostane do ruky
        info(lobby, `💰 ${player.name} bere ${target.name} zbraň.`);
        target.weapon=null;
      } else {
        // vestu nelze přesunout jako kartu – prostě jí zrušíme (výpalné ji „sebere“)
        target.vest=false;
        info(lobby, `💰 ${player.name} sebral ${target.name} neprůstřelnou vestu.`);
      }
      discard(lobby, card);
      break;
    }
    case CARD.RAID:{
      if (!target || target.dead || target.id===player.id){ player.hand.push(card); return; }
      const pool = [];
      for(const c of target.hand) pool.push({kind:"hand", card:c});
      if (target.weapon) pool.push({kind:"weapon", card:{ id:target.weapon.id, type:target.weapon.type }});
      if (target.vest) pool.push({kind:"vest", card:{ id:-1, type:CARD.VEST }});
      if (pool.length===0){ info(lobby, `🔥 Razie: ${target.name} nemá co spálit.`); discard(lobby, card); break; }
      const pick = pool[rand(pool.length)];
      if (pick.kind==="hand"){
        const idx = target.hand.findIndex(c=>c.id===pick.card.id);
        const burned = target.hand.splice(idx,1)[0];
        discard(lobby, burned);
        info(lobby, `🔥 Razie: ${player.name} pálí kartu z ruky ${target.name}.`);
      } else if (pick.kind==="weapon"){
        info(lobby, `🔥 Razie: ${player.name} pálí zbraň ${target.name}.`);
        discard(lobby, { id:pick.card.id, type:pick.card.type });
        target.weapon=null;
      } else {
        info(lobby, `🔥 Razie: ${player.name} pálí vestu ${target.name}.`);
        discard(lobby, newCard(CARD.VEST));
        target.vest=false;
      }
      discard(lobby, card);
      break;
    }

    /* --- ATTACKS --- */
    case CARD.SHOT:{
      if (!target || target.dead || target.id===player.id){ player.hand.push(card); return; }
      if (!withinRange(lobby, player, target)){ player.hand.push(card); info(lobby, "❗ Cíl mimo dostřel."); return; }
      if (oneShotLimit && player._shotThisTurn>=1){ player.hand.push(card); info(lobby, "❗ Výstřel lze zahrát jen 1× za tah (mimo Tommy Gun)."); return; }

      player._shotThisTurn += 1;
      discard(lobby, card);
      info(lobby, `🔫 ${player.name} střílí na ${target.name}.`);

      // reakce – Úhyb?
      const hasDodge = target.hand.some(c=>c.type===CARD.DODGE);
      if (hasDodge){
        lobby.pending = { type:"SHOT", attackerId: player.id, defenderId: target.id };
        broadcast(lobby,"state",(viewer)=> personalizedState(lobby, viewer));
      } else {
        handleDamage(lobby, target, 1, CARD.SHOT, player);
      }
      break;
    }
    case CARD.KNIFE:{
      if (!target || target.dead || target.id===player.id){ player.hand.push(card); return; }
      const dist = distanceAlive(lobby, player, target);
      if (dist>1){ player.hand.push(card); info(lobby,"❗ Nůž: cíl musí být ve vzdálenosti 1."); return; }
      discard(lobby, card);
      info(lobby, `🔪 ${player.name} bodá ${target.name}.`);
      handleDamage(lobby, target, 1, CARD.KNIFE, player);
      break;
    }
    case CARD.MOLOTOV:{
      if (!target || target.dead || target.id===player.id){ player.hand.push(card); return; }
      const dist = distanceAlive(lobby, player, target);
      if (dist>1){ player.hand.push(card); info(lobby,"❗ Molotov: cíl musí být ve vzdálenosti 1."); return; }
      discard(lobby, card);
      info(lobby, `🍾 ${player.name} hází Molotov na ${target.name}.`);
      handleDamage(lobby, target, 1, CARD.MOLOTOV, player);
      break;
    }
    case CARD.SHOOTOUT:{ // přestřelka: všichni odhodí SHOT, jinak -1
      discard(lobby, card);
      info(lobby, `🤜🤛 ${player.name} vyvolává Přestřelku.`);
      for (const x of lobby.players){
        if (x.dead || x.id===player.id) continue;
        const idx = x.hand.findIndex(c=>c.type===CARD.SHOT);
        if (idx>=0){
          const used = x.hand.splice(idx,1)[0];
          discard(lobby, used);
          info(lobby, `🔫 ${x.name} odhazuje Výstřel (Přestřelka).`);
        } else {
          handleDamage(lobby, x, 1, CARD.SHOOTOUT, player);
        }
      }
      break;
    }
    case CARD.SPRAY:{ // všichni odhodí DODGE, jinak -1
      discard(lobby, card);
      info(lobby, `🌪️ ${player.name} spouští Tommy Gun Spray.`);
      for (const x of lobby.players){
        if (x.dead || x.id===player.id) continue;
        const idx = x.hand.findIndex(c=>c.type===CARD.DODGE);
        if (idx>=0){
          const used = x.hand.splice(idx,1)[0];
          discard(lobby, used);
          info(lobby, `🛡️ ${x.name} odhazuje Úhyb (Spray).`);
        } else {
          handleDamage(lobby, x, 1, CARD.SPRAY, player);
        }
      }
      break;
    }
    case CARD.VENDETTA:{
      if (!target || target.dead || target.id===player.id){ player.hand.push(card); return; }
      discard(lobby, card);
      info(lobby, `🗡️ Vendeta: ${player.name} vyzývá ${target.name}.`);
      // střídavé odhazování SHOT; kdo nemá, dostane 1 dmg
      let attacker = player, defender = target, loop=0;
      while(true){
        loop++; if (loop>50) break;
        const idx = defender.hand.findIndex(c=>c.type===CARD.SHOT);
        if (idx>=0){
          const used = defender.hand.splice(idx,1)[0];
          discard(lobby, used);
          info(lobby, `🃏 Vendeta: ${defender.name} odhazuje Výstřel.`);
          // swap role v souboji
          const t = attacker; attacker=defender; defender=t;
        } else {
          info(lobby, `🃏 Vendeta: ${defender.name} nemá Výstřel.`);
          handleDamage(lobby, defender, 1, CARD.VENDETTA, attacker);
          break;
        }
      }
      break;
    }

    /* --- REACTION proactive not allowed --- */
    case CARD.DODGE:{
      // nelze hrát samostatně
      player.hand.push(card); return;
    }

    default:
      // neznámé – vrať do ruky
      player.hand.push(card); return;
  }

  broadcast(lobby,"state",(viewer)=> personalizedState(lobby, viewer));
  checkWin(lobby);
}

function reaction(lobby, player, choice){
  if (!lobby.pending) return;
  const p = lobby.pending;
  if (p.type==="SHOT" && p.defenderId===player.id){
    const attacker = lobby.players.find(x=>x.id===p.attackerId);
    const defender = player;
    if (choice==="DODGE"){
      const i = defender.hand.findIndex(c=>c.type===CARD.DODGE);
      if (i>=0){
        const c = defender.hand.splice(i,1)[0];
        discard(lobby, c);
        info(lobby, `🛡️ ${defender.name} zahrál Úhyb.`);
      }
    } else {
      handleDamage(lobby, defender, 1, CARD.SHOT, attacker);
    }
    lobby.pending=null;
    broadcast(lobby,"state",(viewer)=> personalizedState(lobby, viewer));
    checkWin(lobby);
  }
}

/* ===== HTTP + WS ===== */
const app = express();
app.use(express.static("public"));
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection",(ws)=>{
  ws.on("message",(data)=>{
    let msg=null; try{ msg=JSON.parse(data.toString()); }catch{ return; }

    if (msg.type==="create"){
      const { lobby, hostPlayer } = makeLobby(ws, msg.name);
      ws.send(JSON.stringify({ type:"lobby", lobby:lobbySummary(lobby), youId: hostPlayer.id }));
    }
    else if (msg.type==="join"){
      const lobby = lobbies.get((msg.lobbyId||"").toUpperCase());
      if (!lobby) return ws.send(JSON.stringify({ type:"error", message:"Lobby neexistuje." }));
      if (lobby.players.length>=7) return ws.send(JSON.stringify({ type:"error", message:"Lobby je plná (max 7)." }));
      const player = joinLobby(lobby, ws, msg.name);
      ws.send(JSON.stringify({ type:"lobby", lobby:lobbySummary(lobby), youId: player.id }));
      broadcast(lobby,"lobby",(viewer)=>({ lobby:lobbySummary(lobby), youId: viewer.id }));
    }
    else if (msg.type==="ready"){
      const lobby = lobbies.get(ws._lobbyId); if (!lobby) return;
      const p = lobby.players.find(x=>x.id===ws._playerId); if (!p) return;
      p.ready = !!msg.ready;
      broadcast(lobby,"lobby",(viewer)=>({ lobby:lobbySummary(lobby), youId: viewer.id }));
    }
    else if (msg.type==="start"){
      const lobby = lobbies.get(ws._lobbyId); if (!lobby) return;
      if (ws._playerId !== lobby.hostId) return;
      if (lobby.players.length < 2) return;
      startGame(lobby);
    }
    else if (msg.type==="endTurn"){
      const lobby = lobbies.get(ws._lobbyId); if (!lobby) return;
      const p = lobby.players.find(x=>x.id===ws._playerId); if (!p) return;
      if (p.id !== currentPlayer(lobby).id) return;
      nextTurn(lobby);
    }
    else if (msg.type==="play"){
      const lobby = lobbies.get(ws._lobbyId); if (!lobby) return;
      const p = lobby.players.find(x=>x.id===ws._playerId); if (!p) return;
      playCard(lobby, p, msg.cardId, msg.targetId||null);
    }
    else if (msg.type==="reaction"){
      const lobby = lobbies.get(ws._lobbyId); if (!lobby) return;
      const p = lobby.players.find(x=>x.id===ws._playerId); if (!p) return;
      reaction(lobby, p, msg.choice);
    }
    else if (msg.type==="get"){
      const lobby = lobbies.get(ws._lobbyId); if (!lobby) return;
      const p = lobby.players.find(x=>x.id===ws._playerId); if (!p) return;
      ws.send(JSON.stringify({ type:"lobby", lobby:lobbySummary(lobby), youId:p.id }));
      ws.send(JSON.stringify({ type:"state", ...personalizedState(lobby, p) }));
    }
  });

  ws.on("close",()=>{
    const lobby = lobbies.get(ws._lobbyId);
    if (!lobby) return;
    const idx = lobby.players.findIndex(p=>p.id===ws._playerId);
    if (idx>=0) lobby.players.splice(idx,1);
    if (lobby.players.length===0) lobbies.delete(lobby.id);
    else broadcast(lobby,"lobby",(viewer)=>({ lobby:lobbySummary(lobby), youId: viewer.id }));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log(`✅ Server běží na http://localhost:${PORT}`));
