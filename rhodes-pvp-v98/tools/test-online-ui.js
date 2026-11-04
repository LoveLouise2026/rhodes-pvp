'use strict';
// Exercise the real click adapter with a small DOM fixture. No production/debug endpoints are required.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.parentElement = null; this.style = {}; this.dataset = {}; this.attrs = {}; this.classes = new Set(); this.textContent = ''; this.disabled = false;
    this.classList = { add: (...v) => v.forEach(x => this.classes.add(x)), remove: (...v) => v.forEach(x => this.classes.delete(x)), contains: v => this.classes.has(v), toggle: (v, on) => { const yes = on ?? !this.classes.has(v); yes ? this.classes.add(v) : this.classes.delete(v); return yes; } };
  }
  set className(v) { this.classes = new Set(v.split(/\s+/).filter(Boolean)); } get className() { return [...this.classes].join(' '); }
  append(...items) { for (const e of items) { this.children.push(e); e.parentElement = this; } }
  replaceChildren(...items) { this.children.forEach(e => e.parentElement = null); this.children = []; this.append(...items); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(e => e !== this); this.parentElement = null; }
  setAttribute(k,v) { this.attrs[k] = v; } removeAttribute(k) { delete this.attrs[k]; }
  contains(e) { return e === this || this.children.some(x => x.contains(e)); }
  matches(selector) { return selector.split(',').some(s => {
    const parts = s.trim().split(/\s+/); let node = this;
    const match = (e, token) => { const tag = token.match(/^[a-z]+/i)?.[0], id = token.match(/#([\w-]+)/)?.[1], cls = [...token.matchAll(/\.([\w-]+)/g)].map(m => m[1]); return (!tag || e.tagName === tag) && (!id || e.id === id) && cls.every(c => e.classes.has(c)); };
    if (!match(node, parts.pop())) return false;
    while (parts.length) { const part = parts.pop(); node = node.parentElement; while (node && !match(node,part)) node = node.parentElement; if (!node) return false; } return true;
  }); }
  closest(s) { let e = this; while (e) { if (e.matches(s)) return e; e = e.parentElement; } return null; }
  querySelectorAll(s) { return this.children.flatMap(e => [...(e.matches(s) ? [e] : []), ...e.querySelectorAll(s)]); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
}
const body = new Element('body'), listeners = {}, messages = [], details = []; let localMutations = 0, connected = true;
const document = { body, createElement: tag => new Element(tag), getElementById: id => body.querySelector('#' + id), querySelector: s => body.querySelector(s), querySelectorAll: s => body.querySelectorAll(s), addEventListener: (kind, fn) => (listeners[kind] ||= []).push(fn) };
function add(tag, id, cls, parent = body) { const e = new Element(tag); e.id = id; e.className = cls || ''; parent.append(e); return e; }
const hand = add('div', 'handArea', 'hand'), own = add('div', '', 'player-area'), zone = add('div', '', 'player-zone', own), enemy = add('div', '', 'enemy-area'), enemyGroup = add('div', '', 'slot-group', enemy);
const slots = { player: Array.from({length:8}, () => add('div', '', 'player-slot', zone)), enemy: Array.from({length:8}, () => add('div', '', 'slot', enemyGroup)) };
const life = add('div', '', 'base-life', enemy), base = add('div', 'playerBaseArea', 'base', own), grave = add('div', '', 'grave', own);
for (const [id, buttons] of [['cardActionMenu',['deployButton','evolveButton','useButton','setButton','cancelActionButton']],['battleActionMenu',['attackButton','cancelBattleActionButton']],['baseLv3ActivateOverlay',['baseLv3ActivateConfirmButton','baseLv3ActivateCancelButton']]]) {
  const menu = add('div', id); menu.style.display = 'none'; buttons.forEach(b => add('button', b, '', menu).onclick = () => localMutations++);
}
add('button','endTurnButton').onclick = () => localMutations++;
const graveOverlay = add('div','graveOverlay'), graveCards = add('div','graveCards','',graveOverlay);
const main = require('../data/cards.json'), bases = require('../data/base-cards.json');
const context = { document, console, setTimeout: () => 0, selectedCard:null, selectedAction:null, selectedAttacker:null, selectingAttackTarget:false, playerGrave:[], calculateOperatorAttack: () => ({final:17}), showDetail: c => details.push(c.id), placeFixedUiNearPointer: e => { e.style.left = '100px'; }, applyCardImageV88:()=>{}, rhodesCardDataV87:{mainCards:main,baseCards:bases}, rhodesPvpV94:{slotFor:(side,index)=>slots[side][index],send:(type,payload)=>{ if(!connected)return false; messages.push({type,...payload}); return true; }} };
context.openGraveViewer = cards => { graveCards.replaceChildren(); cards.forEach(c => { const e = add('div','','card',graveCards); e.cardData = c; add('button','','v82-grave-activate',e).onclick = () => localMutations++; }); graveOverlay.style.display = 'flex'; };
context.window = context; vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/online-effects.js'),'utf8'),context);
const get = id => document.getElementById(id), query = s => document.querySelector(s);
function click(target) { assert(target,'missing click target'); if(target.disabled)return; const e = {target,clientX:100,clientY:100,preventDefault(){},stopImmediatePropagation(){this.stopped=true;}}; for(const fn of listeners.click) { fn(e); if(e.stopped)break; } if(!e.stopped)target.onclick?.(e); }
function snapshot(extra={}) {
  return {gameId:'G',revision:1,phase:'main',isYourTurn:true,playsThisTurn:0,playLimit:3,self:{id:'A',hand:['SD01-0001','SD01-0002'],field:Array(8).fill(null),grave:[],activeBase:'SD01-0018'},opponent:{id:'B',field:Array(8).fill(null)},rules:{players:[],effectLog:[],pendingChoice:null,legalActions:{hand:[{index:0,cardId:'SD01-0001',action:'deploy_operator',slots:[0,5]}],attacks:[],endTurn:true}},...extra};
}
function render(s) {
  hand.replaceChildren(); s.self.hand.forEach(id => { const e = add('div','','card',hand); e.cardData = main.find(c=>c.id===id); e.onclick = () => localMutations++; });
  for(const side of ['player','enemy']) slots[side].forEach((slot,index) => { slot.replaceChildren(); const id = s[side==='player'?'self':'opponent'].field[index]; if(id){const e=add('div','','card',slot);e.cardData=main.find(c=>c.id===id);} slot.onclick=()=>localMutations++; });
  context.playerGrave = s.self.grave.map(id=>main.find(c=>c.id===id)); context.renderOnlineEffects(s);
}
let s=snapshot(); render(s); click(hand.children[0]); assert.equal(get('cardActionMenu').style.display,'flex'); assert.equal(get('evolveButton').style.display,'none'); assert.equal(query('.online-overlay'),null);
click(get('deployButton')); assert(slots.player[0].classList.contains('online-target')); assert(!slots.player[1].classList.contains('online-target'));
click(slots.player[1]);assert.equal(messages.length,0);click(slots.player[5]);assert.equal(messages.at(-1).slotIndex,5);assert.equal(messages.at(-1).expectedRevision,1);click(slots.player[0]);assert.equal(messages.length,1,'double click must not submit twice');
render(s);click(hand.children[0]);click(get('deployButton'));click([...get('onlineInteractionHint').children].find(e=>e.textContent==='取消'));assert(!slots.player[0].classList.contains('online-target'));
s=snapshot();s.self.field[2]='SD01-0004';s.opponent.field[6]='SD01-0005';s.rules.legalActions.attacks=[{slot:2,targets:[6],direct:false}];render(s);click(slots.player[2]);click(get('attackButton'));assert(slots.enemy[6].classList.contains('online-target'));assert(!slots.enemy[2].classList.contains('online-target'));click(slots.enemy[6]);assert.equal(messages.at(-1).targetSlotIndex,6);
s.rules.legalActions.attacks=[{slot:2,targets:[],direct:true}];render(s);click(slots.player[2]);click(get('attackButton'));click(life);assert.equal(messages.at(-1).action,'attack_player');
s=snapshot();s.rules.pendingChoice={id:'hand',title:'夜刀',min:0,max:1,options:[{id:'second-copy',label:'杜林',cardId:'SD01-0002',target:{zone:'hand',owner:'A',index:1}}]};render(s);assert.equal(query('.online-overlay'),null);click(hand.children[0]);assert.equal(messages.at(-1).action,'attack_player');click(hand.children[1]);assert.equal(messages.at(-1).optionIds[0],'second-copy');
s.rules.pendingChoice={id:'cost',title:'Lv1基地',min:0,max:2,allowedCounts:[0,2],options:s.self.hand.map((id,index)=>({id:String(index),cardId:id,target:{zone:'hand',owner:'A',index}}))};render(s);click(hand.children[0]);let confirm=get('onlineInteractionHint').children.find(e=>e.tagName==='button'&&e.textContent.startsWith('确认'));assert(confirm.disabled);render(s);assert(hand.children[0].classList.contains('online-picked'),'same pending choice survives redraw');click(hand.children[1]);confirm=get('onlineInteractionHint').children.find(e=>e.tagName==='button'&&e.textContent.startsWith('确认'));assert(!confirm.disabled);click(confirm);assert.equal(messages.at(-1).optionIds.join(','),'0,1');
s.rules.pendingChoice={id:'enemy-slot',title:'暗锁',min:1,max:1,options:[{id:'move',label:'后排第2战线',target:{zone:'slot',owner:'B',index:5}}]};render(s);assert(slots.enemy[5].classList.contains('online-target'));click(slots.enemy[5]);assert.equal(messages.at(-1).optionIds[0],'move');
s.rules.pendingChoice={id:'order',title:'排列卡组顶',min:2,max:2,ordered:true,options:[{id:'0',label:'第一张',cardId:'SD01-0001'},{id:'1',label:'第二张',cardId:'SD01-0002'}]};render(s);click(query('.online-choice-option').parentElement.children[1]);click(query('.online-choice-option'));click(document.querySelectorAll('.online-actions button').find(e=>e.textContent.startsWith('确认')));assert.equal(messages.at(-1).optionIds.join(','),'1,0');
render(s);click(document.querySelectorAll('.online-actions button').find(e=>e.textContent==='查看战场'));assert.equal(query('.online-overlay'),null);click(get('onlineInteractionHint').children.find(e=>e.textContent==='继续选择'));assert(query('.online-overlay'));
s=snapshot();s.rules.pendingChoice={waiting:true,owner:'B'};render(s);const count=messages.length;click(hand.children[0]);click(slots.player[0]);assert.equal(messages.length,count);
s=snapshot();s.self.grave=['SD02-0001'];s.rules.legalActions.grave=true;render(s);click(grave);assert.equal(graveCards.querySelectorAll('.v82-grave-activate').length,0);click(graveCards.querySelector('button'));assert.equal(messages.at(-1).action,'activate_grave');
s=snapshot();s.rules.legalActions.base=true;render(s);click(base);assert.equal(get('baseLv3ActivateOverlay').style.display,'flex');click(get('baseLv3ActivateConfirmButton'));assert.equal(messages.at(-1).action,'activate_base');
for(const [action,id,buttonId,slot] of [['evolve','SD01-0008','evolveButton',1],['set_trap','SD01-0015','setButton',7],['use_tactic','SD01-0011','useButton',null]]){
 s=snapshot();s.self.hand=[id];s.rules.legalActions.hand=[{index:0,cardId:id,action,...(slot===null?{}:{slots:[slot]})}];render(s);click(hand.children[0]);click(get(buttonId));if(slot!==null)click(slots.player[slot]);assert.equal(messages.at(-1).action,action);assert.equal(messages.at(-1).cardId,id);
}
s=snapshot();s.rules.pendingChoice={id:'trap',title:'是否发动陷阱',min:0,max:1,options:[{id:'trap5',cardId:'SD01-0015',target:{zone:'trap',owner:'A',index:5}}]};render(s);click(slots.player[5]);assert.equal(messages.at(-1).optionIds[0],'trap5');
s=snapshot();render(s);connected=false;click(hand.children[0]);click(get('deployButton'));click(slots.player[0]);assert.equal(get('endTurnButton').disabled,false);connected=true;context.onlineEffectsError({message:'选择已过期'});assert.equal(query('.online-target'),null);
render({...s,ended:true});assert.equal(query('.online-overlay'),null);assert.equal(get('onlineInteractionHint').hidden,true);
assert.equal(localMutations,0,'online commands must never reach solo state-mutating handlers');context.onlineEffectsEnabled=false;click(hand.children[0]);assert.equal(localMutations,1,'solo clicks retain original behavior');
console.log('Online UI checks passed: native menus, board targets, duplicate clicks, choices, costs, order, cancel, grave/base, errors and solo isolation');
// Own set cards show details on hover, while the opponent's card identity stays hidden.
context.onlineEffectsEnabled = true;
s = snapshot();
s.rules.players = [
  { id: 'A', powers: [], meta: [], traps: Array.from({length:8}, (_,i) => i === 5 ? {cardId:'SD01-0015'} : null) },
  { id: 'B', powers: [], meta: [], traps: Array.from({length:8}, (_,i) => i === 5 ? {hidden:true} : null) }
];
render(s);
details.length = 0;
for (const fn of listeners.mouseover || []) fn({target:slots.player[5].querySelector('.online-trap'),relatedTarget:null});
assert.deepEqual(details, ['SD01-0015']);
for (const fn of listeners.mouseover || []) fn({target:slots.enemy[5].querySelector('.online-trap'),relatedTarget:null});
assert.deepEqual(details, ['SD01-0015']);
context.setOnlineFeedbackBusy(true);
const beforeFeedbackClick = messages.length;
click(hand.children[0]); click(get('endTurnButton'));
assert.equal(messages.length, beforeFeedbackClick);
context.setOnlineFeedbackBusy(false);
console.log('Hover privacy and animation input lock checks passed');
