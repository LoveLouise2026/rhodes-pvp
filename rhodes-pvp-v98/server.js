const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");

function readJsonFile(fileName) {
  return JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, fileName), "utf8")
  );
}

function loadCardData() {
  const mainCards = readJsonFile("cards.json");
  const baseCards = readJsonFile("base-cards.json");
  const versionInfo = readJsonFile("card-pool-version.json");
  const starterDecks = readJsonFile("starter-decks.json");
  require("./public/starter-decks").validate(starterDecks, mainCards, baseCards);
  const ids = new Set();

  for (const card of [...mainCards, ...baseCards]) {
    if (!card || !card.id || !card.name || !card.type) {
      throw new Error("卡牌数据缺少 id/name/type");
    }

    if (ids.has(card.id)) {
      throw new Error(`重复卡牌ID: ${card.id}`);
    }

    ids.add(card.id);
  }

  return {
    version: versionInfo.version,
    mainCards,
    baseCards,
    starterDecks
  };
}

function reloadCardData() {
  return CARD_DATA;
}

// Pin the card pool for the lifetime of this process and validate before listening.
const CARD_DATA = loadCardData();
const rules = require("./engine/rules")(CARD_DATA.mainCards, CARD_DATA.baseCards);

const clients = new Map();
const rooms = new Map();
const games = new Map();

const PVP_VERSION = "v98";

function reconnectToken() {
  return crypto.randomBytes(24).toString("hex");
}

function bumpRevision(game, action) {
  game.revision = Number(game.revision || 0) + 1;
  if (action) {
    const event = { ...action, eventId: `${game.id}:${game.revision}`, revision: game.revision };
    game.lastAction = event;
    game.events = Array.isArray(game.events) ? game.events : [];
    game.events.push(event);
    if (game.events.length > 24) game.events.splice(0, game.events.length - 24);
  }
  return game.revision;
}

function randomId() {
  return crypto.randomBytes(8).toString("hex");
}

function randomRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = "";
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("无法生成唯一房间号");
}

function cleanName(value) {
  const name = String(value || "guest").trim().slice(0, 24);
  return name || "guest";
}

function cleanDeckName(value) {
  return String(value || "未选择卡组").trim().slice(0, 40) || "未选择卡组";
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    createdAt: room.createdAt,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      ready: Boolean(p.ready),
      deckName: p.deckName || "未选择卡组",
      deckValid: Boolean(p.deckValid),
      deckError: p.deckError || ""
    }))
  };
}

function send(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function broadcastRoom(room) {
  const payload = {
    type: "room_update",
    room: publicRoom(room)
  };

  for (const player of room.players) {
    const ws = player.ws;
    send(ws, {
      ...payload,
      selfId: player.id
    });
  }
}

function getClient(ws) {
  return clients.get(ws) || null;
}

function getRoomForClient(client) {
  if (!client || !client.roomCode) return null;
  return rooms.get(client.roomCode) || null;
}

function removeClientFromRoom(client, reason = "leave") {
  if (!client || !client.roomCode) return;

  const room = rooms.get(client.roomCode);
  client.roomCode = "";

  if (!room) return;

  if (room.startTimer) { clearTimeout(room.startTimer); room.startTimer = null; }
  room.rps = null;

  const index = room.players.findIndex((p) => p.id === client.id);
  if (index >= 0) {
    room.players.splice(index, 1);
  }

  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === client.id) {
    room.hostId = room.players[0].id;
  }

  broadcastRoom(room);
}

function requireRoom(ws) {
  const client = getClient(ws);
  const room = getRoomForClient(client);

  if (!client || !room) {
    send(ws, {
      type: "error",
      message: "你当前不在任何房间中。"
    });
    return null;
  }

  return { client, room };
}

