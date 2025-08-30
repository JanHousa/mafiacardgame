import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

/* ---------------- utils ---------------- */
const shuffle = (a) => { for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };
const id = () => Math.random().toString(36).slice(2,10);
const now = () => new Date().toISOString();

/* ---------------- constants ---------------- */
const CARD = { SHOT:"SHOT", DODGE:"DODGE", BEER:"BEER", DRAW2:"DRAW2", DRAW3:"DRAW3" };
const ROLE = { SHERIFF:"Šerif", OUTLAW:"Bandita", RENEGADE:"Odpadlík" };

/* ---------------- deck ---------------- */
let gid = 0;
const newCard = (type)=>({ id: ++gid, type });
const makeDeck = ()=>{
  const d=[];
  for(let i=0;i<24;i++) d.push(newCard(CARD.SHOT));
  for(let i=0;i<12;i++) d.push(newCard(CARD.DODGE));
  for(let i=0;i<10;i++) d.push(newCard(CARD.BEER));
  for(let i=0;i<8;i++)  d.push(newCard(CARD.DRAW2));
  for(let i=0;i<4;i++)  d.push(newCard(CARD.DRAW3));
  return shuffle(d);
};

/* ---------------- server state ---------------- */
const lobbies = new Map(); // lobbyId -> lobby

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
    _shotThisTurn: 0
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
    pending: null,
    createdAt: now()
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
    if (!p.ws || p.ws.readyState !== 1) continue;
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
      rolesRevealed: lobby.players.filter(p=>p.revealedRole).map(p=>({ id:p.id, role:p.role }))
    }
  };
}

function redactPlayer(p, viewer, isYou){
  return {
    id: p.id,
    name: p.name,
    hp: p.hp,
    maxHp: p.maxHp,
    dead: p.dead,
    roleRevealed: p.revealedRole || p.id===viewer.id,
    role: (p.revealedRole || isYou) ? p.role : null,
    hand: isYou ? p.hand : null,
    handCount: p.hand.length
  };
}

function redactPending(pending, viewer){
  if (!pending) return null;
  if (pending.type === "SHOT"){
    return {
      type: "SHOT",
      attackerId: pending.attackerId,
      defenderId: pending.defenderId,
      askYouToDodge: pending.defenderId === viewer.id
    };
  }
  return null;
}

/* ---------------- game flow ---------------- */
function startGame(lobby){
  if (lobby.started) return;
  const n = lobby.players.length;
  if (n < 2 || n > 4) return;

  lobby.started = true;
  gid = 0;
  lobby.deck = makeDeck();
  lobby.discard = [];
  lobby.pending = null;

  // role + HP
  const order = shuffle(lobby.players.slice());
  const sheriff = order[0];
  sheriff.role = ROLE.SHERIFF; sheriff.maxHp = 5; sheriff.hp = 5; sheriff.revealedRole = true;

  const rest = order.slice(1);
  if (n === 2){
    rest[0].role = ROLE.RENEGADE; rest[0].maxHp = 4; rest[0].hp = 4;
  } else {
    const roles = (n===3) ? [ROLE.OUTLAW, ROLE.RENEGADE] : [ROLE.OUTLAW, ROLE.OUTLAW, ROLE.RENEGADE];
    shuffle(roles);
    rest.forEach((p,i)=>{ p.role = roles[i]; p.maxHp = 4; p.hp = 4; p.revealedRole = false; });
  }

  // rozdej 4
  for(let i=0;i<4;i++) for(const p of lobby.players) drawCard(lobby, p, 1);

  // startuje šerif
  lobby.turnIdx = lobby.players.findIndex(p=>p.role===ROLE.SHERIFF);
  for(const p of lobby.players) p._shotThisTurn = 0;

  // hned začátek tahu (líznout 2)
  const cur = currentPlayer(lobby);
  if (cur && !cur.dead) drawCard(lobby, cur, 2);

  // pošli všem lobby + stav (včetně jejich youId)
  broadcast(lobby, "lobby", (viewer)=>({ lobby: lobbySummary(lobby), youId: viewer.id }));
  broadcast(lobby, "state", (viewer)=> personalizedState(lobby, viewer));
  info(lobby, "Hra začíná. Šerif je na tahu.");
}

