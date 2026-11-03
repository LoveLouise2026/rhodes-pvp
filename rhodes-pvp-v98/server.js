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
    baseCards
  };
}

function reloadCardData() {
  return loadCardData();
}

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
      field: opponent.field.slice(),
      fieldEnteredTurn: opponent.fieldEnteredTurn.slice(),
      fieldAttackedTurn: opponent.fieldAttackedTurn.slice(),
      mulliganDone: opponent.mulliganDone
    },
    lastAction: game.lastAction,
    events: (game.events || []).slice(-8)
  };
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
  client.gameId = game.id;
  client.gamePlayerId = player.id;
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

function activateFirstBaseV94(player) {
  if (player.activeBase || !player.baseDeck.length) return null;
  const id = player.baseDeck.shift();
  player.baseStack.push(id);
  player.activeBase = id;
  return id;
}

function canOfferLv1BaseStartV94(game, player) {
  if (!player || Number(game.startedTurns[player.id] || 0) < 2) return false;
  const base = getBaseCardV94(player.activeBase);
  if (!base || Number(base.level || 0) !== 1) return false;
  if (!["SD01-0016", "SD02-0015"].includes(String(base.id || ""))) return false;
  if (player.hand.length < 2) return false;
  const { baseById } = cardPoolMapsV93();
  return player.baseDeck.some((id) => Number((baseById.get(String(id)) || {}).level || 0) === 2);
}

function enterMainAfterTurnStartV94(game, player) {
  const starts = Number(game.startedTurns[player.id] || 0);
  let requestedDraw = 0;
  if (!(player.id === game.firstPlayerId && starts === 1)) {
    requestedDraw = starts === 1 ? 1 : currentBaseLevelV94(player);
  }
  const drawCount = drawFromDeckV94(player, requestedDraw);
  game.phase = "main";
  return { drawCount, requestedDraw };
}

function beginTurnV94(game, playerId) {
  const player = getGamePlayerV94(game, playerId);
  if (!player) return null;
  game.currentPlayerId = playerId;
  game.playsThisTurn = 0;
  game.turnSequence = Number(game.turnSequence || 0) + 1;
  const basePlaced = activateFirstBaseV94(player);
  const starts = Number(game.startedTurns[playerId] || 0) + 1;
  game.startedTurns[playerId] = starts;

  if (canOfferLv1BaseStartV94(game, player)) {
    game.phase = "turn_start_base";
    return { starts, basePlaced, awaitingBaseDecision:true, drawCount:0, requestedDraw:0 };
  }

  const draw = enterMainAfterTurnStartV94(game, player);
  return { starts, basePlaced, awaitingBaseDecision:false, ...draw };
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

function deployOperatorV94(ws, message) {
  const ctx = requireGameV94(ws, message);
  if (!ctx) return;
  const { game, player } = ctx;
  if (game.phase !== "main") return pvpErrorV94(ws, "当前不是主要阶段。");
  if (game.currentPlayerId !== player.id) return pvpErrorV94(ws, "现在不是你的回合。");
  const slotIndex = Number(message.slotIndex);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex > 7) return pvpErrorV94(ws, "部署位置不合法。");
  if (player.field[slotIndex]) return pvpErrorV94(ws, "这个战场格已经有卡牌了。");
  const cardId = String(message.cardId || "");
  const handIndex = player.hand.indexOf(cardId);
  if (handIndex < 0) return pvpErrorV94(ws, "这张牌已经不在你的手牌中。");
  const { mainById } = cardPoolMapsV93();
  const card = mainById.get(cardId);
  if (!card || card.type !== "干员") return pvpErrorV94(ws, "v98 联机同步测试目前只允许普通部署干员卡。");
  const baseLevel = currentBaseLevelV94(player);
  if (Number(card.level || 0) > baseLevel) return pvpErrorV94(ws, `当前基地Lv${baseLevel}，不能部署Lv${card.level}干员。`);
  const playLimit = currentBaseLevelV94(player);
  if (game.playsThisTurn >= playLimit) return pvpErrorV94(ws, `本回合出牌次数已达到上限 ${playLimit}。`);
  player.hand.splice(handIndex, 1);
  player.field[slotIndex] = cardId;
  player.fieldEnteredTurn[slotIndex] = Number(game.turnSequence || 0);
  player.fieldAttackedTurn[slotIndex] = -1;
  game.playsThisTurn++;
  bumpRevision(game,{ type:"deploy_operator", by:player.id, cardId, slotIndex, at:Date.now() });
  sendGameStateV94(game);
}

