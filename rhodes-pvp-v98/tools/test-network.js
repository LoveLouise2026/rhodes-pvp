const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');
const { once } = require('node:events');
const root = path.join(__dirname, '..');
const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
const sockets = [];
let stderr = '';
child.stderr.on('data', b => stderr += b);
function connection(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const messages = [], waiters = [];
  ws.on('message', data => {
    const message = JSON.parse(data);
    const index = waiters.findIndex(w => w.predicate(message));
    if (index >= 0) { const w = waiters.splice(index, 1)[0]; clearTimeout(w.timer); w.resolve(message); }
    else messages.push(message);
  });
  return {
    ws,
    send(type, payload = {}) { ws.send(JSON.stringify({ type, ...payload })); },
    next(predicate) {
      const i = messages.findIndex(predicate);
      if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { predicate, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('Timed out waiting for server message')); }, 5000) };
        waiters.push(w);
      });
    }
  };
}
const type = t => m => m.type === t;
async function main() {
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + stderr)), 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code + stderr)); });
    child.stdout.on('data', b => { output += b; const match = output.match(/NTCG listening on (\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base + '/health')).status, 200);
  const html = await (await fetch(base)).text();
  assert(html.includes('输入昵称')); assert(!html.includes('type="password"'));
  assert.equal((await fetch(base + '/online-effects.js')).status, 200);
  assert.match((await fetch(base + '/online-effects.css')).headers.get('content-type'), /text\/css/);
  assert.match((await fetch(base + '/images/cards/SD01-0007.webp')).headers.get('content-type'), /image\/webp/);
  const a = connection(port), b = connection(port);
  await Promise.all([once(a.ws, 'open'), once(b.ws, 'open')]);
  a.ws.send('null'); await a.next(type('error'));
  a.send('ping'); await a.next(type('pong'));
  const cards = require('../data/cards.json');
  const bases = require('../data/base-cards.json');
  const starters = await (await fetch(base + '/data/starter-decks.json')).json();
  assert.equal(starters.length, 2);
  const expanded = starters.map(t => ({ main: require('../public/starter-decks').expand(t), base: t.base }));
  const deck = expanded[0];
  a.send('hello', { name: 'A' }); b.send('hello', { name: 'B' });
  a.send('create_room', { deck }); const room = await a.next(type('room_joined'));
  b.send('join_room', { code: room.room.code, deck: expanded[1] }); await b.next(type('room_joined'));
  a.send('set_deck', { deck: expanded[1] }); assert.equal((await a.next(type('deck_validation'))).ok, true);
  a.send('set_deck', { deck }); assert.equal((await a.next(type('deck_validation'))).ok, true);
  a.send('set_ready', { ready: true }); b.send('set_ready', { ready: true });
  await a.next(m => m.type === 'room_update' && m.room.players.length === 2 && m.room.players.every(p => p.ready));
  a.send('start_game'); await Promise.all([a.next(type('rps_start')), b.next(type('rps_start'))]);
  a.send('start_game'); await a.next(type('error'));
  a.send('rps_choice', { choice: 'rock' }); b.send('rps_choice', { choice: 'scissors' });
  const [openingA, openingB] = await Promise.all([a.next(type('game_start')), b.next(type('game_start'))]);
  assert(!openingA.opponent.hand); assert(!openingB.opponent.reconnectToken);
  // Simulate the reload performed by the browser at game start.
  a.ws.close(); b.ws.close(); await Promise.all([once(a.ws, 'close'), once(b.ws, 'close')]);
  const aa = connection(port), bb = connection(port);
  await Promise.all([once(aa.ws, 'open'), once(bb.ws, 'open')]);
  aa.send('resume_game', { gameId: openingA.gameId, playerId: openingA.self.id, reconnectToken: 'wrong' }); await aa.next(type('pvp_error'));
  aa.send('resume_game', { gameId: openingA.gameId, playerId: openingA.self.id, reconnectToken: openingA.self.reconnectToken });
  bb.send('resume_game', { gameId: openingB.gameId, playerId: openingB.self.id, reconnectToken: openingB.self.reconnectToken });
  await Promise.all([aa.next(type('game_resumed')), bb.next(type('game_resumed'))]);
  aa.send('mulligan_submit', { cardIds: [] });
  const opponentView = await bb.next(m => m.type === 'game_state' && m.lastAction?.type === 'mulligan');
  assert(!('replacementHand' in opponentView.lastAction));
  assert(opponentView.events.every(e => !('replacementHand' in e)));
  bb.send('mulligan_submit', { cardIds: [] });
  const main = await aa.next(m => m.type === 'game_state' && m.phase === 'main');
  assert.equal(main.rulesVersion, 'effects-v1');
  assert(main.rules.legalActions.endTurn);
  bb.send('game_action', { action: 'end_turn', gameId: main.gameId }); await bb.next(type('pvp_error'));
  aa.send('game_action', { action: 'end_turn', gameId: main.gameId });
  await bb.next(m => m.type === 'game_state' && m.isYourTurn && m.phase === 'main');
  bb.send('game_action', { action: 'surrender', gameId: main.gameId, playerId: openingA.self.id });
  const ended = await aa.next(m => m.type === 'game_state' && m.ended);
  assert.equal(ended.winnerId, openingA.self.id);
  assert.equal((await (await fetch(base + '/health')).json()).ok, true);
  console.log('Real HTTP/WebSocket checks passed: room, RPS, reload/reconnect, hidden events, turns, surrender');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const ws of sockets) ws.terminate();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
});
