'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {once}=require('node:events');
const {createStore,imageType}=require('./card-store'),{createManager}=require('./card-manager');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ntcg-card-manager-test-'));
fs.mkdirSync(path.join(root,'data'),{recursive:true});fs.mkdirSync(path.join(root,'public/images/cards'),{recursive:true});
for(const name of ['cards.json','base-cards.json','card-pool-version.json','starter-decks.json'])fs.copyFileSync(path.join(__dirname,'../data',name),path.join(root,'data',name));
const bytes=fs.readFileSync(path.join(__dirname,'../public/images/cards/SD01-0007.webp'));
const extension=imageType(bytes);
fs.writeFileSync(path.join(root,'public/images/cards/SD01-0007.webp'),bytes);
const store=createStore(root);
const vanilla={id:'SD03-0001',name:'新干员',type:'干员',operatorType:'基础',level:1,attack:2,attackRange:'近战',effect:'无效果。',traits:['测试'],image:''};
const save=(changes=[],images=[],expectedRevision=store.read().revision)=>store.apply({changes,images,expectedRevision});
let server;
async function main(){
 const before=store.read();
 let result=save([{mode:'create',card:vanilla}]);assert.equal(result.state.mainCards.length,before.mainCards.length+1);assert.equal(result.state.mainCards.at(-1).onlineStatus,'ready');assert(fs.existsSync(path.join(result.backup,'data/cards.json')));
 assert.throws(()=>save([{mode:'create',card:vanilla}]),/已存在/);
 const original=store.read().revision;
 assert.throws(()=>save([{mode:'create',card:{...vanilla,id:'SD03-0002'}},{mode:'create',card:{...vanilla,id:'SD03-0002'}}]),/重复/);assert.equal(store.read().revision,original);
 result=save([{mode:'create',card:{...vanilla,id:'SD03-0002',effect:'部署时抽1张牌',onlineStatus:'ready'}}]);assert.equal(result.state.mainCards.at(-1).onlineStatus,'pending');
 const rules=require('../engine/rules')(result.state.mainCards,result.state.baseCards);
 const p=id=>({id,name:id,hand:['SD03-0002'],deck:[],grave:[],baseLife:[],baseDeck:[],baseStack:['SD01-0016'],activeBase:'SD01-0016',field:Array(8).fill(null),fieldEnteredTurn:Array(8).fill(-1),fieldAttackedTurn:Array(8).fill(-1)});
 const game={id:'pending-test',players:[p('A'),p('B')],phase:'main',currentPlayerId:'A',turnSequence:2,playsThisTurn:0};
 assert.throws(()=>rules.execute(game,'A','deploy_operator',{cardId:'SD03-0002',slotIndex:0}),/待接入/);assert.equal(game.players[0].field[0],null);
 assert.throws(()=>save([{mode:'update',card:vanilla}],[],before.revision),/文件已被/);
 result=save([],[{cardId:'SD03-0001',base64:bytes.toString('base64')}]);assert.equal(result.state.mainCards.find(c=>c.id===vanilla.id).image,'/images/cards/SD03-0001.'+extension);assert(fs.existsSync(path.join(root,'public/images/cards/SD03-0001.'+extension)));
 const stock=store.read().mainCards.find(c=>c.id==='SD01-0001');result=save([],[{cardId:stock.id,base64:bytes.toString('base64')}]);assert.notEqual(result.state.mainCards.find(c=>c.id===stock.id).onlineStatus,'pending','image-only updates must not disable implemented effects');
 const stable=store.read().revision;
 assert.throws(()=>save([{mode:'create',card:{...vanilla,id:'../escape'}}]),/ID/);
 assert.throws(()=>save([{mode:'create',card:{...vanilla,id:'SD03-0009',image:'/etc/passwd'}}]),/图片路径/);
 assert.throws(()=>save([],[{cardId:'SD03-0001',base64:Buffer.from('<svg>bad</svg>').toString('base64')}]),/支持/);
 assert.throws(()=>save([],[{cardId:'SD99-9999',base64:bytes.toString('base64')}]),/找不到/);
 assert.equal(store.read().revision,stable);
 // Inject one write failure after the new image; all previously written bytes must be restored.
 const write=fs.writeFileSync;let injected=false;
 try{
  fs.writeFileSync=function(file,...args){if(!injected&&path.resolve(file)===path.join(root,'data/cards.json')){injected=true;throw Error('simulated disk error')}return write.call(this,file,...args)};
  assert.throws(()=>save([{mode:'create',card:{...vanilla,id:'SD03-0099'}}],[{cardId:'SD03-0099',base64:bytes.toString('base64')}]),/disk error/);
 }finally{fs.writeFileSync=write;}
 assert.equal(store.read().revision,stable);assert(!fs.existsSync(path.join(root,'public/images/cards/SD03-0099.'+extension)));
 server=createManager(root);server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 let response=await fetch(base);assert.equal(response.status,200);assert((await response.text()).includes('卡牌工坊'));
 const state=await(await fetch(base+'/api/state')).json();assert(state.token);
 response=await fetch(base+'/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,403);
 response=await fetch(base+'/api/save',{method:'POST',headers:{'Content-Type':'application/json','Origin':'https://example.com','X-Card-Manager-Token':state.token},body:'{}'});assert.equal(response.status,403);
 response=await fetch(base+'/api/save',{method:'POST',headers:{'Content-Type':'application/json','Origin':base,'X-Card-Manager-Token':state.token},body:JSON.stringify({expectedRevision:state.revision,changes:[{mode:'create',card:{...vanilla,id:'SD03-0003'}}]})});assert.equal(response.status,200);assert((await response.json()).changedIds.includes('SD03-0003'));
 response=await fetch(base+'/api/export');assert.equal(response.status,200);assert((await response.json()).mainCards.some(c=>c.id==='SD03-0003'));
 assert.equal((await fetch(base+'/images/cards/SD03-0001.'+extension)).headers.get('content-type'),'image/'+(extension==='jpg'?'jpeg':extension));
 console.log('Card manager checks passed: create/update, images, pending effects, duplicate IDs, stale state, rollback, local API isolation and export');
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(server)await new Promise(r=>server.close(r));const relative=path.relative(os.tmpdir(),root);assert(!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(root,{recursive:true,force:true});});