function chooseCardsFromHandV94(player, ids) {
  const copy = player.hand.slice();
  const removed = [];
  for (const raw of ids) {
    const id = String(raw || "");
    const index = copy.indexOf(id);
    if (index < 0) return null;
    removed.push(copy.splice(index, 1)[0]);
  }
  return { remaining:copy, removed };
}

function resolveLv1BaseDecisionV94(ws, message) {
  const ctx = requireGameV94(ws, message);
  if (!ctx) return;
  const { game, player } = ctx;
  if (game.currentPlayerId !== player.id) return pvpErrorV94(ws, "现在不是你的回合。");
  if (game.phase !== "turn_start_base") return pvpErrorV94(ws, "当前没有等待处理的Lv1基地回合开始效果。");

  const activate = Boolean(message.activate);
  let discarded = [];
  let upgradedBase = null;

  if (activate) {
    const ids = Array.isArray(message.cardIds) ? message.cardIds.map(String) : [];
    if (ids.length !== 2) return pvpErrorV94(ws, "发动Lv1基地效果必须选择2张手牌作为费用。");
    const chosen = chooseCardsFromHandV94(player, ids);
    if (!chosen) return pvpErrorV94(ws, "选择的费用卡已经不在手牌中，请重新选择。");
    const { baseById } = cardPoolMapsV93();
    const lv2Index = player.baseDeck.findIndex((id) => Number((baseById.get(String(id)) || {}).level || 0) === 2);
    if (lv2Index < 0) return pvpErrorV94(ws, "基地卡组中没有可升级的Lv2基地。");

    player.hand = chosen.remaining;
    discarded = chosen.removed;
    player.grave.push(...discarded);
    upgradedBase = player.baseDeck.splice(lv2Index, 1)[0];
    player.baseStack.push(upgradedBase);
    player.activeBase = upgradedBase;
  }

  const draw = enterMainAfterTurnStartV94(game, player);
  bumpRevision(game, {
    type:"base_lv1_decision",
    by:player.id,
    activate,
    discarded:discarded.slice(),
    upgradedBase,
    drawCount:draw.drawCount,
    requestedDraw:draw.requestedDraw,
    at:Date.now()
  });
  sendGameStateV94(game);
}

function endTurnV94(ws, message) {
  const ctx = requireGameV94(ws, message);
  if (!ctx) return;
  const { game, player } = ctx;
  if (game.phase !== "main") return pvpErrorV94(ws, "当前不能结束回合。");
  if (game.currentPlayerId !== player.id) return pvpErrorV94(ws, "现在不是你的回合。");
  const nextId = game.players.find((p) => p.id !== player.id).id;
  if (player.id === game.secondPlayerId) game.round++;
  const turnStart = beginTurnV94(game, nextId);
  bumpRevision(game, {
    type:"end_turn",
    by:player.id,
    nextPlayerId:nextId,
    turnStart,
    at:Date.now()
  });
  sendGameStateV94(game);
}


function sameColumnV96(a, b) {
  return Number(a) % 4 === Number(b) % 4;
}

function operatorAttackValueV96(card) {
  return Number(card && card.attack || 0);
}

function legalOperatorTargetsV96(attackerCard, opponent) {
  const result = [];
  for (let i = 0; i < 8; i++) {
    if (opponent.field[i]) result.push(i);
  }
  return result;
}

