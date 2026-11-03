'use strict';
const $=id=>document.getElementById(id);
let state=null,original=null,image=null,dirty=false,batch=null,previewURL=null;
const fields=['id','name','type','level','operatorType','attack','attackRange','profession','tacticType','feature','traits','effect'];
const all=()=>[...state.mainCards,...state.baseCards];
function message(text,error=false){$('message').hidden=false;$('message').textContent=text;$('message').className=error?'error':'';}
function clean(){dirty=false;$('dirty').textContent='没有未保存的修改';}
function changed(){dirty=true;$('dirty').textContent='有未保存的修改';preview();}
function canLeave(){return !dirty||confirm('当前修改尚未保存，确定放弃吗？');}
async function load(){const r=await fetch('/api/state');if(!r.ok)throw Error('读取卡池失败');state=await r.json();$('projectPath').textContent=state.projectPath;renderList();}
function renderList(){
 const q=$('search').value.toLowerCase(),filter=$('filter').value,list=$('list');list.replaceChildren();$('count').textContent=all().length+' 张';
 for(const c of all().filter(c=>(!filter||(filter==='pending'?c.onlineStatus==='pending':c.type===filter))&&[c.id,c.name,c.feature,...(c.traits||[])].join(' ').toLowerCase().includes(q))){
  const b=document.createElement('button');b.type='button';b.className='list-card'+(original?.id===c.id?' active':'');
  const name=document.createElement('b');name.textContent=c.name;const info=document.createElement('small');info.textContent=c.id+' · '+c.type+' · Lv.'+c.level;b.append(name,info);
  if(c.onlineStatus==='pending'){const badge=document.createElement('small');badge.className='pending';badge.textContent='待接入';b.append(badge);}
  b.onclick=()=>{if(canLeave())select(c)};list.append(b);
 }
}
function select(c=null){
 original=c?structuredClone(c):null;image=null;if(previewURL){URL.revokeObjectURL(previewURL);previewURL=null;}
 const values=c||{id:'',name:'',type:'干员',level:1,operatorType:'基础',attack:2,attackRange:'近战',effect:'',traits:[],feature:''};
 const defaults={operatorType:'基础',tacticType:'通常',attackRange:'近战',attack:2,level:1};
 for(const k of fields)$(k).value=k==='traits'?(values[k]||[]).join(', '):values[k]??defaults[k]??'';
 $('id').readOnly=Boolean(c);$('mode').textContent=c?'编辑卡牌':'新建卡牌';$('title').textContent=c?c.name:'新卡牌';$('imageFile').value='';clean();preview();renderList();
}
function draft(){
 const c={...(original||{})};for(const k of fields)c[k]=k==='traits'?$(k).value.split(/[,，]/).map(t=>t.trim()).filter(Boolean):['level','attack'].includes(k)?Number($(k).value):$(k).value.trim();
 if(c.type!=='干员'){for(const k of ['operatorType','attack','attackRange','profession'])delete c[k];}
 if(c.type!=='战术卡')delete c.tacticType;
 for(const k of ['profession','feature'])if(!c[k]&&!Object.hasOwn(original||{},k))delete c[k];
 if(!c.traits.length&&!Object.hasOwn(original||{},'traits'))delete c.traits;
 c.image=image===false?'':original?.image||'';return c;
}
function preview(){
 const c=draft();document.querySelectorAll('.operator').forEach(e=>e.hidden=c.type!=='干员');document.querySelectorAll('.tactic').forEach(e=>e.hidden=c.type!=='战术卡');
 $('previewName').textContent=c.name||'新卡牌';$('previewType').textContent=c.type;$('previewLevel').textContent='Lv.'+c.level;$('previewTraits').textContent=(c.traits||[]).join(' / ');$('previewEffect').textContent=c.effect;$('previewAttack').textContent=c.type==='干员'?'ATK '+c.attack:'';
 const url=image?previewURL:image===false?'':original?.image||'';$('previewImage').hidden=!url;$('textCard').hidden=Boolean(url);if(url)$('previewImage').src=url;
 $('imagePath').textContent=image?'已选择：'+image.name+'（保存时按 ID 自动关联）':c.image||'尚未关联图片';$('jsonPreview').textContent=JSON.stringify(c,null,2);
 const pending=!original||original.onlineStatus==='pending'||fields.some(k=>k!=='image'&&JSON.stringify(c[k])!==JSON.stringify(original[k]));
 $('support').textContent=pending?'规则需确认':'已有联机规则';$('support').className='badge'+(pending?' pending':'');
}
async function encoded(file,cardId){
 if(file.size>8*1024*1024)throw Error(file.name+' 超过8MB，请先压缩。');
 const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(file)});return {cardId,base64};
}
async function save(payload){
 const r=await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json','X-Card-Manager-Token':state.token},body:JSON.stringify({expectedRevision:state.revision,...payload})});const result=await r.json();if(!r.ok)throw Error(result.error||'保存失败');
 const token=state.token,projectPath=state.projectPath;state={...result.state,token,projectPath};renderList();
 message('保存成功，自动备份：'+result.backup+(result.pending.length?'\n效果待接入：'+result.pending.join('、')+'。这些卡牌暂不能用于联机。':'')+'\n本地游戏需重启后读取新数据；线上服务器尚未更新。');return result;
}
$('form').onsubmit=async e=>{e.preventDefault();$('save').disabled=true;try{const c=draft(),images=image?[await encoded(image,c.id)]:[];const result=await save({changes:[{mode:original?'update':'create',card:c}],images});select(all().find(x=>x.id===c.id));}catch(error){message(error.message,true)}finally{$('save').disabled=false}};
for(const k of fields)$(k).addEventListener('input',changed);
$('chooseImage').onclick=()=>$('imageFile').click();$('imageFile').onchange=()=>{const f=$('imageFile').files[0];if(!f)return;if(f.size>8*1024*1024)return message('图片超过8MB，请先压缩。',true);image=f;if(previewURL)URL.revokeObjectURL(previewURL);previewURL=URL.createObjectURL(f);changed()};
$('clearImage').onclick=()=>{image=false;changed()};$('search').oninput=renderList;$('filter').onchange=renderList;$('new').onclick=()=>{if(canLeave())select()};
$('refresh').onclick=async()=>{if(!canLeave())return;try{const id=original?.id;await load();select(all().find(c=>c.id===id)||all()[0]);message('已读取最新文件。')}catch(error){message(error.message,true)}};
$('import').onclick=()=>$('jsonFile').click();$('batchImages').onclick=()=>$('batchFiles').click();
function openBatch(title,description,rows){$('batchTitle').textContent=title;$('batchDescription').textContent=description;$('batchRows').replaceChildren();for(const [left,right] of rows){const row=document.createElement('div');row.className='batch-row';const a=document.createElement('span'),b=document.createElement('small');a.textContent=left;b.textContent=right;row.append(a,b);$('batchRows').append(row)}$('overwriteRow').hidden=batch.kind!=='cards';$('allowOverwrite').checked=false;$('batchDialog').showModal();}
$('jsonFile').onchange=async()=>{try{
 const file=$('jsonFile').files[0];if(!file)return;if(file.size>8*1024*1024)throw Error('JSON 文件超过8MB。');const value=JSON.parse(await file.text());const cards=Array.isArray(value)?value:value.mainCards||value.baseCards?[...(value.mainCards||[]),...(value.baseCards||[])]:[value];if(!cards.length||cards.length>500)throw Error('每批导入1～500张卡牌。');
 batch={kind:'cards',cards};openBatch('导入 '+cards.length+' 张卡牌','检查名称和 ID。重复 ID 默认不覆盖；需要更新时请勾选。',cards.map(c=>[String(c.id||'缺少ID')+' · '+String(c.name||'未命名'),all().some(x=>x.id===c.id)?'已有同 ID':'新增']));
 }catch(error){message(error.message,true)}finally{$('jsonFile').value=''}};