function drawCard(lobby, player, n=1){
  for(let i=0;i<n;i++){
    if (lobby.deck.length===0){
      if (lobby.discard.length===0) return;
      lobby.deck = shuffle(lobby.discard.splice(0));
      info(lobby, "Balíček došel. Zamícháno odhazoviště.");
    }
    const c = lobby.deck.pop();
    player.hand.push(c);
  }
}

function discard(lobby, card){ lobby.discard.push(card); }
function info(lobby, message){ broadcast(lobby, "info", ()=>({ message, at: now() })); }
function currentPlayer(lobby){ return lobby.players[lobby.turnIdx]; }

function nextTurn(lobby){
  // reset per-turn flags
  for(const pl of lobby.players) pl._shotThisTurn = 0;

  // najdi dalšího živého
  let idx = lobby.turnIdx;
  do { idx = (idx + 1) % lobby.players.length; } while(lobby.players[idx].dead && idx !== lobby.turnIdx);
  lobby.turnIdx = idx;

  const p = currentPlayer(lobby);
  if (!p.dead) drawCard(lobby, p, 2);

  broadcast(lobby, "state", (viewer)=> personalizedState(lobby, viewer));
  info(lobby, `Na tahu: ${p.name}`);
}

/* ---------------- actions ---------------- */
function playCard(lobby, player, cardId, targetId=null){
  if (!lobby.started) return;
  const cur = currentPlayer(lobby);
  if (!cur || player.id !== cur.id) return; // ne můj tah
  if (lobby.pending) return;

  const i = player.hand.findIndex(c=>c.id===cardId);
  if (i<0) return;
  const card = player.hand.splice(i,1)[0];

  switch(card.type){
    case CARD.DRAW2:
      drawCard(lobby, player, 2); discard(lobby, card); info(lobby, `${player.name} hraje ➕2.`); break;
    case CARD.DRAW3:
      drawCard(lobby, player, 3); discard(lobby, card); info(lobby, `${player.name} hraje ➕3.`); break;
    case CARD.BEER: {
      const before = player.hp; player.hp = Math.min(player.maxHp, player.hp+1);
      if (player.hp>before) info(lobby, `${player.name} pije 🍺 Pivo (+1).`);
      discard(lobby, card); break;
    }
    case CARD.SHOT: {
      if (!targetId){ player.hand.push(card); return; }
      const target = lobby.players.find(p=>p.id===targetId);
      if (!target || target.dead || target.id===player.id){ player.hand.push(card); return; }
      if (player._shotThisTurn >= 1){ player.hand.push(card); return; }
      player._shotThisTurn += 1;

      discard(lobby, card);
      info(lobby, `${player.name} hraje 🔫 Výstřel na ${target.name}.`);

      const hasDodge = target.hand.some(c=>c.type===CARD.DODGE);
      if (hasDodge){
        lobby.pending = { type:"SHOT", attackerId: player.id, defenderId: target.id };
        broadcast(lobby, "state", (viewer)=> personalizedState(lobby, viewer));
      } else {
        damage(lobby, target, 1, player);
      }
      break;
    }
    case CARD.DODGE:
      player.hand.push(card); return;
    default:
      player.hand.push(card); return;
  }

  broadcast(lobby, "state", (viewer)=> personalizedState(lobby, viewer));
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
      if (i>=0){ const c = defender.hand.splice(i,1)[0]; discard(lobby, c); info(lobby, `${defender.name} zahrál 🛡️ Úhyb.`); }
    } else {
      damage(lobby, defender, 1, attacker);
    }
    lobby.pending = null;
    broadcast(lobby, "state", (viewer)=> personalizedState(lobby, viewer));
    checkWin(lobby);
  }
}