function createRoom(ws, message) {
  const client = getClient(ws);
  if (!client) return;

  removeClientFromRoom(client);

  const code = randomRoomCode();
  const room = {
    code,
    hostId: client.id,
    createdAt: Date.now(),
    players: []
  };

  const initialDeck = validateDeckPayload(message.deck);
  const player = {
    id: client.id,
    ws,
    name: client.name,
    ready: false,
    deckName: cleanDeckName(message.deckName),
    deckPayload: initialDeck.ok ? initialDeck.normalized : null,
    deckValid: initialDeck.ok,
    deckError: initialDeck.ok ? "" : initialDeck.errors.join("；")
  };

  room.players.push(player);
  rooms.set(code, room);
  client.roomCode = code;

  send(ws, {
    type: "room_joined",
    room: publicRoom(room),
    selfId: client.id
  });

  broadcastRoom(room);
}

function joinRoom(ws, message) {
  const client = getClient(ws);
  if (!client) return;

  const code = String(message.code || "").trim().toUpperCase();
  const room = rooms.get(code);

  if (!room) {
    send(ws, {
      type: "error",
      message: "房间不存在，或房间已经关闭。"
    });
    return;
  }

  if (room.players.length >= 2) {
    send(ws, {
      type: "error",
      message: "房间已经满员。"
    });
    return;
  }

  if (room.players.some((p) => p.id === client.id)) {
    send(ws, {
      type: "room_joined",
      room: publicRoom(room),
      selfId: client.id
    });
    return;
  }

  removeClientFromRoom(client);

  const initialDeck = validateDeckPayload(message.deck);
  room.players.push({
    id: client.id,
    ws,
    name: client.name,
    ready: false,
    deckName: cleanDeckName(message.deckName),
    deckPayload: initialDeck.ok ? initialDeck.normalized : null,
    deckValid: initialDeck.ok,
    deckError: initialDeck.ok ? "" : initialDeck.errors.join("；")
  });

  client.roomCode = code;

  send(ws, {
    type: "room_joined",
    room: publicRoom(room),
    selfId: client.id
  });

  broadcastRoom(room);
}

function setReady(ws, message) {
  const ctx = requireRoom(ws);
  if (!ctx) return;
  if (ctx.room.rps) return send(ws, { type: "error", message: "猜拳期间不能更改准备状态。" });

  const player = ctx.room.players.find((p) => p.id === ctx.client.id);
  if (!player) return;

  if (Boolean(message.ready) && !player.deckValid) {
    send(ws, {
      type: "error",
      message: "当前卡组未通过服务器验证：" + (player.deckError || "请重新选择合法卡组")
    });
    return;
  }

  player.ready = Boolean(message.ready);
  broadcastRoom(ctx.room);
}