function validateAttackTargetV96(attackerSlotIndex, targetSlotIndex, attackerCard, opponent) {
  if (!sameColumnV96(attackerSlotIndex, targetSlotIndex)) return false;

  const sameLine = legalOperatorTargetsV96(attackerCard, opponent)
    .filter((i) => sameColumnV96(attackerSlotIndex, i));

  if (!sameLine.length) return false;

  const { mainById } = cardPoolMapsV93();
  const forced = sameLine.filter((i) => {
    const card = mainById.get(String(opponent.field[i] || ""));
    if (!card) return false;
    if (card.forceAttackTarget === true) return true;
    return card.forceAttackTargetWhenFront === true && i < 4;
  });
  if (forced.length) return forced.includes(targetSlotIndex);

  if (String(attackerCard.attackRange || "近战") === "远程" || attackerCard.canAttackAsRanged === true) {
    return sameLine.includes(targetSlotIndex);
  }

  const front = sameLine.filter((i) => i < 4);
  const legal = front.length ? front : sameLine;
  return legal.includes(targetSlotIndex);
}

function clearFieldSlotV96(player, index) {
  const cardId = player.field[index];
  if (cardId) player.grave.push(cardId);
  player.field[index] = null;
  player.fieldEnteredTurn[index] = -1;
  player.fieldAttackedTurn[index] = -1;
}

function attackOperatorV96(ws, message) {
  const ctx = requireGameV94(ws, message);
  if (!ctx) return;
  const { game, player } = ctx;
  if (game.phase !== "main") return pvpErrorV94(ws, "当前不是主要阶段。");
  if (game.currentPlayerId !== player.id) return pvpErrorV94(ws, "现在不是你的回合。");

  const opponent = game.players.find((p) => p.id !== player.id);
  const a = Number(message.attackerSlotIndex);
  const t = Number(message.targetSlotIndex);
  if (![a,t].every(Number.isInteger) || a < 0 || a > 7 || t < 0 || t > 7) return pvpErrorV94(ws, "攻击位置不合法。");
  const attackerId = player.field[a];
  const targetId = opponent.field[t];
  if (!attackerId) return pvpErrorV94(ws, "攻击者已经不在战场上。");
  if (!targetId) return pvpErrorV94(ws, "目标已经不在战场上。");
  if (player.fieldEnteredTurn[a] === game.turnSequence) return pvpErrorV94(ws, "该干员本回合刚部署，不能攻击。");
  if (player.fieldAttackedTurn[a] === game.turnSequence) return pvpErrorV94(ws, "该干员本回合已经攻击过。");

  const { mainById } = cardPoolMapsV93();
  const attacker = mainById.get(String(attackerId));
  const target = mainById.get(String(targetId));
  if (!attacker || attacker.type !== "干员" || !target || target.type !== "干员") return pvpErrorV94(ws, "攻击双方必须是干员。");
  if (attacker.cannotAttack === true) return pvpErrorV94(ws, "该干员不能攻击。");
  if (!validateAttackTargetV96(a,t,attacker,opponent)) return pvpErrorV94(ws, "这个目标不符合当前战线的攻击规则。");

  player.fieldAttackedTurn[a] = game.turnSequence;
  const atk = operatorAttackValueV96(attacker);
  const def = operatorAttackValueV96(target);
  let result = "draw";
  if (atk > def) {
    clearFieldSlotV96(opponent,t);
    result = "attacker_win";
  } else if (atk < def) {
    clearFieldSlotV96(player,a);
    result = "defender_win";
  } else {
    clearFieldSlotV96(player,a);
    clearFieldSlotV96(opponent,t);
  }

  bumpRevision(game, {
    type:"attack_operator", by:player.id,
    attackerSlotIndex:a, targetSlotIndex:t,
    attackerCardId:attackerId, targetCardId:targetId,
    attackerAttack:atk, targetAttack:def, result, at:Date.now()
  });
  sendGameStateV94(game);
}

