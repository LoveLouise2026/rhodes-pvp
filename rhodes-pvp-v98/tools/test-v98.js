const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('assert');
const source=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8')+`\n;globalThis.__t={clients,rooms,games,deployOperatorV94,attackOperatorV96,attackPlayerV96,surrenderV97,resumeGameV94,requireGameV94,submitRps,gameActionV94};`;
class FakeServer{on(){} address(){return {port:3000}} listen(_p,_h,cb){if(cb)cb();}}
class FakeWSS{constructor(){} on(){} handleUpgrade(){} emit(){}}
const context={console:{log(){},error(){}},process:{env:{},on(){},cwd:()=>path.join(__dirname,'..')},__dirname:path.join(__dirname,'..'),Buffer,URL,setInterval:()=>({unref(){}}),clearInterval(){},setTimeout:(fn)=>{context.__timers.push(fn);return context.__timers.length;},clearTimeout(){},__timers:[],require:(name)=>{
 if(name==='http') return {createServer:()=>new FakeServer()};
 if(name==='ws') return {WebSocketServer:FakeWSS,WebSocket:{OPEN:1}};
 if(name.startsWith('./')) return require(path.join(__dirname,'..',name));
 return require(name);
}};
vm.createContext(context);vm.runInContext(source,context,{filename:'server.js'});const t=context.__t;
function sock(id){return {id,readyState:1,messages:[],send(s){this.messages.push(JSON.parse(s));}}}
function fixture(){
 const A=sock('A'),B=sock('B');
 t.clients.clear();t.rooms.clear();t.games.clear();
 t.clients.set(A,{id:'A',name:'A',roomCode:'R',gameId:'G',gamePlayerId:'A'});t.clients.set(B,{id:'B',name:'B',roomCode:'R',gameId:'G',gamePlayerId:'B'});
 const p=(id,ws)=>({id,ws,name:id,deckName:'d',reconnectToken:'tok-'+id,deck:Array(20).fill('SD01-0001'),hand:['SD01-0008','SD02-0004','SD01-0001'],baseDeck:['SD01-0017','SD01-0018'],baseStack:['SD01-0016'],activeBase:'SD01-0016',baseLife:['SD01-0001'],grave:[],field:Array(8).fill(null),fieldEnteredTurn:Array(8).fill(-1),fieldAttackedTurn:Array(8).fill(-1),mulliganDone:true});
 const game={id:'G',roomCode:'R',revision:1,phase:'main',round:1,firstPlayerId:'A',secondPlayerId:'B',currentPlayerId:'A',playsThisTurn:0,turnSequence:5,startedTurns:{A:2,B:1},lastAction:null,events:[],players:[p('A',A),p('B',B)]};t.games.set('G',game);return {A,B,game,a:game.players[0],b:game.players[1]};
}
function last(ws){return ws.messages.at(-1)||{} }
let f=fixture();
t.deployOperatorV94(f.A,{gameId:'G',action:'deploy_operator',cardId:'SD01-0008',slotIndex:0});assert.equal(f.a.field[0],null);assert.equal(last(f.A).type,'pvp_error');
f=fixture();f.a.field[0]='SD02-0004';f.a.fieldEnteredTurn[0]=0;t.attackPlayerV96(f.A,{gameId:'G',attackerSlotIndex:0});assert.equal(last(f.A).type,'pvp_error');
f=fixture();f.a.field[0]='SD01-0001';f.a.fieldEnteredTurn[0]=5;t.attackPlayerV96(f.A,{gameId:'G',attackerSlotIndex:0});assert.equal(last(f.A).type,'pvp_error');
f=fixture();f.a.field[0]='SD01-0001';f.a.fieldEnteredTurn[0]=0;f.a.fieldAttackedTurn[0]=5;t.attackPlayerV96(f.A,{gameId:'G',attackerSlotIndex:0});assert.equal(last(f.A).type,'pvp_error');
f=fixture();f.a.field[0]='SD01-0001';f.a.fieldEnteredTurn[0]=0;f.b.baseLife=[];t.attackPlayerV96(f.A,{gameId:'G',attackerSlotIndex:0});assert.equal(f.game.ended,true);assert.equal(f.game.winnerId,'A');
f=fixture();t.surrenderV97(f.A,{gameId:'G',playerId:'B'});assert.equal(f.game.loserId,'A');assert.equal(f.game.winnerId,'B');
f=fixture();const X=sock('X');t.clients.set(X,{id:'X',name:'X',roomCode:'',gameId:'',gamePlayerId:''});t.resumeGameV94(X,{gameId:'G',playerId:'A',reconnectToken:'wrong'});assert.equal(t.clients.get(X).gameId,'');t.resumeGameV94(X,{gameId:'G',playerId:'A',reconnectToken:'tok-A'});assert.equal(t.clients.get(X).gamePlayerId,'A');

