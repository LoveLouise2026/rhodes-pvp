const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('assert');
const source=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8')+`\n;globalThis.__t={clients,rooms,games,deployOperatorV94,attackOperatorV96,attackPlayerV96,surrenderV97,resumeGameV94,requireGameV94,submitRps,gameActionV94};`;
class FakeServer{on(){} listen(_p,_h,cb){if(cb)cb();}}
class FakeWSS{constructor(){} on(){} handleUpgrade(){} emit(){}}
const context={console:{log(){},error(){}},process:{env:{},cwd:()=>path.join(__dirname,'..')},__dirname:path.join(__dirname,'..'),Buffer,URL,setTimeout:(fn)=>{context.__timers.push(fn);return context.__timers.length;},clearTimeout(){},__timers:[],require:(name)=>{
 if(name==='http') return {createServer:()=>new FakeServer()};
 if(name==='ws') return {WebSocketServer:FakeWSS,WebSocket:{OPEN:1}};
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

console.log('v98 behavioral checks passed');
