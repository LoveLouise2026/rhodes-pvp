'use strict';
const assert = require('node:assert/strict');
const createRules = require('../engine/rules');
const main = require('../data/cards.json'), bases = require('../data/base-cards.json');
const rules = createRules(main, bases);
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function fixture() {
  const make = (id, set) => ({ id, name: id, deck: Array(20).fill('SD01-0001'), hand: [], grave: [], baseLife: ['SD01-0001'], baseDeck: [], baseStack: [set+'-0016',set==='SD01'?'SD01-0017':'SD02-0016',set==='SD01'?'SD01-0018':'SD02-0017'], activeBase: set==='SD01'?'SD01-0018':'SD02-0017', field: Array(8).fill(null), fieldEnteredTurn: Array(8).fill(-1), fieldAttackedTurn: Array(8).fill(-1) });
  const a=make('A','SD01'),b=make('B','SD02');b.baseStack=['SD02-0015','SD02-0016','SD02-0017'];
  const g={id:'test',phase:'main',currentPlayerId:'A',firstPlayerId:'A',secondPlayerId:'B',turnSequence:5,playsThisTurn:0,round:2,startedTurns:{A:2,B:2},players:[a,b],revision:1};
  rules.ensure(g);return {g,a,b};
}
function field(f,p,s,id) { p.field[s]=id;p.fieldEnteredTurn[s]=1;p.fieldMeta[s]=null;rules.ensure(f.g);return p.fieldMeta[s]; }
function act(f,action,msg={},owner='A') { return rules.execute(f.g,owner,action,msg); }
function choose(f, predicate, owner) {
  const c=f.g.pendingChoice;assert(c,'expected pending choice');
  const options=typeof predicate==='function'?c.options.filter(predicate):predicate===null?[]:c.options.filter(o=>o.cardId===predicate);
  const selected=c.ordered?options:options.slice(0,c.max);
  act(f,'resolve_choice',{choiceId:c.id,optionIds:selected.map(o=>o.id)},owner||c.owner);
}
function settle(f) {
  let n=0;while(f.g.pendingChoice){assert(++n<100);const c=f.g.pendingChoice;choose(f,c.min===0?null:o=>c.options.indexOf(o)<c.min);}
  assert.equal(f.g.queue.length,0);
}
function deploy(f,id,slot=0){f.a.hand.push(id);act(f,'deploy_operator',{cardId:id,slotIndex:slot});}
function tactic(f,id){f.a.hand.push(id);act(f,'use_tactic',{cardId:id});}
test('choice targets map physical hand copies and board slots without exposing continuation or opponent choices',()=>{
 const f=fixture();f.a.hand=['SD01-0001','SD01-0001'];deploy(f,'SD01-0003');
 const view=rules.view(f.g,'A').pendingChoice;
 assert.deepEqual(view.options.map(o=>o.target),[{zone:'hand',owner:'A',index:0},{zone:'hand',owner:'A',index:1}]);
 assert(!('next' in view));assert(view.options.every(o=>!('value' in o)));assert.deepEqual(rules.view(f.g,'B').pendingChoice,{owner:'A',waiting:true});
 view.options[0].target.index=99;assert.equal(f.g.pendingChoice.options[0].target.index,0,'projection must not share mutable targets');
 choose(f,o=>o.value===1);const slots=rules.view(f.g,'A').pendingChoice.options;
 assert.deepEqual(slots.find(o=>o.target.index===4).target,{zone:'slot',owner:'A',index:4});
 choose(f,o=>o.value===4);assert.equal(f.a.field[4],'SD01-0001');assert.equal(f.g.pendingChoice.title,'夜刀');settle(f);
 const h=fixture();field(h,h.a,0,'SD02-0005');field(h,h.b,4,'SD02-0001');h.a.hand=['SD02-0005'];
 act(h,'deploy_operator',{cardId:'SD02-0005',slotIndex:4});
 assert.deepEqual(rules.view(h.g,'A').pendingChoice.options[0].target,{zone:'field',owner:'B',index:4});
});
test('base cost presents exact allowed counts; public peek cards have no hand or deck positions',()=>{
 const f=fixture();f.a.activeBase='SD01-0016';f.a.baseStack=['SD01-0016'];f.a.baseDeck=['SD01-0017'];f.a.hand=['SD01-0001','SD01-0002'];
 rules.beginTurn(f.g,'A');assert.deepEqual(rules.view(f.g,'A').pendingChoice.allowedCounts,[0,2]);
 const before=JSON.stringify(f.g);assert.throws(()=>act(f,'resolve_choice',{choiceId:f.g.pendingChoice.id,optionIds:['0']}),rules.RuleError);assert.equal(JSON.stringify(f.g),before);
 const h=fixture();h.a.deck=['SD01-0001','SD01-0002'];tactic(h,'SD01-0011');
 assert(rules.view(h.g,'A').pendingChoice.options.every(o=>!o.target));assert(!rules.view(h.g,'B').pendingChoice.options);
});
test('夜刀 reveal/draw; illegal and foreign choices leave state unchanged',()=>{
 const f=fixture();f.a.hand=['SD01-0002'];deploy(f,'SD01-0001');const c=f.g.pendingChoice;
 const serialized=JSON.stringify(f.g);assert.throws(()=>act(f,'resolve_choice',{choiceId:c.id,optionIds:['0']},'B'),rules.RuleError);assert.equal(JSON.stringify(f.g),serialized);
 assert.throws(()=>act(f,'end_turn'),rules.RuleError);choose(f,'SD01-0002');assert.equal(f.a.hand.length,2);
 assert(f.g.effectLog.some(e=>e.cardId==='SD01-0002'));assert.throws(()=>act(f,'resolve_choice',{choiceId:c.id,optionIds:['0']}),rules.RuleError);
});
test('杜林/空 buffs are live; field-only; cannot attack 空',()=>{
 const f=fixture();field(f,f.a,0,'SD01-0002');field(f,f.a,4,'SD02-0004');field(f,f.a,1,'SD01-0001');
 assert.equal(rules.power(f.g,f.a,0),3);assert.equal(rules.power(f.g,f.a,4),2);assert.equal(rules.power(f.g,f.a,1),2);
 assert.throws(()=>act(f,'attack_player',{attackerSlotIndex:4}),rules.RuleError);
});
test('巡林者 effect deployment does not spend normal play count',()=>{
 const f=fixture();f.a.hand=['SD01-0002'];deploy(f,'SD01-0003');choose(f,'SD01-0002');choose(f,o=>o.value===4);assert.equal(f.a.field[4],'SD01-0002');assert.equal(f.g.playsThisTurn,1);assert.equal(f.g.pendingChoice,null);
});
test('巡林者 -> 夜刀 keeps its deployment trigger when another A4 remains in hand',()=>{
 const f=fixture();f.a.hand=['SD01-0001','SD01-0002'];deploy(f,'SD01-0003');
 choose(f,'SD01-0001');choose(f,o=>o.value===4);
 assert.equal(f.a.field[4],'SD01-0001');assert.equal(f.g.pendingChoice.title,'夜刀');
 assert.deepEqual(f.g.pendingChoice.options.map(o=>o.cardId),['SD01-0002']);
 const before=f.a.deck.length;choose(f,'SD01-0002');
 assert.equal(f.a.deck.length,before-1);assert.equal(f.g.playsThisTurn,1);assert.equal(f.g.pendingChoice,null);
});
test('巡林者 -> last A4 夜刀 has no reveal target; private explanation without exposing hand to opponent',()=>{
 const f=fixture();f.a.hand=['SD01-0001'];deploy(f,'SD01-0003');choose(f,'SD01-0001');choose(f,o=>o.value===4);
 assert.equal(f.a.hand.length,0);assert.equal(f.g.pendingChoice,null);assert.equal(f.a.deck.length,20);
 assert(rules.view(f.g,'A').effectLog.some(e=>e.reason==='condition_not_met'&&e.text.includes('手牌中没有')));
 assert(!rules.view(f.g,'B').effectLog.some(e=>e.reason==='condition_not_met'));
});
test('杜宾 top reveal, optional deployment, no card loss when declined',()=>{
 const f=fixture();f.a.deck=['SD01-0005','SD01-0002'];deploy(f,'SD01-0004');choose(f,o=>o.value===4);assert.equal(f.a.field[4],'SD01-0005');assert.deepEqual(f.a.deck,['SD01-0002']);
 const h=fixture();h.a.deck=['SD01-0005'];deploy(h,'SD01-0004');choose(h,null);assert.deepEqual(h.a.deck,['SD01-0005']);
});
// Reordering intentionally needs all cards, including when there are two identical definitions.
test('红 private reorder and turn-start upgrade precede draw',()=>{
 const f=fixture();f.a.deck=['SD01-0001','SD01-0002','SD01-0003'];deploy(f,'SD01-0006');const c=f.g.pendingChoice;
 assert(rules.view(f.g,'B').pendingChoice.waiting);act(f,'resolve_choice',{choiceId:c.id,optionIds:['1','0']});assert.deepEqual(f.a.deck.slice(0,2),['SD01-0002','SD01-0001']);
 f.a.activeBase='SD01-0017';f.a.baseStack=['SD01-0016','SD01-0017'];f.a.baseDeck=['SD01-0018'];
 rules.beginTurn(f.g,'A');settle(f);assert.equal(f.a.activeBase,'SD01-0018');assert.equal(f.a.hand.length,3);
});
test('阿米娅 reveal/select/reorder; no eligible card returns all cards',()=>{
 const f=fixture();f.a.deck=['SD01-0001','SD02-0001','SD01-0005','SD02-0002'];deploy(f,'SD01-0007');choose(f,'SD01-0005');choose(f,o=>true);assert(f.a.hand.includes('SD01-0005'));assert.deepEqual(f.a.deck,['SD01-0001','SD02-0001','SD02-0002']);
 const h=fixture();h.a.deck=['SD02-0001'];deploy(h,'SD01-0007');assert.deepEqual(h.a.deck,['SD02-0001']);
});
test('煌 once/turn on tactics; top choices/selected identities stay private',()=>{
 const f=fixture();field(f,f.a,0,'SD01-0009');f.a.deck=['SD01-0008','SD01-0002','SD01-0005','SD01-0003'];
 tactic(f,'SD02-0012');assert.equal(f.g.pendingChoice,null,'non-Rhodes tactics do not trigger');
 f.a.deck=['SD01-0008','SD01-0002','SD01-0005','SD01-0003'];tactic(f,'SD01-0013'); // no Lv2 in hand, then Huang.
 choose(f,o=>true);const c=f.g.pendingChoice;assert(c);assert.equal(rules.view(f.g,'B').pendingChoice.options,undefined);
 choose(f,'SD01-0008');settle(f);assert(f.a.hand.includes('SD01-0008'));assert(!rules.view(f.g,'B').effectLog.some(e=>e.reason==='effect'&&e.cardId==='SD01-0008'));
 assert.equal(f.a.fieldMeta[0].huangTurn,f.g.turnSequence);
});
test('阿米娅 elite evolves same-name basic, recovers tactic, full stack dies together',()=>{
 const f=fixture();field(f,f.a,0,'SD01-0007');f.a.grave=['SD01-0011'];f.a.hand=['SD01-0008'];act(f,'evolve',{cardId:'SD01-0008',slotIndex:0});choose(f,'SD01-0011');assert(f.a.hand.includes('SD01-0011'));assert.deepEqual(f.a.fieldMeta[0].stack,['SD01-0007']);
 field(f,f.b,0,'SD01-0010');f.g.currentPlayerId='B';act(f,'attack_operator',{attackerSlotIndex:0,targetSlotIndex:0},'B');settle(f);assert(f.a.grave.includes('SD01-0007')&&f.a.grave.includes('SD01-0008'));
});
test('煌 elite non-draw special evolution and battle protection',()=>{
 const f=fixture();field(f,f.a,0,'SD01-0009');f.a.grave=['SD01-0010'];field(f,f.a,1,'SD01-0007');act(f,'activate_base');choose(f,'SD01-0010');choose(f,o=>true);assert.equal(f.a.field[0],'SD01-0010');assert.equal(f.a.fieldMeta[0].protectedTurn,5);
 field(f,f.b,0,'SD01-0010');f.g.currentPlayerId='B';act(f,'attack_operator',{attackerSlotIndex:0,targetSlotIndex:0},'B');settle(f);assert.equal(f.a.field[0],'SD01-0010');assert.equal(f.b.field[0],null);
});
test('命运的相遇 returns unselected card and exposes only deliberately revealed cards',()=>{
 const f=fixture();f.a.deck=['SD01-0005','SD02-0001','SD01-0002'];tactic(f,'SD01-0011');choose(f,'SD02-0001');assert.deepEqual(f.a.deck,['SD01-0005','SD01-0002']);assert(f.a.hand.includes('SD02-0001'));assert(rules.view(f.g,'B').effectLog.some(e=>e.cards?.length===2));
});
test('处决模式 deploys Lv2, resolves its trigger, then upgrades with 红',()=>{
 const f=fixture();field(f,f.a,0,'SD01-0006');f.a.activeBase='SD01-0017';f.a.baseStack=['SD01-0016','SD01-0017'];f.a.baseDeck=['SD01-0018'];f.a.hand=['SD01-0004'];f.a.deck=['SD02-0001'];tactic(f,'SD01-0013');choose(f,'SD01-0004');choose(f,o=>o.value===1);assert.equal(f.a.field[1],'SD01-0004');assert.equal(f.a.activeBase,'SD01-0018');
});
test('德克萨斯 deploy draw and grave cost once/turn',()=>{
 const f=fixture();deploy(f,'SD02-0001');assert.equal(f.a.hand.length,1);f.a.grave=['SD02-0001'];act(f,'activate_grave');choose(f,o=>true);assert.equal(f.a.hand[0],'SD02-0001');assert.throws(()=>act(f,'activate_grave'),rules.RuleError);
});
test('暗锁 death cost and same-row movement retain entity/attack history',()=>{
 const f=fixture();field(f,f.a,0,'SD01-0005');field(f,f.b,0,'SD02-0002');f.b.hand=['SD02-0001'];
 act(f,'attack_operator',{attackerSlotIndex:0,targetSlotIndex:0}); // Longmen base draw and Rope simultaneous.
 settleOrder(f);choose(f,o=>true);choose(f,o=>o.value===0);choose(f,o=>true);choose(f,o=>o.value===1);settle(f);
 assert.equal(f.a.field[0],null);assert.equal(f.a.field[1],'SD01-0005');assert.equal(f.a.fieldMeta[1].attacks,1);
});
function settleOrder(f){while(f.g.pendingChoice?.next.type==='order')choose(f,o=>true);}
test('阿消 forced target and defeat bounce cost',()=>{
 const f=fixture();field(f,f.a,0,'SD01-0005');field(f,f.b,4,'SD02-0003');field(f,f.b,0,'SD02-0001');f.b.hand=['SD02-0001','SD02-0002'];
 assert.throws(()=>act(f,'attack_operator',{attackerSlotIndex:0,targetSlotIndex:0}),rules.RuleError);
 act(f,'attack_operator',{attackerSlotIndex:0,targetSlotIndex:4});settleOrder(f);choose(f,o=>true);choose(f,o=>o.value===0||o.value===1);choose(f,o=>true);settle(f);assert.equal(f.a.field[0],null);assert(f.a.hand.includes('SD01-0005'));
});
test('食铁兽 optional same-line bounce uses current power',()=>{
 const f=fixture();field(f,f.b,4,'SD02-0001');deploy(f,'SD02-0005');choose(f,o=>true);assert.equal(f.b.field[4],null);assert(f.b.hand.includes('SD02-0001'));
});
test('星熊 start upgrade, 陈 two attacks and cannot attack a third time',()=>{
 const f=fixture();field(f,f.a,0,'SD02-0006');field(f,f.a,1,'SD02-0007');f.a.activeBase='SD02-0016';f.a.baseStack=['SD02-0015','SD02-0016'];f.a.baseDeck=['SD02-0017'];rules.beginTurn(f.g,'A');settle(f);assert.equal(f.a.activeBase,'SD02-0017');
 f.b.baseLife=['SD02-0004','SD02-0004'];act(f,'attack_player',{attackerSlotIndex:1});act(f,'attack_player',{attackerSlotIndex:1});assert.throws(()=>act(f,'attack_player',{attackerSlotIndex:1}),rules.RuleError);
});
test('陈 elite destroys only lower-power enemies in same line',()=>{
 const f=fixture();field(f,f.a,0,'SD02-0007');field(f,f.b,0,'SD01-0001');field(f,f.b,4,'SD01-0005');field(f,f.b,1,'SD01-0001');f.a.hand=['SD02-0008'];act(f,'evolve',{cardId:'SD02-0008',slotIndex:0});settle(f);assert.equal(f.b.field[0],null);assert.equal(f.b.field[4],null);assert(f.b.field[1]);
});
test('协同作战 orthogonal adjacency, no wrapping, buff expires',()=>{
 const f=fixture();field(f,f.a,0,'SD01-0005');field(f,f.a,4,'SD01-0001');tactic(f,'SD02-0009');choose(f,o=>o.value.slot===0);choose(f,o=>o.value.slot===4);assert.equal(rules.power(f.g,f.a,0),5);f.g.turnSequence++;assert.equal(rules.power(f.g,f.a,0),3);
 const h=fixture();field(h,h.a,3,'SD01-0005');field(h,h.a,4,'SD01-0001');assert.throws(()=>tactic(h,'SD02-0009'),rules.RuleError);
});
test('诗怀雅 basic/elite recover and normal evolution',()=>{
 const f=fixture();f.a.grave=['SD02-0001'];deploy(f,'SD02-0010');choose(f,'SD02-0001');f.a.hand.push('SD02-0011');f.a.grave.push('SD02-0009');act(f,'evolve',{cardId:'SD02-0011',slotIndex:0});choose(f,'SD02-0009');assert(f.a.hand.includes('SD02-0009'));
 f.a.grave.push('SD02-0012');rules.beginTurn(f.g,'A');settle(f);assert(f.a.hand.includes('SD02-0012'));
});
test('大小姐的施舍 draws two then upgrades with either 诗怀雅',()=>{
 const f=fixture();field(f,f.a,0,'SD02-0010');f.a.activeBase='SD02-0016';f.a.baseStack=['SD02-0015','SD02-0016'];f.a.baseDeck=['SD02-0017'];tactic(f,'SD02-0012');assert.equal(f.a.hand.length,2);assert.equal(f.a.activeBase,'SD02-0017');
});
test('罗德岛 Lv1 exact cost, inherited Lv2 defeat trigger once, Lv3 recovery once',()=>{
 const f=fixture();f.a.activeBase='SD01-0016';f.a.baseStack=['SD01-0016'];f.a.baseDeck=['SD01-0017','SD01-0018'];f.a.hand=['SD01-0001','SD01-0002'];rules.beginTurn(f.g,'A');const c=f.g.pendingChoice;
 assert.throws(()=>act(f,'resolve_choice',{choiceId:c.id,optionIds:['0']}),rules.RuleError);choose(f,o=>true);assert.equal(f.a.activeBase,'SD01-0017');assert.equal(f.a.grave.length,2);assert.equal(f.a.hand.length,2);
 const h=fixture();field(h,h.a,0,'SD01-0001');field(h,h.b,0,'SD01-0005');act(h,'attack_operator',{attackerSlotIndex:0,targetSlotIndex:0});settle(h);assert.equal(h.a.hand.length,1);assert.equal(h.a.once['SD01-0017'],5);
});
test('炎龙门 Lv1 upgrade, inherited Lv2 draws on either turn, Lv3 only own turn',()=>{
 const f=fixture();f.a.activeBase='SD02-0015';f.a.baseStack=['SD02-0015'];f.a.baseDeck=['SD02-0016','SD02-0017'];f.a.hand=['SD02-0001','SD02-0002'];rules.beginTurn(f.g,'A');choose(f,o=>true);assert.equal(f.a.activeBase,'SD02-0016');
 field(f,f.a,0,'SD02-0001');field(f,f.a,1,'SD02-0002');field(f,f.a,2,'SD02-0003');f.a.baseStack.push('SD02-0017');f.a.activeBase='SD02-0017';assert.equal(rules.power(f.g,f.a,0),3);f.g.currentPlayerId='B';assert.equal(rules.power(f.g,f.a,0),2);
});
function setTrap(f,id,slot=4){f.b.hand.push(id);f.g.currentPlayerId='B';act(f,'set_trap',{cardId:id,slotIndex:slot},'B');f.g.currentPlayerId='A';f.g.playsThisTurn=0;}
test('traps hidden in projection; cannot respond on set turn; stale revision-independent choices blocked',()=>{
 const f=fixture();setTrap(f,'SD01-0014');field(f,f.b,0,'SD01-0009');assert(!JSON.stringify(rules.view(f.g,'A')).includes('SD01-0014'));assert(rules.view(f.g,'B').players[1].traps[4].cardId);
 deploy(f,'SD02-0001');assert.equal(f.g.pendingChoice,null);assert(f.b.traps[4]);
});
test('沸腾爆裂 deployment response, exclusive 煌, top reveal then recover',()=>{
 const f=fixture();setTrap(f,'SD01-0014');f.g.turnSequence++;field(f,f.b,0,'SD01-0009');f.b.deck=['SD01-0001'];f.b.grave=['SD01-0005'];deploy(f,'SD02-0001');choose(f,o=>true);choose(f,'SD01-0005');settle(f);assert(f.b.hand.includes('SD01-0005'));assert(f.b.grave.includes('SD01-0014'));assert.equal(f.b.traps[4],null);assert.deepEqual(f.b.deck,['SD01-0001']);
});
test('精神爆发 defense deployment cancels now-blocked direct attack',()=>{
 const f=fixture();setTrap(f,'SD01-0015');f.g.turnSequence++;field(f,f.a,0,'SD01-0005');field(f,f.b,1,'SD01-0001');f.b.hand=['SD02-0001'];
 // Trap must share a line with the reference operator, not necessarily the attacker.
 f.b.traps[5]=f.b.traps[4];f.b.traps[4]=null;
 act(f,'attack_player',{attackerSlotIndex:0});choose(f,o=>true);choose(f,o=>o.value.slot===1);choose(f,'SD02-0001');choose(f,o=>o.value===0);settle(f);assert.equal(f.b.baseLife.length,1);assert.equal(f.b.field[0],'SD02-0001');
});
test('准备作战 draw/deploy, ignore-level special evolution if 陈 and 诗怀雅 exist',()=>{
 const f=fixture();setTrap(f,'SD02-0013');f.g.turnSequence++;field(f,f.a,0,'SD01-0005');field(f,f.b,1,'SD02-0007');field(f,f.b,2,'SD02-0010');f.b.hand=['SD02-0001','SD02-0008'];f.b.deck=['SD01-0001','SD01-0002'];f.b.activeBase='SD02-0015';
 act(f,'attack_player',{attackerSlotIndex:0});choose(f,o=>true);choose(f,'SD02-0001');choose(f,o=>o.value===0);
 assert.equal(f.b.deck.length,1,'deployed Texas draw is deferred until source tactic completes');
 choose(f,o=>true);settle(f);assert.equal(f.b.field[1],'SD02-0008');assert.equal(f.b.baseLife.length,1);assert.equal(f.b.deck.length,0);
});
test('赤霄绝影 destroys higher-than-陈 attacker, otherwise invalidates attack',()=>{
 const f=fixture();setTrap(f,'SD02-0014');f.g.turnSequence++;field(f,f.b,1,'SD02-0007');field(f,f.a,0,'SD01-0010');act(f,'attack_player',{attackerSlotIndex:0});choose(f,o=>true);choose(f,o=>true);settle(f);assert.equal(f.a.field[0],null);assert.equal(f.b.baseLife.length,1);
 const h=fixture();setTrap(h,'SD02-0014');h.g.turnSequence++;field(h,h.b,1,'SD02-0007');field(h,h.a,0,'SD01-0001');act(h,'attack_player',{attackerSlotIndex:0});choose(h,o=>true);settle(h);assert.equal(h.b.baseLife.length,1);assert(h.a.field[0]);
});
test('peek choice is serializable and resumes identically; forged option list rejected atomically',()=>{
 const f=fixture();f.a.deck=['SD01-0001','SD01-0002'];deploy(f,'SD01-0006');const snapshot=JSON.stringify(f.g), c=f.g.pendingChoice;
 assert.throws(()=>act(f,'resolve_choice',{choiceId:c.id,optionIds:['0','0']}),rules.RuleError);assert.equal(JSON.stringify(f.g),snapshot);
 const restored=JSON.parse(snapshot);rules.execute(restored,'A','resolve_choice',{choiceId:c.id,optionIds:['1','0']});assert.deepEqual(restored.players[0].deck,['SD01-0002','SD01-0001']);
});
test('Lv3 base recovery consumes once only after selection; can decline and retry',()=>{
 const f=fixture();field(f,f.a,0,'SD01-0007');f.a.grave=['SD01-0005'];act(f,'activate_base');choose(f,null);assert(!f.a.once['SD01-0018']);
 act(f,'activate_base');choose(f,'SD01-0005');assert.equal(f.a.once['SD01-0018'],5);f.a.grave.push('SD01-0005');assert.throws(()=>act(f,'activate_base'),rules.RuleError);
});
test('multiple identical hand/top cards remain independently selectable and conserved',()=>{
 const f=fixture();f.a.deck=['SD01-0002','SD01-0002'];deploy(f,'SD01-0006');choose(f,o=>true);assert.deepEqual(f.a.deck,['SD01-0002','SD01-0002']);
});
test('old snapshots/reconnect cannot expose deck order or nested continuation',()=>{
 const f=fixture();f.a.deck=['SD01-0008','SD01-0010'];deploy(f,'SD01-0006');
 const opponent=rules.view(f.g,'B');assert.equal(opponent.pendingChoice.title,undefined);assert.equal(opponent.pendingChoice.next,undefined);
 assert(!JSON.stringify(opponent).includes('SD01-0008'));assert(!JSON.stringify(opponent).includes('SD01-0010'));
 const self=rules.view(f.g,'A');assert.equal(self.pendingChoice.next,undefined);assert.equal(self.pendingChoice.options.length,2);
});
test('normal elite deployment, front-row traps, occupied cells and out-of-turn actions rejected',()=>{
 const f=fixture();f.a.hand=['SD01-0008','SD01-0014','SD01-0001'];
 for(const [action,msg] of [['deploy_operator',{cardId:'SD01-0008',slotIndex:0}],['set_trap',{cardId:'SD01-0014',slotIndex:0}],['use_tactic',{cardId:'SD01-0014'}]]) assert.throws(()=>act(f,action,msg),rules.RuleError);
 assert.equal(f.a.hand.length,3);assert.equal(f.g.playsThisTurn,0);
 assert.throws(()=>act(f,'end_turn',{},'B'),rules.RuleError);
});
test('trap pass preserves card, exclusivity rechecked; baseLife cards get no field buffs',()=>{
 const f=fixture();setTrap(f,'SD02-0014');f.g.turnSequence++;field(f,f.a,0,'SD01-0005');field(f,f.b,1,'SD02-0007');act(f,'attack_player',{attackerSlotIndex:0});choose(f,null);settle(f);assert(f.b.traps[4]);assert.equal(f.b.baseLife.length,0);
 const h=fixture();setTrap(h,'SD02-0014');h.g.turnSequence++;field(h,h.a,0,'SD01-0005');act(h,'attack_player',{attackerSlotIndex:0});assert.equal(h.g.pendingChoice,null);assert(h.b.traps[4]);
});
test('effect deployment 黄 triggers once, optional activation can be declined',()=>{
 const f=fixture();f.a.hand=['SD01-0009'];tactic(f,'SD01-0013');choose(f,'SD01-0009');choose(f,o=>o.value===0);choose(f,null);assert(!f.a.fieldMeta[0].huangTurn);assert.equal(f.a.field[0],'SD01-0009');
});
test('Huang battle immunity expires at the next turn',()=>{
 const f=fixture();field(f,f.a,0,'SD01-0010').protectedTurn=5;field(f,f.b,0,'SD01-0010');f.g.turnSequence=6;f.g.currentPlayerId='B';act(f,'attack_operator',{attackerSlotIndex:0,targetSlotIndex:0},'B');settle(f);assert.equal(f.a.field[0],null);
});
test('处决模式 completes base upgrade before ordering new deployment and old 煌 triggers',()=>{
 const f=fixture();field(f,f.a,0,'SD01-0009');f.a.activeBase='SD01-0017';f.a.baseStack=['SD01-0016','SD01-0017'];f.a.baseDeck=['SD01-0018'];f.a.hand=['SD01-0006'];
 tactic(f,'SD01-0013');choose(f,'SD01-0006');choose(f,o=>o.value===1);
 assert.equal(f.a.activeBase,'SD01-0018');assert.equal(f.g.pendingChoice.next.type,'order');assert.equal(f.g.pendingChoice.options.length,2);
 settle(f);
});
test('seeded full-game legal actions preserve every physical card through queues and choices',()=>{
 const templates=require('../data/starter-decks.json'),expand=require('../public/starter-decks').expand;
 for(let seed=1;seed<=8;seed++){
  let random=seed;const rng=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random/4294967296;};
  const f=fixture();
  for(let i=0;i<2;i++){
   const p=f.g.players[i],ids=expand(templates[i]);
   for(let j=ids.length-1;j>0;j--){const k=Math.floor(rng()*(j+1));[ids[j],ids[k]]=[ids[k],ids[j]];}
   p.hand=ids.splice(0,5);p.baseLife=ids.splice(0,5);p.deck=ids;p.grave=[];
  }
  const baseline=inventory(f.g);
  for(let step=0;step<450&&!f.g.ended;step++){
   const c=f.g.pendingChoice;
   if(c){
    const options=c.options.slice();for(let j=options.length-1;j>0;j--){const k=Math.floor(rng()*(j+1));[options[j],options[k]]=[options[k],options[j]];}
    let count=c.min===0?(rng()<.3?0:c.max):c.min;
    count=Math.min(count,options.length);
    act(f,'resolve_choice',{choiceId:c.id,optionIds:options.slice(0,count).map(o=>o.id)},c.owner);
   }else{
    const owner=f.g.currentPlayerId,legal=rules.view(f.g,owner).legalActions;
    const commands=[['end_turn',{}]];
    for(const h of legal.hand)commands.push([h.action,{cardId:h.cardId,...(h.slots?{slotIndex:h.slots[Math.floor(rng()*h.slots.length)]}:{})}]);
    for(const a of legal.attacks){if(a.direct)commands.push(['attack_player',{attackerSlotIndex:a.slot}]);for(const target of a.targets)commands.push(['attack_operator',{attackerSlotIndex:a.slot,targetSlotIndex:target}]);}
    if(legal.base)commands.push(['activate_base',{}]);if(legal.grave)commands.push(['activate_grave',{}]);
    const command=commands[Math.floor(rng()*commands.length)];act(f,command[0],command[1],owner);
   }
   assert.deepEqual(inventory(f.g),baseline,`card conservation failed at seed ${seed}, step ${step}`);
   for(const p of f.g.players)for(let s=0;s<8;s++)assert(!(p.field[s]&&p.traps[s]));
  }
 }
});
function inventory(g){
 const ids=[];
 for(const p of g.players){ids.push(...p.hand,...p.deck,...p.grave,...p.baseLife);p.field.forEach((id,s)=>{if(id)ids.push(id,...p.fieldMeta[s].stack);});p.traps.forEach(t=>{if(t)ids.push(t.cardId);});}
 function held(t){if(!t)return;if(t.type==='addHand')ids.push(t.cardId);if(t.type==='returnTop')ids.push(...t.ids);if(t.revealed)ids.push(...t.revealed);}
 held(g.pendingChoice?.next);g.queue.forEach(held);
 return ids.slice().sort();
}
let failures=0;
for(const [name,fn] of tests){try{fn();console.log('PASS',name);}catch(error){failures++;console.error('FAIL',name,error.stack);}}
assert.equal(failures,0,`${failures} effect scenarios failed`);
console.log(`All ${tests.length} effect scenarios passed`);
