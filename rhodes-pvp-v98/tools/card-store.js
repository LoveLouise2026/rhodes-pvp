'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ID = /^[A-Z0-9][A-Z0-9_-]{1,63}$/;
const IMAGE = /^\/images\/cards\/[A-Z0-9][A-Z0-9_-]{1,63}\.(webp|png|jpg|jpeg)$/;
class ValidationError extends Error {}
const check = (ok, message) => { if (!ok) throw new ValidationError(message); };
function imageType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes.length >= 16 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP') return 'webp';
  if (bytes.length >= 4 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255 && bytes.at(-2)===255 && bytes.at(-1)===217) return 'jpg';
  throw new ValidationError('图片内容不是受支持的 PNG、JPEG 或 WebP。');
}
function createStore(root) {
  root = path.resolve(root);
  const dataDir = path.join(root,'data'), imageDir = path.join(root,'public/images/cards');
  const files = ['cards.json','base-cards.json','card-pool-version.json'];
  function read() {
    const raw = files.map(f => fs.readFileSync(path.join(dataDir,f)));
    const hash = crypto.createHash('sha256'); raw.forEach(b => hash.update(b));
    for (const name of fs.readdirSync(imageDir).sort()) {
      if (/\.(webp|png|jpe?g)$/i.test(name)) hash.update(name).update(fs.readFileSync(path.join(imageDir,name)));
    }
    return { mainCards:JSON.parse(raw[0]), baseCards:JSON.parse(raw[1]), version:JSON.parse(raw[2]), revision:hash.digest('hex') };
  }
  function validateCard(c) {
    check(c && typeof c==='object' && !Array.isArray(c),'卡牌必须是 JSON 对象。');
    check(ID.test(c.id),'ID 只能包含大写字母、数字、下划线和连字符，长度2～64。');
    check(typeof c.name==='string' && c.name.trim().length>0 && c.name.length<=80,`${c.id}：名称不能为空或超过80字符。`);
    check(['干员','战术卡','基地卡'].includes(c.type),`${c.id}：类型须为干员、战术卡或基地卡。`);
    check(Number.isInteger(c.level) && c.level>=1 && c.level<=3,`${c.id}：等级须为1、2或3。`);
    check(typeof c.effect==='string' && c.effect.trim().length>0 && c.effect.length<=6000,`${c.id}：请填写效果；无效果干员填写“无效果”。`);
    check(c.traits===undefined || (Array.isArray(c.traits) && c.traits.length<=20 && c.traits.every(t=>typeof t==='string'&&t.length<=80)),`${c.id}：特征须为文字数组。`);
    for (const name of ['feature','profession','image','triggerCondition']) check(c[name]===undefined || (typeof c[name]==='string' && c[name].length<=400),`${c.id}：${name} 须为文字。`);
    if(c.type==='干员') {
      check(['基础','精英化'].includes(c.operatorType),`${c.id}：请选择基础或精英化干员。`);
      check(Number.isInteger(c.attack)&&c.attack>=0&&c.attack<=99,`${c.id}：攻击力须为0～99的整数。`);
      check(['近战','远程'].includes(c.attackRange),`${c.id}：攻击范围须为近战或远程。`);
    }
    if(c.type==='战术卡') check(['通常','陷阱'].includes(c.tacticType),`${c.id}：请选择通常或陷阱战术。`);
    check(!c.image || IMAGE.test(c.image),`${c.id}：图片路径须为 /images/cards/卡牌ID.webp（也支持 png/jpg/jpeg）。`);
    // Prevent malformed future metadata from silently changing boolean/numeric engine keywords.
    for(const name of ['cannotAttack','forceAttackTarget','forceAttackTargetWhenFront','canAttackAsRanged']) check(c[name]===undefined||typeof c[name]==='boolean',`${c.id}：${name} 须为布尔值。`);
    if(c.maxAttacksPerTurn!==undefined)check(Number.isInteger(c.maxAttacksPerTurn)&&c.maxAttacksPerTurn>=1&&c.maxAttacksPerTurn<=9,`${c.id}：每回合攻击次数须为1～9。`);
    if(c.rangedAttackModifier!==undefined)check(Number.isInteger(c.rangedAttackModifier)&&Math.abs(c.rangedAttackModifier)<=99,`${c.id}：远程修正须为整数。`);
    check(!['__proto__','prototype','constructor'].some(k=>Object.hasOwn(c,k)),`${c.id}：含不允许的元数据字段。`);
  }
  function support(c, existing) {
    const normalized = v => Object.fromEntries(Object.entries(v).filter(([k])=>!['image','onlineStatus'].includes(k)).sort(([a],[b])=>a.localeCompare(b)));
    if(existing && existing.onlineStatus!=='pending' && JSON.stringify(normalized(existing))===JSON.stringify(normalized(c))) return existing.onlineStatus;
    const pureNew = !existing && c.type==='干员' && c.operatorType==='基础' && /^无效果[。.]?$/.test(c.effect.trim()) && !['cannotAttack','forceAttackTarget','forceAttackTargetWhenFront','canAttackAsRanged','maxAttacksPerTurn','rangedAttackModifier'].some(k=>c[k]);
    return pureNew ? 'ready' : 'pending';
  }
  function apply(payload) {
    const before=read();
    check(payload.expectedRevision===before.revision,'文件已被其他操作修改，请刷新列表后重试，未保存任何内容。');
    const changes=payload.changes||[], images=payload.images||[];
    check(Array.isArray(changes)&&Array.isArray(images)&&changes.length+images.length>0&&changes.length<=500&&images.length<=100,'每次最多导入500张卡牌、100张图片。');
    const map=new Map([...before.mainCards,...before.baseCards].map(c=>[c.id,c]));
    const ids=new Set(), imageIds=new Set(), writes=new Map();
    for(const change of changes){
      const c=JSON.parse(JSON.stringify(change.card));validateCard(c);check(!ids.has(c.id),`批次中 ID 重复：${c.id}`);ids.add(c.id);
      const old=map.get(c.id);check(['create','update'].includes(change.mode),'导入模式不正确。');
      check(change.mode==='create'?!old:Boolean(old),old?`${c.id} 已存在；请明确选择更新已有卡。`:`${c.id} 不存在，不能更新。`);
      const status=support(c,old);if(status)c.onlineStatus=status;else delete c.onlineStatus;
      map.set(c.id,c);
    }
    for(const image of images){
      check(ID.test(image.cardId)&&map.has(image.cardId),`找不到图片对应的卡牌：${image.cardId}`);
      check(!imageIds.has(image.cardId),`${image.cardId} 本批次有多张图片，请只保留一张。`);imageIds.add(image.cardId);
      check(typeof image.base64==='string'&&image.base64.length<=12*1024*1024&&/^[A-Za-z0-9+/]*={0,2}$/.test(image.base64),'图片编码不合法或超过8MB。');
      const bytes=Buffer.from(image.base64,'base64');check(bytes.length>0&&bytes.length<=8*1024*1024,'单张图片不能超过8MB。');
      const ext=imageType(bytes), filename=`${image.cardId}.${ext}`;
      writes.set(path.join(imageDir,filename),bytes);
      map.set(image.cardId,{...map.get(image.cardId),image:'/images/cards/'+filename});
    }
    for(const c of map.values())if(c.image)check(writes.has(path.join(root,'public',c.image.slice(1)))||fs.existsSync(path.join(root,'public',c.image.slice(1))),`${c.id}：图片不存在，请同时导入图片或清空路径。`);
    const mainCards=[...map.values()].filter(c=>c.type!=='基地卡'),baseCards=[...map.values()].filter(c=>c.type==='基地卡');
    try { require('../public/starter-decks').validate(JSON.parse(fs.readFileSync(path.join(dataDir,'starter-decks.json'),'utf8')),mainCards,baseCards); }
    catch(error) { throw new ValidationError('这次修改会破坏已有预组：'+error.message); }
    const version={...before.version,version:'cards-'+new Date().toISOString(),mainCards:mainCards.length,baseCards:baseCards.length,sets:[...new Set([...map.keys()].map(id=>id.split('-')[0]))].sort()};
    const json=v=>Buffer.from(JSON.stringify(v,null,2)+'\n');
    writes.set(path.join(dataDir,'cards.json'),json(mainCards));writes.set(path.join(dataDir,'base-cards.json'),json(baseCards));writes.set(path.join(dataDir,'card-pool-version.json'),json(version));
    // Back up all affected bytes before writing; errors restore the previous complete state.
    const backup=path.join(root,'.card-manager/backups',new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex'));
    fs.mkdirSync(backup,{recursive:true});const originals=new Map();
    for(const file of writes.keys()){
      const bytes=fs.existsSync(file)?fs.readFileSync(file):null;originals.set(file,bytes);
      if(bytes){const dest=path.join(backup,path.relative(root,file));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes);}
    }
    fs.writeFileSync(path.join(backup,'manifest.json'),JSON.stringify({revision:before.revision,files:[...writes.keys()].map(f=>({path:path.relative(root,f),existed:originals.get(f)!==null}))},null,2));
    const written=[];
    try{for(const [file,bytes]of writes){fs.mkdirSync(path.dirname(file),{recursive:true});written.push(file);fs.writeFileSync(file,bytes);}}
    catch(error){for(const file of written.reverse()){const old=originals.get(file);if(old===null){if(fs.existsSync(file))fs.unlinkSync(file);}else fs.writeFileSync(file,old);}throw error;}
    return {state:read(),backup,changedIds:[...new Set([...ids,...imageIds])],pending:[...ids].filter(id=>map.get(id).onlineStatus==='pending')};
  }
  return {read,apply,root,ValidationError};
}
module.exports={createStore,ValidationError,imageType};