// duplicate RPS submissions must schedule exactly one start callback
{
 const A=sock('RA'),B=sock('RB'); t.clients.clear(); t.rooms.clear(); t.games.clear(); context.__timers.length=0;
 t.clients.set(A,{id:'RA',name:'RA',roomCode:'ROOM'}); t.clients.set(B,{id:'RB',name:'RB',roomCode:'ROOM'});
 const room={code:'ROOM',hostId:'RA',players:[{id:'RA',ws:A,name:'RA',ready:true,deckValid:true,deckPayload:{main:[],base:[]}},{id:'RB',ws:B,name:'RB',ready:true,deckValid:true,deckPayload:{main:[],base:[]}}],rps:{round:1,choices:new Map(),locked:false},startTimer:null};
 t.rooms.set('ROOM',room);
 t.submitRps(A,{choice:'rock'}); t.submitRps(B,{choice:'scissors'}); t.submitRps(B,{choice:'scissors'});
 assert.equal(context.__timers.length,1);
}

vm.runInContext(';globalThis.__extra={submitMulliganV94,gameStateForV94,handleMessage,startGame,setDeck,setReady,cleanupGames};',context);
const extra=context.__extra;
f=fixture();f.game.phase='mulligan';f.a.mulliganDone=false;f.b.mulliganDone=false;
extra.submitMulliganV94(f.A,{cardIds:['SD01-0001']});
let state=extra.gameStateForV94(f.game,'B');
assert(!('replacementHand' in state.lastAction));assert(!('returnedCardIds' in state.lastAction));
assert(state.events.every(e=>!('replacementHand' in e)&&!('returnedCardIds' in e)));
assert(extra.gameStateForV94(f.game,'A').lastAction.replacementHand.length>0);
extra.submitMulliganV94(f.B,{cardIds:[]});
state=extra.gameStateForV94(f.game,'A');
assert(state.events.filter(e=>e.by==='B').every(e=>!('replacementHand' in e)));
assert(!('hand' in state.opponent));assert(!('deck' in state.self));
for(const raw of ['null','[]','1','"hello"','{}','{']) assert.doesNotThrow(()=>extra.handleMessage(f.A,Buffer.from(raw)));
f=fixture();
const room={code:'R',hostId:'A',activeGameId:'G',players:[{id:'A',ws:f.A,ready:true,deckValid:true,deckPayload:{main:[],base:[]}},{id:'B',ws:f.B,ready:true,deckValid:true,deckPayload:{main:[],base:[]}}]};t.rooms.set('R',room);
extra.startGame(f.A);assert(!room.rps);assert.equal(last(f.A).type,'error');
room.activeGameId=null;extra.startGame(f.A);const rps=room.rps;extra.startGame(f.A);assert.equal(room.rps,rps);
extra.setDeck(f.A,{deck:{main:[],base:[]}});assert.equal(room.players[0].deckValid,true);
extra.setReady(f.A,{ready:false});assert.equal(room.players[0].ready,true);
// Dobermann only pays ranged penalty when bypassing a front operator.
f=fixture();f.a.field[0]='SD01-0004';f.a.fieldEnteredTurn[0]=0;f.b.field[0]='SD01-0001';f.b.field[4]='SD01-0005';
t.attackOperatorV96(f.A,{attackerSlotIndex:0,targetSlotIndex:4});assert.equal(f.game.lastAction.attackerAttack,3);assert.equal(f.game.lastAction.result,'draw');
f=fixture();f.a.field[0]='SD01-0004';f.a.fieldEnteredTurn[0]=0;f.b.field[4]='SD01-0005';
t.attackOperatorV96(f.A,{attackerSlotIndex:0,targetSlotIndex:4});assert.equal(f.game.lastAction.attackerAttack,4);
f=fixture();f.b.grave=['SD01-0001'];assert.equal(extra.gameStateForV94(f.game,'A').opponent.grave[0],'SD01-0001');
f.game.createdAt=1;f.game.lastActivityAt=1;extra.cleanupGames(7*60*60*1000);assert(!t.games.has('G'));
f=fixture();f.a.hand=['SD01-0001','SD01-0002'];
t.gameActionV94(f.A,{action:'deploy_operator',cardId:'SD01-0001',slotIndex:0,expectedRevision:0});
assert.equal(f.a.field[0],null);assert.equal(last(f.A).type,'pvp_error');
t.gameActionV94(f.A,{action:'deploy_operator',cardId:'SD01-0001',slotIndex:0,expectedRevision:1});
const choice=last(f.A).rules.pendingChoice;
assert(choice.id);assert(last(f.B).rules.pendingChoice.waiting);assert(!last(f.B).rules.pendingChoice.options);
t.gameActionV94(f.B,{action:'resolve_choice',choiceId:choice.id,optionIds:[choice.options[0].id]});assert.equal(last(f.B).type,'pvp_error');
const reload=sock('reload');t.clients.set(reload,{id:'reload',roomCode:''});
t.resumeGameV94(reload,{gameId:'G',playerId:'A',reconnectToken:'tok-A'});assert.equal(last(reload).rules.pendingChoice.id,choice.id);
t.gameActionV94(reload,{action:'resolve_choice',choiceId:choice.id,optionIds:[choice.options[0].id],expectedRevision:f.game.revision});
assert.equal(f.a.hand.length,2);assert.equal(f.game.pendingChoice,null);
f=fixture();f.a.hand=['SD01-0001','SD01-0002'];t.gameActionV94(f.A,{action:'deploy_operator',cardId:'SD01-0001',slotIndex:0});
assert(f.game.pendingChoice);t.surrenderV97(f.A,{});assert.equal(f.game.pendingChoice,null);assert.equal(f.game.queue.length,0);
console.log('v98, protocol choices/reconnect and deployment hardening behavioral checks passed');