function validateDeckPayload(payload) {
  const data = reloadCardData();
  const mainById = new Map(data.mainCards.map((card) => [String(card.id), card]));
  const baseById = new Map(data.baseCards.map((card) => [String(card.id), card]));
  const main = payload && Array.isArray(payload.main) ? payload.main.map(String) : [];
  const base = payload && Array.isArray(payload.base) ? payload.base.map(String) : [];
  const errors = [];

  if (main.length !== 50) errors.push(`主卡组必须正好50张（当前${main.length}张）`);
  if (base.length !== 3) errors.push(`基地卡组必须正好3张（当前${base.length}张）`);

  const counts = new Map();
  for (const id of main) {
    if (!mainById.has(id)) {
      errors.push(`主卡组包含服务器无法识别的卡牌：${id}`);
      continue;
    }
    if (mainById.get(id).onlineStatus === 'pending') errors.push(`卡牌 ${id} 的效果待接入，暂不能用于联机。`);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  for (const [id, count] of counts) {
    if (count > 4) errors.push(`卡牌 ${id} 超过4张上限（当前${count}张）`);
  }

  const levelCounts = new Map([[1,0],[2,0],[3,0]]);
  for (const id of base) {
    const card = baseById.get(id);
    if (!card) {
      errors.push(`基地卡组包含服务器无法识别的卡牌：${id}`);
      continue;
    }
    if (card.onlineStatus === 'pending') errors.push(`基地 ${id} 的效果待接入，暂不能用于联机。`);
    const level = Number(card.level);
    if (levelCounts.has(level)) levelCounts.set(level, levelCounts.get(level) + 1);
  }
  for (const level of [1,2,3]) {
    if (levelCounts.get(level) !== 1) errors.push(`Lv.${level}势力卡必须正好1张`);
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized: { main, base },
    cardPoolVersion: data.version
  };
}

function setDeck(ws, message) {
  const ctx = requireRoom(ws);
  if (!ctx) return;
  if (ctx.room.rps) return send(ws, { type: "error", message: "猜拳期间不能更改卡组。" });

  const player = ctx.room.players.find((p) => p.id === ctx.client.id);
  if (!player) return;

  player.deckName = cleanDeckName(message.deckName);
  const result = validateDeckPayload(message.deck);
  player.deckPayload = result.ok ? result.normalized : null;
  player.deckValid = result.ok;
  player.deckError = result.ok ? "" : result.errors.join("；");

  // 切换/重新上传卡组后必须重新准备。
  player.ready = false;
  broadcastRoom(ctx.room);

  send(ws, {
    type: "deck_validation",
    ok: result.ok,
    errors: result.errors,
    cardPoolVersion: result.cardPoolVersion
  });
}

function secureShuffle(list) {
  const next = list.slice();
  for (let i = next.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function cardPoolMapsV93() {
  const data = reloadCardData();
  return {
    data,
    mainById: new Map(data.mainCards.map((card) => [String(card.id), card])),
    baseById: new Map(data.baseCards.map((card) => [String(card.id), card]))
  };
}

function sortBaseIdsV93(ids) {
  const { baseById } = cardPoolMapsV93();
  return ids.slice().sort((a, b) => {
    const ca = baseById.get(String(a));
    const cb = baseById.get(String(b));
    return Number(ca && ca.level || 0) - Number(cb && cb.level || 0);
  });
}

function createAuthoritativeGame(room, firstPlayerId) {
  const gameId = randomId();
  const playerIds = room.players.map((p) => p.id);
  const secondPlayerId = playerIds.find((id) => id !== firstPlayerId);
  const game = {
    id: gameId,
    roomCode: room.code,
    createdAt: Date.now(),
    revision: 0,
    phase: "mulligan",
    round: 1,
    firstPlayerId,
    secondPlayerId,
    currentPlayerId: firstPlayerId,
    playsThisTurn: 0,
    turnSequence: 0,
    startedTurns: {},
    lastAction: null,
    events: [],
    players: room.players.map((p) => {
      const shuffled = secureShuffle(p.deckPayload.main);
      return {
        id: p.id,
        ws: p.ws,
        reconnectToken: reconnectToken(),
        name: p.name,
        deckName: p.deckName,
        deck: shuffled.slice(5),
        hand: shuffled.slice(0, 5),
        baseDeck: sortBaseIdsV93(p.deckPayload.base),
        baseStack: [],
        activeBase: null,
        baseLife: [],
        grave: [],
        field: Array(8).fill(null),
        fieldEnteredTurn: Array(8).fill(-1),
        fieldAttackedTurn: Array(8).fill(-1),
        mulliganDone: false
      };
    })
  };
  games.set(gameId, game);
  room.activeGameId = gameId;

  for (const player of room.players) {
    const self = game.players.find((p) => p.id === player.id);
    const opponent = game.players.find((p) => p.id !== player.id);
    send(player.ws, {
      type: "game_start",
      gameId,
      roomCode: room.code,
      serverAuthoritativeOpening: true,
      serverBattleSync: "v98",
      firstPlayerMethod: "rock-paper-scissors",
      firstPlayerId: game.firstPlayerId,
      youAreFirst: player.id === game.firstPlayerId,
      self: {
        id: self.id, name: self.name, deckName: self.deckName, reconnectToken: self.reconnectToken,
        hand: self.hand.slice(), deckCount: self.deck.length,
        base: self.baseDeck.slice(), graveCount: 0
      },
      opponent: {
        id: opponent.id, name: opponent.name, deckName: opponent.deckName,
        handCount: opponent.hand.length, deckCount: opponent.deck.length,
        baseCount: opponent.baseDeck.length, graveCount: 0
      },
      players: room.players.map((p) => ({ id:p.id, name:p.name, deckName:p.deckName }))
    });
  }

  room.rps = null;
  console.log(`v94 game ${gameId}: room=${room.code}, first=${game.firstPlayerId}`);
}

function getGamePlayerV94(game, playerId) {
  return game && game.players.find((p) => p.id === playerId) || null;
}

function getBaseCardV94(id) {
  if (!id) return null;
  const { baseById } = cardPoolMapsV93();
  return baseById.get(String(id)) || null;
}

function currentBaseLevelV94(player) {
  const card = getBaseCardV94(player && player.activeBase);
  return Math.max(0, Number(card && card.level || 0));
}

function gameStateForV94(game, recipientId) {
  const self = getGamePlayerV94(game, recipientId);
  const opponent = game.players.find((p) => p.id !== recipientId);
  if (!self || !opponent) return null;
  return {
    type: "game_state",
    version: PVP_VERSION,
    gameId: game.id,
    revision: game.revision,
    phase: game.phase,
    round: game.round,
    firstPlayerId: game.firstPlayerId,
    secondPlayerId: game.secondPlayerId,
    currentPlayerId: game.currentPlayerId,
    isYourTurn: game.currentPlayerId === recipientId,
    ended: Boolean(game.ended || game.phase==="ended"),
    winnerId: game.winnerId || null,
    loserId: game.loserId || null,
    endReason: game.endReason || "",
    playsThisTurn: game.playsThisTurn,
    playLimit: currentBaseLevelV94(getGamePlayerV94(game, game.currentPlayerId)),
    startedTurns: Number(game.startedTurns[recipientId] || 0),
    self: {
      id: self.id,
      name: self.name,
      hand: self.hand.slice(),
      deckCount: self.deck.length,
      baseDeckCount: self.baseDeck.length,
      baseDeck: self.baseDeck.slice(),
      baseStack: self.baseStack.slice(),
      activeBase: self.activeBase,
      baseLifeCount: self.baseLife.length,
      graveCount: self.grave.length,
      field: self.field.slice(),
      fieldEnteredTurn: self.fieldEnteredTurn.slice(),
      fieldAttackedTurn: self.fieldAttackedTurn.slice(),
      grave: self.grave.slice(),
      mulliganDone: self.mulliganDone
    },
    opponent: {
      id: opponent.id,
      name: opponent.name,
      handCount: opponent.hand.length,
      deckCount: opponent.deck.length,
      baseDeckCount: opponent.baseDeck.length,
      baseStack: opponent.baseStack.slice(),
      activeBase: opponent.activeBase,
      baseLifeCount: opponent.baseLife.length,
      graveCount: opponent.grave.length,
      grave: opponent.grave.slice(),
      field: opponent.field.slice(),
      fieldEnteredTurn: opponent.fieldEnteredTurn.slice(),
      fieldAttackedTurn: opponent.fieldAttackedTurn.slice(),
      mulliganDone: opponent.mulliganDone
    },
    rulesVersion: "effects-v1",
    rules: rules.view(game, recipientId),
    lastAction: eventForPlayer(game.lastAction, recipientId),
    events: (game.events || []).slice(-8).map((event) => eventForPlayer(event, recipientId))
  };
}

function eventForPlayer(event, recipientId) {
  if (!event) return null;
  const visible = { ...event };
  if (event.type === "mulligan" && event.by !== recipientId) {
    delete visible.returnedCardIds;
    delete visible.replacementHand;
  }
  return visible;
}

function sendGameStateV94(game) {
  for (const p of game.players) {
    if (!p.ws) continue;
    const payload = gameStateForV94(game, p.id);
    if (payload) send(p.ws, payload);
  }
}

function pvpErrorV94(ws, message) {
  send(ws, { type: "pvp_error", version:PVP_VERSION, message: String(message || "联机操作失败。") });
}

function resumeGameV94(ws, message) {
  const client = getClient(ws);
  if (!client) return;
  const game = games.get(String(message.gameId || ""));
  if (!game) return pvpErrorV94(ws, "服务器中找不到这场对局，可能服务器已经重启。请重新创建房间。");
  const playerId = String(message.playerId || "");
  const token = String(message.reconnectToken || "");
  const player = getGamePlayerV94(game, playerId);
  if (!player || !token || token !== player.reconnectToken) {
    return pvpErrorV94(ws, "无法恢复对局身份：重连凭证无效。");
  }
  if (player.ws && player.ws !== ws) {
    const oldClient = getClient(player.ws);
    if (oldClient) { oldClient.gameId = ""; oldClient.gamePlayerId = ""; }
    try { send(player.ws,{type:"session_replaced",message:"你的对局已在新连接恢复。"}); } catch {}
  }
  player.ws = ws;
  player.disconnectedAt = null;
  client.gameId = game.id;
  client.gamePlayerId = player.id;
  game.lastActivityAt = Date.now();
  send(ws, { type: "game_resumed", version:PVP_VERSION, gameId: game.id, playerId: player.id });
  const state = gameStateForV94(game, player.id);
  if (state) send(ws, state);
}

function requireGameV94(ws, message) {
  const client = getClient(ws);
  if (!client || !client.gameId || !client.gamePlayerId) {
    pvpErrorV94(ws, "当前连接尚未绑定服务器对局身份。请重新进入或恢复对局。");
    return null;
  }
  const game = games.get(String(client.gameId));
  const player = getGamePlayerV94(game, String(client.gamePlayerId));
  if (!game || !player || player.ws !== ws) {
    pvpErrorV94(ws, "联机身份已失效，请刷新页面重新连接。");
    return null;
  }
  if (message && message.gameId && String(message.gameId) !== game.id) {
    pvpErrorV94(ws, "对局编号不一致。");
    return null;
  }
  game.lastActivityAt = Date.now();
  return { client, game, player };
}

function drawFromDeckV94(player, count) {
  let drawn = 0;
  for (let i = 0; i < count && player.deck.length > 0; i++) {
    player.hand.push(player.deck.shift());
    drawn++;
  }
  return drawn;
}

function beginTurnV94(game, playerId) {
  return rules.beginTurn(game, playerId);
}

function finishMulligansIfReadyV94(game) {
  if (!game.players.every((p) => p.mulliganDone)) return false;
  for (const p of game.players) {
    p.baseLife = p.deck.splice(0, Math.min(5, p.deck.length));
  }
  const turnStart = beginTurnV94(game, game.firstPlayerId);
  bumpRevision(game, {
    type:"battle_begin",
    by:null,
    currentPlayerId:game.currentPlayerId,
    turnStart,
    at:Date.now()
  });
  sendGameStateV94(game);
  return true;
}

function submitMulliganV94(ws, message) {
  const ctx = requireGameV94(ws, message);
  if (!ctx) return;
  const { game, player } = ctx;
  if (game.phase !== "mulligan") {
    pvpErrorV94(ws, "调度阶段已经结束。");
    return;
  }
  if (player.mulliganDone) {
    pvpErrorV94(ws, "你已经确认过调度了。");
    return;
  }
  const requested = Array.isArray(message.cardIds) ? message.cardIds.map(String) : [];
  if (requested.length > player.hand.length) {
    pvpErrorV94(ws, "调度数量不合法。");
    return;
  }
  const handCopy = player.hand.slice();
  const returned = [];
  for (const id of requested) {
    const index = handCopy.indexOf(id);
    if (index < 0) {
      pvpErrorV94(ws, `调度失败：手牌中找不到 ${id}`);
      return;
    }
    returned.push(handCopy.splice(index, 1)[0]);
  }
  player.hand = handCopy;
  for (const id of returned) player.deck.push(id);
  drawFromDeckV94(player, returned.length);
  player.mulliganDone = true;
  bumpRevision(game, { type:"mulligan", by:player.id, count:returned.length, returnedCardIds: returned.slice(), replacementHand: player.hand.slice(), at:Date.now() });
  sendGameStateV94(game);
  finishMulligansIfReadyV94(game);
}

function rulesAction(ws, message) {
  const ctx = requireGameV94(ws, message);
  if (!ctx) return;
  try {
    if (message.expectedRevision !== undefined && message.expectedRevision !== ctx.game.revision) {
      send(ws, gameStateForV94(ctx.game, ctx.player.id));
      return pvpErrorV94(ws, "状态已更新，请根据最新状态重新操作。");
    }
    const action = rules.execute(ctx.game, ctx.player.id, String(message.action || ""), message);
    bumpRevision(ctx.game, action || { type: "effect_step", by: ctx.player.id });
    sendGameStateV94(ctx.game);
  } catch (error) {
    if (!(error instanceof rules.RuleError)) console.error("Rules failure:", error);
    pvpErrorV94(ws, error instanceof rules.RuleError ? error.message : "效果处理失败，状态未更改。");
  }
}
function deployOperatorV94(ws, message) { rulesAction(ws, { ...message, action: "deploy_operator" }); }
function attackOperatorV96(ws, message) { rulesAction(ws, { ...message, action: "attack_operator" }); }
function attackPlayerV96(ws, message) { rulesAction(ws, { ...message, action: "attack_player" }); }

function surrenderV97(ws, message) {
  const ctx = requireGameV94(ws, message);
  if (!ctx) return;
  const { game, player } = ctx;

  if (game.ended || game.phase === "ended") {
    return pvpErrorV94(ws, "本局已经结束。");
  }

  const opponent = game.players.find((p) => p.id !== player.id);
  if (!opponent) {
    return pvpErrorV94(ws, "无法找到对手，暂时不能结算投降。");
  }

  game.queue = []; game.pendingChoice = null; game.attackContext = null;
  game.ended = true;
  game.phase = "ended";
  game.winnerId = opponent.id;
  game.loserId = player.id;
  game.endReason = `${player.name}选择投降，服务器判定${opponent.name}获胜。`;
  bumpRevision(game, {
    type:"surrender",
    by:player.id,
    winnerId:opponent.id,
    loserId:player.id,
    at:Date.now()
  });

  sendGameStateV94(game);
  console.log(`v98 surrender: game=${game.id}, loser=${player.name}, winner=${opponent.name}`);
}

function gameActionV94(ws, message) {
  if (message.action === "surrender") return surrenderV97(ws, message);
  return rulesAction(ws, message);
}

function startGame(ws) {
  const ctx = requireRoom(ws);
  if (!ctx) return;
  const { client, room } = ctx;

  const activeGame = room.activeGameId && games.get(room.activeGameId);
  if (room.rps || room.startTimer || (activeGame && !activeGame.ended)) {
    return send(ws, { type: "error", message: "房间已在猜拳或对战中。" });
  }

  if (room.hostId !== client.id) {
    send(ws, { type: "error", message: "只有房主可以开始对战。" });
    return;
  }
  if (room.players.length !== 2) {
    send(ws, { type: "error", message: "需要两名玩家都在房间内。" });
    return;
  }
  if (!room.players.every((p) => p.ready)) {
    send(ws, { type: "error", message: "双方都准备后才能开始。" });
    return;
  }
  if (!room.players.every((p) => p.deckValid && p.deckPayload)) {
    send(ws, { type: "error", message: "双方卡组都必须先通过服务器验证。请重新选择卡组后准备。" });
    return;
  }

  if (room.startTimer) { clearTimeout(room.startTimer); room.startTimer=null; }
  room.rps = { round: 1, choices: new Map(), locked:false };
  for (const p of room.players) {
    send(p.ws, { type:"rps_start", round:1, message:"请选择石头、剪刀或布决定先攻。" });
  }
}

function submitRps(ws, message) {
  const ctx = requireRoom(ws); if (!ctx) return;
  const { client, room } = ctx;
  if (!room.rps || room.rps.locked) return send(ws,{type:"error",message:"当前猜拳已经结算或未开始。"});
  const choice=String(message.choice || "");
  if (!["rock","paper","scissors"].includes(choice)) return send(ws,{type:"error",message:"无效的猜拳选择。"});
  if (room.rps.choices.has(client.id)) return send(ws,{type:"rps_wait",round:room.rps.round});
  room.rps.choices.set(client.id,choice); send(ws,{type:"rps_wait",round:room.rps.round});
  if (room.rps.choices.size < 2) return;
  const [a,b]=room.players; if (!a || !b) return;
  const ca=room.rps.choices.get(a.id), cb=room.rps.choices.get(b.id);
  const beats={rock:"scissors",scissors:"paper",paper:"rock"};
  if (ca===cb) {
    const round=room.rps.round; room.rps.locked=true;
    for (const p of room.players) send(p.ws,{type:"rps_result",tie:true,round,choices:{[a.id]:ca,[b.id]:cb}});
    room.startTimer=setTimeout(()=>{
      if (!rooms.has(room.code) || room.players.length!==2) return;
      room.rps={round:round+1,choices:new Map(),locked:false}; room.startTimer=null;
      for (const p of room.players) send(p.ws,{type:"rps_start",round:room.rps.round,message:"平局，请重新猜拳。"});
    },650); return;
  }
  const winnerId=beats[ca]===cb ? a.id : b.id; room.rps.locked=true;
  for (const p of room.players) send(p.ws,{type:"rps_result",tie:false,round:room.rps.round,winnerId,choices:{[a.id]:ca,[b.id]:cb}});
  room.startTimer=setTimeout(()=>{
    if (!rooms.has(room.code) || room.players.length!==2 || !room.rps || !room.rps.locked) return;
    room.startTimer=null; createAuthoritativeGame(room,winnerId);
  },700);
}


function handleMessage(ws, raw) {
  let message;

  try {
    message = JSON.parse(raw.toString());
  } catch {
    send(ws, {
      type: "error",
      message: "收到无法解析的消息。"
    });
    return;
  }

  const client = getClient(ws);
  if (!client) return;

  if (!message || typeof message !== "object" || Array.isArray(message) ||
      typeof message.type !== "string") {
    return send(ws, { type: "error", message: "消息必须是包含 type 的对象。" });
  }

  switch (message.type) {
    case "hello":
      client.name = cleanName(message.name);
      send(ws, {
        type: "welcome",
        clientId: client.id,
        name: client.name
      });
      break;

    case "create_room":
      createRoom(ws, message);
      break;

    case "join_room":
      joinRoom(ws, message);
      break;

    case "leave_room":
      removeClientFromRoom(client);
      send(ws, { type: "room_left" });
      break;

    case "set_ready":
      setReady(ws, message);
      break;

    case "set_deck":
      setDeck(ws, message);
      break;

    case "start_game":
      startGame(ws);
      break;

    case "rps_choice":
      submitRps(ws, message);
      break;

    case "resume_game":
      resumeGameV94(ws, message);
      break;

    case "mulligan_submit":
      submitMulliganV94(ws, message);
      break;

    case "game_action":
      gameActionV94(ws, message);
      break;

    case "ping":
      send(ws, {
        type: "pong",
        now: Date.now()
      });
      break;

    default:
      send(ws, {
        type: "error",
        message: "未知消息类型。"
      });
  }
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml"
  }[ext] || "application/octet-stream";
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === "/data/card-data.js") {
      const data = reloadCardData();

      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store"
      });

      res.end(
        "window.rhodesCardDataV87 = " +
        JSON.stringify(data) +
        ";"
      );
      return;
    }

    if (
      pathname === "/data/cards.json" ||
      pathname === "/data/base-cards.json" ||
      pathname === "/data/card-pool-version.json" ||
      pathname === "/data/starter-decks.json"
    ) {
      const requestedData =
        path.join(DATA_DIR, path.basename(pathname));

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });

      fs.createReadStream(requestedData).pipe(res);
      return;
    }

    if (pathname === "/health") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8"
      });
      res.end(JSON.stringify({
        ok: true,
        rooms: rooms.size,
        clients: clients.size,
        games: games.size,
        version: PVP_VERSION
      }));
      return;
    }

    if (pathname === "/") {
      pathname = "/card-game.html";
    }

    const requested = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!requested.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.stat(requested, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8"
        });
        res.end("Not Found");
        return;
      }

      res.writeHead(200, {
        "Content-Type": mimeType(requested),
        "Cache-Control": "no-store"
      });

      fs.createReadStream(requested).pipe(res);
    });
  } catch (error) {
    res.writeHead(500, {
      "Content-Type": "text/plain; charset=utf-8"
    });
    res.end("Internal Server Error");
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  if (clients.size >= 100) {
    ws.close(1013, "Server full");
    return;
  }
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  const client = {
    id: randomId(),
    name: "guest",
    roomCode: ""
  };

  clients.set(ws, client);

  send(ws, {
    type: "welcome",
    clientId: client.id,
    name: client.name
  });

  let windowStarted = Date.now();
  let messageCount = 0;
  ws.on("message", (raw, isBinary) => {
    if (Date.now() - windowStarted >= 10000) { windowStarted = Date.now(); messageCount = 0; }
    if (++messageCount > 80 || isBinary) {
      ws.close(1008, "Invalid traffic");
      return;
    }
    try {
      handleMessage(ws, raw);
    } catch (error) {
      console.error("WebSocket request failed:", error);
      send(ws, { type: "error", message: "操作无法处理，请刷新对局状态后重试。" });
    }
  });

  ws.on("close", () => {
    const game = games.get(client.gameId);
    const player = getGamePlayerV94(game, client.gamePlayerId);
    if (player && player.ws === ws) {
      player.ws = null;
      player.disconnectedAt = Date.now();
    }
    removeClientFromRoom(client, "disconnect");
    clients.delete(ws);
  });

  ws.on("error", () => {
    // close 事件负责清理房间
  });
});