function damage(lobby, target, n, from=null){
  if (target.dead) return;
  target.hp -= n;
  if (target.hp<=0){ target.hp=0; kill(lobby, target, from); }
  else { info(lobby, `${target.name} utržil ${n} zranění${from?` (od ${from.name})`:''}.`); }
}
function kill(lobby, p, from=null){
  p.dead = true; p.revealedRole = true;
  while(p.hand.length) discard(lobby, p.hand.pop());
  info(lobby, `${p.name} padl. (${p.role})`);
}

function checkWin(lobby){
  if (!lobby.started) return false;
  const alive = lobby.players.filter(p=>!p.dead);
  const sheriff = lobby.players.find(p=>p.role===ROLE.SHERIFF);
  const sheriffAlive = sheriff && !sheriff.dead;
  const othersAlive = lobby.players.filter(p=>!p.dead && p.id!==sheriff?.id);

  if (!sheriffAlive){
    if (alive.length===1 && alive[0].role===ROLE.RENEGADE) info(lobby, "🃏 Odpadlík vítězí jako poslední přeživší!");
    else info(lobby, "💀 Vyhráli Bandité. Šerif padl.");
    lobby.started=false; return true;
  }
  if (othersAlive.length===0){ info(lobby, "🏆 Vítězství Šerifa! Město je v bezpečí."); lobby.started=false; return true; }
  return false;
}

/* ---------------- HTTP + WS ---------------- */
const app = express();
app.use(express.static("public"));
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws)=>{
  ws.on("message", (data)=>{
    let msg=null; try{ msg=JSON.parse(data.toString()); }catch{ return; }

    if (msg.type==="create"){
      const { lobby, hostPlayer } = makeLobby(ws, msg.name);
      ws.send(JSON.stringify({ type:"lobby", lobby:lobbySummary(lobby), youId: hostPlayer.id }));
    }
    else if (msg.type==="join"){
      const lobby = lobbies.get((msg.lobbyId||"").toUpperCase());
      if (!lobby) return ws.send(JSON.stringify({ type:"error", message:"Lobby neexistuje." }));
      if (lobby.players.length>=4) return ws.send(JSON.stringify({ type:"error", message:"Lobby je plná." }));
      const player = joinLobby(lobby, ws, msg.name);
      // nováčkovi jeho youId
      ws.send(JSON.stringify({ type:"lobby", lobby:lobbySummary(lobby), youId: player.id }));
      // a ostatním update (každému s jeho youId)
      broadcast(lobby, "lobby", (viewer)=>({ lobby: lobbySummary(lobby), youId: viewer.id }));
    }
    else if (msg.type==="ready"){
      const lobby = lobbies.get(ws._lobbyId); if (!lobby) return;
      const p = lobby.players.find(x=>x.id===ws._playerId); if (!p) return;
      p.ready = !!msg.ready;
      broadcast(lobby, "lobby", (viewer)=>({ lobby: lobbySummary(lobby), youId: viewer.id }));
    }
    else if (msg.type==="start"){
      const lobby = lobbies.get(ws._lobbyId); if (!lobby) return;
      if (ws._playerId !== lobby.hostId) return;
      if (lobby.players.length < 2) return;
      startGame(lobby); // pošle lobby+state všem
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

  ws.on("close", ()=>{
    const lobby = lobbies.get(ws._lobbyId);
    if (!lobby) return;
    const idx = lobby.players.findIndex(p=>p.id===ws._playerId);
    if (idx>=0) lobby.players.splice(idx,1);
    if (lobby.players.length===0) lobbies.delete(lobby.id);
    else broadcast(lobby, "lobby", (viewer)=>({ lobby: lobbySummary(lobby), youId: viewer.id }));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log(`✅ Server běží na http://localhost:${PORT}`));
