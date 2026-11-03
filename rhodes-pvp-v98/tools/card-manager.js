'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createStore,ValidationError}=require('./card-store');
function createManager(root=path.join(__dirname,'..')){
  const store=createStore(root),token=crypto.randomBytes(32).toString('hex');
  const web=path.join(__dirname,'card-manager');
  const reply=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
  const server=http.createServer(async(req,res)=>{
    try{
      const port=server.address().port,host=req.headers.host;
      if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))return reply(res,403,{error:'只允许本机访问。'});
      const url=new URL(req.url,`http://${host}`);
      if(req.method==='GET'&&url.pathname==='/api/state')return reply(res,200,{...store.read(),token,projectPath:store.root});
      if(req.method==='GET'&&url.pathname==='/api/export'){
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="ntcg-card-pool.json"','Cache-Control':'no-store'});const {mainCards,baseCards,version}=store.read();res.end(JSON.stringify({mainCards,baseCards,version},null,2));return;
      }
      if(req.method==='POST'&&url.pathname==='/api/save'){
        if(req.headers.origin!==`http://${host}`||req.headers['x-card-manager-token']!==token)return reply(res,403,{error:'请求来源无效，请在工具页面中操作。'});
        if(!String(req.headers['content-type']).startsWith('application/json'))return reply(res,415,{error:'需要 JSON 请求。'});
        let length=0;const chunks=[];for await(const b of req){length+=b.length;if(length>64*1024*1024)return reply(res,413,{error:'本批次超过64MB，请分批导入。'});chunks.push(b);}
        const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new ValidationError('请求必须是对象。');
        return reply(res,200,store.apply(payload));
      }
      if(req.method!=='GET')return reply(res,405,{error:'不支持该操作。'});
      let file,mime;
      if(url.pathname==='/'||url.pathname==='/index.html'){file=path.join(web,'index.html');mime='text/html; charset=utf-8';}
      else if(['/app.js','/style.css'].includes(url.pathname)){file=path.join(web,url.pathname.slice(1));mime=url.pathname.endsWith('.js')?'application/javascript; charset=utf-8':'text/css; charset=utf-8';}
      else if(/^\/images\/cards\/[A-Z0-9][A-Z0-9_-]{1,63}\.(webp|png|jpg|jpeg)$/.test(url.pathname)){
        file=path.join(root,'public',url.pathname.slice(1));mime=url.pathname.endsWith('.webp')?'image/webp':url.pathname.endsWith('.png')?'image/png':'image/jpeg';
      }else return reply(res,404,{error:'未找到。'});
      if(!fs.existsSync(file))return reply(res,404,{error:'文件不存在。'});
      res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'"});
      res.end(fs.readFileSync(file));
    }catch(error){reply(res,error instanceof ValidationError||error instanceof SyntaxError?400:500,{error:error instanceof ValidationError||error instanceof SyntaxError?error.message:'保存失败；请检查文件权限。原数据已保留。'});}
  });
  return server;
}
if(require.main===module){const server=createManager();server.listen(Number(process.env.CARD_MANAGER_PORT||3210),'127.0.0.1',()=>{
  const url=`http://127.0.0.1:${server.address().port}`;
  console.log(`卡牌工坊已启动：${url}\n保存到：${path.join(__dirname,'..')}\n关闭此窗口即可停止工具；修改不会自动更新线上服务器。`);
  if(process.env.CARD_MANAGER_OPEN==='1'&&process.platform==='win32')require('node:child_process').spawn('cmd.exe',['/c',`start "" "${url}"`],{windowsHide:true,stdio:'ignore'});
});server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'3210端口已被占用；请关闭旧工具或设置 CARD_MANAGER_PORT。':error.message);process.exitCode=1;});}
module.exports={createManager};
