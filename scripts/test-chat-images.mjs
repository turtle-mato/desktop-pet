// Isolated production HTTP route, attachment persistence and actual multimodal wire.
// --live forwards to configured model, never writes the user's dialogue/memories.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const live=process.argv.includes('--live');
if(!fs.existsSync(path.join(root,'work/image-fixtures/chinese-chat.png'))){
 const made=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/create-image-fixtures.ps1')],{windowsHide:true,encoding:'utf8'});
 assert.equal(made.status,0,made.stderr);
}
const run=fs.mkdtempSync(path.join(root,'work',live?'image-live-':'image-api-'));
const mind=path.join(run,'mind');fs.mkdirSync(mind,{recursive:true});
fs.cpSync(path.resolve(root,'../mind/server'),path.join(mind,'server'),{recursive:true});
const docs=path.resolve(root,'../mind/docs/设定/林阅心.md');
if(fs.existsSync(docs)){fs.mkdirSync(path.join(mind,'docs/设定'),{recursive:true});fs.copyFileSync(docs,path.join(mind,'docs/设定/林阅心.md'));}
const original=JSON.parse(fs.readFileSync(path.resolve(root,'../mind/config.json'),'utf8'));
const fixture=fs.readFileSync(path.join(root,'work/image-fixtures/shapes.png'));
const image='data:image/png;base64,'+fixture.toString('base64');
const expected=JSON.parse(fs.readFileSync(path.join(root,'work/image-fixtures/expected.json'),'utf8'));
const {parseChatImage,saveChatImage,loadChatImage,withChatImages}=await import(pathToFileURL(path.join(mind,'server/lib/attachments.ts')));
assert.deepEqual(parseChatImage(image).buffer,fixture);
assert.equal(parseChatImage('data:image/jpeg;base64,'+fixture.toString('base64')).mime,'image/png','actual bytes determine MIME');
for(const bad of [1,{},'bad','data:image/svg+xml;base64,PHN2Zz4=','a'.repeat(12*1024*1024),Buffer.from('not an image at all').toString('base64')])assert.throws(()=>parseChatImage(bad));
assert.equal(loadChatImage('../config.json'),undefined);
const saved=saveChatImage(parseChatImage(image));assert.equal(loadChatImage(saved.id),image);
assert.equal(saveChatImage(parseChatImage(image)).id,saved.id);
assert.equal(saved.id,crypto.createHash('sha256').update(fixture).digest('hex'));
const many=withChatImages(Array.from({length:18},()=>({role:'user',content:'image',imageId:saved.id})));
assert.equal(many.filter(m=>m.images?.length).length,3);
assert.ok(many[0].content.includes('未附带'));
assert.match(withChatImages([{role:'user',content:'old',imageId:'a'.repeat(64)}])[0].content,/不可用/);
let rejectImages=false;
const captures=[],results=[];
const upstream=createServer(async(req,res)=>{
 try {
  let data='';for await(const c of req)data+=c;
  const body=JSON.parse(data);captures.push(body);
  if(rejectImages){res.writeHead(400);res.end('This model does not support image inputs');return;}
  if(live){
   const b=original.llm.baseUrl.replace(/\/+$/,'').replace(/\/v1$/,'');
   const reply=await fetch(b+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+original.llm.apiKey},body:JSON.stringify({...body,model:original.llm.model}),signal:AbortSignal.timeout(120_000)});
   res.writeHead(reply.status,{'content-type':reply.headers.get('content-type')||'text/event-stream'});
   for await(const c of reply.body)res.write(c);res.end();
  } else {
   const reviewing=body.messages[0].content.includes('你在为同一个聊天角色核对本轮回复');
   res.writeHead(200,{'content-type':'text/event-stream'});
   res.end('data: '+JSON.stringify({choices:[{delta:{content:reviewing?'已核对原图':'已收到原图'}}]})+'\n\ndata: [DONE]\n\n');
  }
 }catch(e){res.writeHead(502);res.end('Test upstream error: '+e.message);}
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const cfg=structuredClone(original);
Object.assign(cfg,{host:'127.0.0.1',port,token:'isolated-image-test',startupGraceMinutes:999999,idleMinutes:999999});
cfg.llm={...cfg.llm,mode:'deepseek',baseUrl:'http://127.0.0.1:'+upstream.address().port+'/v1',apiKey:'test-only'};
if(!live)cfg.llm.thinking='off';
cfg.search={...cfg.search,auto:false,apiKey:''};cfg.habits={...cfg.habits,enabled:false};cfg.proactive={...cfg.proactive,enabled:false};
fs.writeFileSync(path.join(mind,'config.json'),JSON.stringify(cfg));
const headers={'Content-Type':'application/json',Authorization:'Bearer isolated-image-test'};
const base='http://127.0.0.1:'+port;
let child,log='';
async function launch(){
 child=spawn(process.execPath,['server/server.ts'],{cwd:mind,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,MIND_PORT:String(port),MIND_TOKEN:'isolated-image-test',MIND_LLM_MODE:'deepseek',DEEPSEEK_API_KEY:'test-only'}});
 child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
 for(let i=0;i<100;i++){try{if((await(await fetch(base+'/v1/health')).json()).ok)return;}catch{}await new Promise(r=>setTimeout(r,60));}
 throw Error('Isolated server did not start: '+log.slice(-500));
}
async function stop(){if(child?.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}}
const rows=()=>fs.readdirSync(path.join(mind,'data/raw')).filter(f=>f.endsWith('.jsonl')).flatMap(f=>fs.readFileSync(path.join(mind,'data/raw',f),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
const imagesIn=body=>body.messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(c=>c.type==='image_url'):[]);
async function send(text,session_id,img,channel='pet'){
 const res=await fetch(base+'/v1/message',{method:'POST',headers,body:JSON.stringify({text,session_id,channel,...(img?{image:img}:{})}),signal:AbortSignal.timeout(240_000)});
 assert.equal(res.status,200);
 const s=await res.text();const events=s.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)));
 const final=events.find(e=>e.final)?.final;assert.ok(final?.text,JSON.stringify(events));
 results.push({question:text,answer:final.text});console.log(JSON.stringify(results.at(-1)));
 return final;
}
try{
 await launch();
 const first=await send('请认真看原图，依次说出最上方的完整字母数字串，以及下方三个图形从左到右的颜色和形状。不要省略任何一项。','main',image);
 assert.equal(first.image_received,true);assert.equal(first.image_id,saved.id);
 const wire=imagesIn(captures[0]);assert.equal(wire.length,1);assert.equal(wire[0].image_url.url,image);assert.equal(wire[0].image_url.detail,'high');
 assert.ok(!JSON.stringify(captures[0]).includes('imageId'));
 const user=rows().find(m=>m.role==='user');assert.equal(user.imageId,saved.id);
 assert.ok(!JSON.stringify(rows()).includes(fixture.toString('base64')));
 if(live){assert.ok(first.text.includes(expected.code),'must read random code existing ONLY in image');assert.match(first.text,/红.*方|红.*矩形/);assert.match(first.text,/蓝.*圆/);assert.match(first.text,/绿.*三角/);}
 const next=await send('我刚才那张图，最右边的图形是什么颜色和形状？','mini');
 assert.equal(imagesIn(captures.at(-1))[0].image_url.url,image,'cross-window follow-up sees original');
 if(live)assert.match(next.text,/绿.*三角/);
 await stop();await launch();
 const restart=await send('你刚才看过的图，上面的完整字母数字串是什么？不要猜。','mini');
 assert.ok(imagesIn(captures.at(-1)).some(c=>c.image_url.url===image),'restart restores actual image reference');
 if(live)assert.ok(restart.text.includes(expected.code));
 const before=captures.length;
 await send('我说的是图里面的内容。重新看原图，说出中间图形的颜色和形状。','main',image);
 assert.equal(captures.length,before+2,'correction review also runs');
 assert.ok(captures.slice(before).every(c=>imagesIn(c).some(i=>i.image_url.url===image)),'draft AND review see original');
 await send('','mini',image);
 assert.equal(rows().filter(m=>m.role==='user').at(-1).text,'[图片]');
 const count=rows().length;
 const invalid=await fetch(base+'/v1/message',{method:'POST',headers,body:JSON.stringify({text:'invalid should not persist',image:'broken'})});
 assert.equal(invalid.status,400);assert.equal(rows().length,count);
 await send('只回答你好','main',undefined,'other-test-channel');
 assert.equal(imagesIn(captures.at(-1)).length,0,'other channels cannot inherit attachments');
 if(live){
  const chinese='data:image/png;base64,'+fs.readFileSync(path.join(root,'work/image-fixtures/chinese-chat.png')).toString('base64');
  const chat=await send('看这张聊天截图，双方分别说了什么？最后一句有接住前一句意思吗？简短说明。','main',chinese,'chinese-test');
  assert.match(chat.text,/角色/);assert.match(chat.text,/睡/);assert.match(chat.text,/没|不|偏|无关|跳|转/);
  assert.ok(imagesIn(captures.at(-1)).some(c=>c.image_url.url===chinese));
 }
 rejectImages=true;
 const bad=await fetch(base+'/v1/message',{method:'POST',headers,body:JSON.stringify({text:'unsupported image request',image,channel:'fail-test'})});
 const failure=await bad.text();assert.match(failure,/does not support image/);assert.ok(!failure.includes('"final"'));
 assert.ok(!log.includes(fixture.toString('base64')),'image bytes never in server logs');
 fs.writeFileSync(path.join(run,'report.json'),JSON.stringify({live,model:live?original.llm.model:'test-only',results,requests:captures.map(c=>({images:imagesIn(c).length,review:c.messages[0].content.includes('你在为同一个聊天角色核对本轮回复')}))},null,2));
 console.log('PASS: original bytes, MIME, bounded hydration, upload/image-only, review, cross-window, restart, invalid rejection, channel isolation, provider errors. '+run);
}finally{await stop();await new Promise(r=>upstream.close(r));}