function cleanupGames(now = Date.now()) {
  for (const [id, game] of games) {
    const inactive = now - Number(game.lastActivityAt || game.createdAt || now);
    const disconnected = game.players.every((p) => !p.ws || p.ws.readyState !== WebSocket.OPEN);
    const retention = game.ended || disconnected ? 15 * 60 * 1000 : 6 * 60 * 60 * 1000;
    if (inactive < retention) continue;
    games.delete(id);
    for (const p of game.players) {
      const client = p.ws && getClient(p.ws);
      if (client && client.gameId === id) {
        client.gameId = ""; client.gamePlayerId = "";
        send(p.ws, { type: "pvp_error", message: "对局已过期，请返回大厅重新开局。" });
      }
    }
  }
}

const maintenance = setInterval(() => {
  cleanupGames();
  for (const ws of clients.keys()) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
maintenance.unref();

function shutdown() {
  clearInterval(maintenance);
  for (const ws of clients.keys()) ws.close(1001, "Server restarting");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, HOST, () => {
  console.log(`NTCG listening on ${server.address().port}`);
  console.log("");
  console.log("Rhodes PVP v98 server started");
  console.log(`Local:   http://localhost:${PORT}`);
  console.log(`Health:  http://localhost:${PORT}/health`);
  console.log("");
  console.log("局域网测试：用本机局域网IP替换 localhost。");
  console.log("跨公网测试：把本服务部署到公网服务器/Render/Railway/Fly.io 等平台。");
  console.log("");
});