function attackPlayerV96(ws, message) {
  const ctx = requireGameV94(ws, message);
  if (!ctx) return;
  const { game, player } = ctx;
  if (game.phase !== "main") return pvpErrorV94(ws, "当前不是主要阶段。");
  if (game.currentPlayerId !== player.id) return pvpErrorV94(ws, "现在不是你的回合。");
  const opponent = game.players.find((p) => p.id !== player.id);
  const a = Number(message.attackerSlotIndex);
  if (!Number.isInteger(a) || a < 0 || a > 7) return pvpErrorV94(ws, "攻击位置不合法。");
  const attackerId = player.field[a];
  if (!attackerId) return pvpErrorV94(ws, "攻击者已经不在战场上。");
  if (player.fieldEnteredTurn[a] === game.turnSequence) return pvpErrorV94(ws, "该干员本回合刚部署，不能攻击。");
  if (player.fieldAttackedTurn[a] === game.turnSequence) return pvpErrorV94(ws, "该干员本回合已经攻击过。");
  const { mainById } = cardPoolMapsV93();
  const attacker = mainById.get(String(attackerId));
  if (!attacker || attacker.type !== "干员") return pvpErrorV94(ws, "攻击者必须是干员。");
  if (attacker.cannotAttack === true) return pvpErrorV94(ws, "该干员不能攻击。");
  const sameLine = opponent.field.some((id,index) => id && sameColumnV96(a,index));
  if (sameLine) return pvpErrorV94(ws, "同战线仍有敌方干员，不能直接攻击玩家。");

  player.fieldAttackedTurn[a] = game.turnSequence;
  if (opponent.baseLife.length === 0) {
    game.ended = true; game.phase = "ended"; game.winnerId = player.id; game.loserId = opponent.id;
    game.endReason = `${opponent.name}基地生命已为0，再次受到直接攻击，${player.name}获胜。`;
    bumpRevision(game,{type:"game_end",by:player.id,winnerId:player.id,loserId:opponent.id,reason:game.endReason,attackerSlotIndex:a,attackerCardId:attackerId,at:Date.now()});
    sendGameStateV94(game); return;
  }

  const revealed = opponent.baseLife.pop();
  const revealedCard = mainById.get(String(revealed || ""));
  let lifeBattle = null;
  if (revealedCard && revealedCard.type === "干员") {
    const atk = operatorAttackValueV96(attacker);
    const def = operatorAttackValueV96(revealedCard);
    lifeBattle = { cardId: revealed, attackerAttack: atk, defenderAttack: def, result: atk>def?"attacker_win":atk<def?"defender_win":"draw" };
    if (atk < def) clearFieldSlotV96(player,a);
    else if (atk === def) clearFieldSlotV96(player,a);
  }
  opponent.grave.push(revealed);
  bumpRevision(game,{type:"base_life_reveal",by:player.id,attackerSlotIndex:a,attackerCardId:attackerId,revealedBaseLife:revealed,remainingBaseLife:opponent.baseLife.length,lifeBattle,at:Date.now()});
  sendGameStateV94(game);
}


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
  const action = String(message.action || "");

  if (action === "surrender") return surrenderV97(ws, message);

  // 除投降外，已结束对局不再接受任何规则动作。
  const client = getClient(ws);
  const game = client && games.get(String(client.gameId || ""));
  if (game && (game.ended || game.phase === "ended")) {
    return pvpErrorV94(ws, "本局已经结束。");
  }

  if (action === "deploy_operator") return deployOperatorV94(ws, message);
  if (action === "attack_operator") return attackOperatorV96(ws, message);
  if (action === "attack_player") return attackPlayerV96(ws, message);
  if (action === "end_turn") return endTurnV94(ws, message);
  if (action === "base_lv1_decision") return resolveLv1BaseDecisionV94(ws, message);
  pvpErrorV94(ws, "v98 暂未开放这个联机动作。当前测试：调度、Lv1基地回合开始效果、普通干员部署、普通攻击、投降、结束回合。");
}

function startGame(ws) {
  const ctx = requireRoom(ws);
  if (!ctx) return;
  const { client, room } = ctx;

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
      pathname === "/data/card-pool-version.json"
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
    if (!requested.startsWith(PUBLIC_DIR)) {
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

const wss = new WebSocketServer({ noServer: true });

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

  ws.on("message", (raw) => {
    handleMessage(ws, raw);
  });

  ws.on("close", () => {
    removeClientFromRoom(client, "disconnect");
    clients.delete(ws);
  });

  ws.on("error", () => {
    // close 事件负责清理房间
  });
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("Rhodes PVP v98 server started");
  console.log(`Local:   http://localhost:${PORT}`);
  console.log(`Health:  http://localhost:${PORT}/health`);
  console.log("");
  console.log("局域网测试：用本机局域网IP替换 localhost。");
  console.log("跨公网测试：把本服务部署到公网服务器/Render/Railway/Fly.io 等平台。");
  console.log("");
});
