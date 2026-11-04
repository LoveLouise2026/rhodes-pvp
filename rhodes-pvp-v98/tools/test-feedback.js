'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/card-game.html'), 'utf8');
// Share the existing DOM fixture's element model, without executing its tests.
const uiSource = fs.readFileSync(path.join(__dirname, 'test-online-ui.js'), 'utf8');
const elementContext = vm.createContext({});
vm.runInContext(uiSource.slice(uiSource.indexOf('class Element'), uiSource.indexOf('const body =')) + ';globalThis.Element = Element;', elementContext);
const Element = elementContext.Element;
const body = new Element('body');
const documentElement = new Element('html');
const document = {
  body, documentElement,
  createElement: tag => new Element(tag),
  getElementById: id => body.querySelector('#' + id),
  querySelector: selector => body.querySelector(selector)
};
const storage = new Map();
const timers = [];
const context = {
  document, console, Date,
  sessionStorage: { getItem: key => storage.get(key) || null },
  setTimeout: fn => { timers.push(fn); return timers.length; },
  rhodesCardDataV87: { mainCards: require('../data/cards.json'), baseCards: require('../data/base-cards.json') }
};
context.window = context;
vm.createContext(context);
const feedbackSource = fs.readFileSync(path.join(root, 'public/battle-feedback.js'), 'utf8');
vm.runInContext(feedbackSource, context);
const feedback = context.battleFeedback;
const get = id => document.getElementById(id);
async function advance() {
  assert(timers.length, 'expected an animation timer');
  timers.shift()();
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function snapshot(revision) {
  return { gameId: 'G', revision, round: 2, currentPlayerId: 'A', isYourTurn: true, self: { id: 'A' }, rules: { effectLog: [] } };
}

async function main() {
  assert.equal(feedback.shouldEnterBattle(), false);
  storage.set('rhodesLoggedUserV68', 'Tester');
  storage.set('rhodesPendingBattleV77', JSON.stringify({username:'Tester', createdAt:Date.now(), battleNonce:'new'}));
  assert.equal(feedback.shouldEnterBattle(), true);
  vm.runInContext(feedbackSource, context);
  assert('data-battle-boot' in documentElement.attrs, 'battle boot must hide login before body parsing');
  assert(html.indexOf('/battle-feedback.js') < html.indexOf('<body>'));
  assert(html.includes('showScreen(window.battleFeedback?.shouldEnterBattle() ? "battle" : "auth")'));
  storage.set('rhodesLastBattleNonceV78', 'new');
  assert.equal(feedback.shouldEnterBattle(), false);
  storage.set('rhodesPendingBattleV77', JSON.stringify({username:'Other', createdAt:Date.now(), battleNonce:'other'}));
  assert.equal(feedback.shouldEnterBattle(), false);
  storage.set('rhodesPendingBattleV77', 'broken');
  assert.equal(feedback.shouldEnterBattle(), false);
  storage.delete('rhodesPendingBattleV77');
  storage.set('rhodesServerOpeningV91', JSON.stringify({gameId:'G',self:{id:'A',reconnectToken:'token'}}));
  assert.equal(feedback.shouldEnterBattle(), true);
  storage.clear();
  console.log('PASS battle reload boot, normal entry, stale nonce, foreign user and invalid storage');

  const cardElement = new Element();
  const outer = feedback.beginEffect({name:'夜刀'}, '部署时', cardElement);
  const inner = feedback.beginEffect({name:'巡林者'}, '通过效果部署时', cardElement);
  assert(get('battleEffectStatus').textContent.includes('巡林者'));
  inner();
  assert(get('battleEffectStatus').textContent.includes('夜刀'));
  assert(cardElement.classList.contains('battle-effect-active'));
  outer(); outer();
  assert(get('battleEffectStatus').hidden);
  assert(!cardElement.classList.contains('battle-effect-active'));
  console.log('PASS nested effect labels, source glow, restoration and idempotent cleanup');

  const emitStart = html.indexOf('async function emitGameEffectEvent(');
  const emitEnd = html.indexOf('async function emitOperatorDeployed(', emitStart);
  context.gameEffectRegistry = { test: [async () => { throw Error('fixture failure'); }] };
  vm.runInContext(html.slice(emitStart, emitEnd), context);
  const failed = context.emitGameEffectEvent('test', {cardData:{name:'夜刀'},cardElement});
  const rejection = assert.rejects(failed, /fixture failure/);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await advance(); await rejection;
  assert(get('battleEffectStatus').hidden);
  assert(!cardElement.classList.contains('battle-effect-active'));
  console.log('PASS real solo effect entry clears glow/status when a handler throws');

  const previous = snapshot(1), next = snapshot(2);
  next.currentPlayerId = 'B'; next.isYourTurn = false;
  next.rules.effectLog.push({id:1,by:'B',cardId:'SD01-0011',feedback:'use_tactic'});
  const immutable = JSON.stringify([previous,next]);
  const animation = feedback.transition(next, previous);
  assert(get('battleTurnBanner').textContent.includes('对方回合'));
  await advance();
  assert(get('battleEffectStatus').textContent.includes('命运的相遇'));
  assert(body.querySelector('.battle-effect-preview'));
  await advance(); await animation;
  assert.equal(get('battleTurnBanner'), null);
  assert.equal(body.querySelector('.battle-effect-preview'), null);
  assert(get('battleEffectStatus').hidden);
  assert.equal(JSON.stringify([previous,next]), immutable, 'animation must not mutate server snapshots');
  await feedback.transition(next, previous);
  await feedback.transition(snapshot(3), null);
  assert.equal(timers.length, 0, 'duplicates and reconnect snapshots must not replay animations');
  const own = snapshot(3);
  const ownAnimation = feedback.transition(own, next);
  assert(get('battleTurnBanner').textContent.includes('你的回合'));
  await advance(); await ownAnimation;
  assert(html.includes('await window.battleFeedback.turn(currentPlayer,currentTurn)'), 'solo turn entry must use the same feedback');
  assert(html.includes('showDetail(this.cardData);\n        showDeckCount('), 'solo set traps must update the left detail panel');
  console.log('PASS both turn perspectives, confirmed tactic preview, ordering, immutable snapshots and reconnect suppression');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