$('batchFiles').onchange=()=>{try{const files=[...$('batchFiles').files];if(!files.length)return;batch={kind:'images',files};openBatch('匹配 '+files.length+' 张卡图','文件名须与现有卡牌 ID 一致，例如 SD01-0001.webp。图片会自动关联，无须手改 JSON。',files.map(f=>{const id=f.name.replace(/\.(webp|png|jpe?g)$/i,'').toUpperCase();return [f.name,all().some(c=>c.id===id)?'匹配：'+all().find(c=>c.id===id).name:'未找到卡牌，将拒绝导入']}))}catch(error){message(error.message,true)}finally{$('batchFiles').value=''}};
$('batchClose').onclick=()=>$('batchDialog').close();
$('batchSave').onclick=async()=>{
 if(!canLeave())return;$('batchSave').disabled=true;try{
  let payload;
  if(batch.kind==='cards'){payload={changes:batch.cards.map(card=>({mode:$('allowOverwrite').checked&&all().some(c=>c.id===card.id)?'update':'create',card}))};}
  else payload={images:await Promise.all(batch.files.map(file=>encoded(file,file.name.replace(/\.(webp|png|jpe?g)$/i,'').toUpperCase())))};
  await save(payload);$('batchDialog').close();select(all().find(c=>c.id===original?.id)||all()[0]);
 }catch(error){message(error.message,true)}finally{$('batchSave').disabled=false}
};
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=''}});
load().then(()=>select(all()[0])).catch(error=>message(error.message,true));
