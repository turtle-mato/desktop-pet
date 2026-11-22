// Full real HTTP/SSE routing, isolated filesystem and fake upstream model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const run=fs.mkdtempSync(path.join(root,'work','conversation-api-'));
const mind=path.join(run,'mind');fs.mkdirSync(mind,{recursive:true});
fs.cpSync(path.resolve(root,'../mind/server'),path.join(mind,'server'),{recursive:true});
const skillDir=path.join(mind,'docs','skills','dialogue');fs.mkdirSync(skillDir,{recursive:true});
fs.copyFileSync(path.resolve(root,'../mind/docs/skills/dialogue/SKILL.md'),path.join(skillDir,'SKILL.md'));
const capture=[],reviews=[],avatarCalls=[];
const upstream=createServer(async(req,res)=>{
 let data='';for await(const c of req)data+=c;
 const body=JSON.parse(data);
 if(body.messages[0].content.includes('你现在决定自己的立绘动作')){
  avatarCalls.push(body.messages);
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify({observation:'白裙半身立绘',emotion:'soft',intensity:.8,durationMs:4000,motion:'nod',gaze:'center'})}}]})+'\n\ndata: [DONE]\n\n');return;
 }
 const reviewing=body.messages.some(m=>m.role==='system'&&String(m.content).includes('下面只是未展示的候选回复'));
 const bucket=reviewing?reviews:capture;bucket.push(body.messages);const n=bucket.length;
 if(n===2&&!reviewing)await new Promise(r=>setTimeout(r,160));
 res.writeHead(200,{'content-type':'text/event-stream'});
  res.end('data: '+JSON.stringify({choices:[{delta:{content:(reviewing?'隔离测试回复':'未经复核的草稿')+(n===1?'\n\n':'')+n}}]})+'\n\ndata: [DONE]\n\n');
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const cfg=JSON.parse(fs.readFileSync(path.resolve(root,'../mind/config.json'),'utf8'));
Object.assign(cfg,{port,host:'127.0.0.1',token:'isolated-test-token',startupGraceMinutes:99999,idleMinutes:99999});
cfg.llm={...cfg.llm,mode:'deepseek',baseUrl:'http://127.0.0.1:'+upstream.address().port+'/v1',apiKey:'test-only',thinking:'off'};
cfg.search={...cfg.search,auto:false,apiKey:''};cfg.habits={...cfg.habits,enabled:false};cfg.proactive={...cfg.proactive,enabled:false};
fs.writeFileSync(path.join(mind,'config.json'),JSON.stringify(cfg));
const date=new Date().toLocaleDateString('sv-SE');
fs.mkdirSync(path.join(mind,'data/raw'),{recursive:true});
const rawFile=path.join(mind,'data/raw',date+'.jsonl');
const now=Date.now();
const seed=[
 {id:'source_1',ts:now-5000,role:'pet',text:'然后就美美得吃了，听着就很幸福~',channel:'pet',origin:{kind:'screen',at:now-5000}},
 {id:'test_1',ts:now-4000,role:'user',text:'我是在测试上下文',channel:'pet'},
 {id:'test_2',ts:now-3000,role:'pet',text:'那你把截图念出来',channel:'pet'},
 {id:'test_3',ts:now-2000,role:'pet',text:'',channel:'pet'},
 {id:'test_4',ts:now-1000,role:'user',text:'其他通道的秘密',channel:'qq'},
];
fs.writeFileSync(rawFile,seed.map(r=>JSON.stringify(r)).join('\n')+'\n');
let child,log='';
const base='http://127.0.0.1:'+port;
const headers={'Content-Type':'application/json',Authorization:'Bearer isolated-test-token'};
async function launch(){
 child=spawn(process.execPath,['server/server.ts'],{cwd:mind,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,MIND_PORT:String(port),MIND_TOKEN:'isolated-test-token',DEEPSEEK_API_KEY:'test-only',MIND_LLM_MODE:'deepseek'}});
 child.stdout.on('data',d=>{log+=String(d)});child.stderr.on('data',d=>{log+=String(d)});
 for(let i=0;i<100;i++){try{if((await(await fetch(base+'/v1/health')).json()).ok)return;}catch{};if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,60));}
 throw Error('Isolated server failed: '+log.slice(-1200));
}
async function stop(){if(child&&child.exitCode===null){const p=new Promise(r=>child.once('exit',r));child.kill();await p;}}
async function message(text,session_id,channel='pet'){
 const res=await fetch(base+'/v1/message',{method:'POST',headers,body:JSON.stringify({text,channel,session_id})});
 assert.equal(res.status,200);const s=await res.text();
 const final=s.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6))).find(r=>r.final)?.final;
 assert.ok(final?.text,s);assert.ok(!s.includes('未经复核的草稿'),'错误草稿绝不先流给用户');
 const events=s.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)));
 assert.ok(events.every(e=>!e.delta||!/[\r\n]/.test(e.delta)),'流式回复也不分段');
 assert.ok(!/[\r\n]/.test(final.text),'最终回复合为一段');return final;
}
try{
 await launch();
 assert.equal((await fetch(base+'/v1/screen-day')).status,401,'日记接口必须鉴权');
 const observation={capturedAt:Date.now(),pageType:'coding',summary:'编辑器里正在调整桌宠的手动读屏按钮'};
 const posted=await (await fetch(base+'/v1/screen-day/observation',{method:'POST',headers,body:JSON.stringify(observation)})).json();
 assert.equal(posted.recorded,true);
 const diary=await (await fetch(base+'/v1/screen-day',{headers})).json();assert.equal(diary.count,1);assert.match(diary.summary,/手动读屏按钮/);
 assert.equal((await (await fetch(base+'/v1/screen-day/observation',{method:'POST',headers,body:JSON.stringify({...observation,image:'forbidden'})})).json()).recorded,false);
 const firstReply=await message('我念什么啊？','main');
 assert.equal(firstReply.text,'隔离测试回复1','复核器带空行的回复也会规范为一段');
 assert.ok(!capture[0].some(m=>m.content==='其他通道的秘密'),'不混入其他channel');
 assert.ok(!capture[0].some(m=>m.content===''),'不发送空回复');
 assert.equal(capture[0].filter(m=>m.content==='我念什么啊？').length,1,'当前用户消息只发一次');
 assert.match(capture[0][0].content,/服务端记录.*主动发言来源/);
 assert.match(capture[0][0].content,/当时的前台屏幕观察/);
 assert.match(reviews[0][0].content,/当时的前台屏幕观察/,'review keeps provenance too');
 assert.ok(capture[0][0].content.includes('【对话skill：接梗与轻抗议】'),'真实HTTP生成链路加载对话skill');
 assert.ok(reviews[0][0].content.includes('【对话skill：接梗与轻抗议】'),'真实HTTP复核链路保留轻抗议，不抹平成说明书');
 assert.ok(capture[0].every(m=>Object.keys(m).every(k=>['role','content'].includes(k))),'internal origin never sent as extra provider fields');
 const a=message('你刚才的提议不是我的承诺','main');
 await new Promise(r=>setTimeout(r,20));
 const b=message('复述你的上一句','mini');
 await Promise.all([a,b]);
 assert.ok(capture[2].some(m=>m.role==='assistant'&&m.content==='隔离测试回复2'),'并发小窗必须读到主窗最新回复');
 const before=fs.readFileSync(rawFile,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(before.filter(m=>m.role==='user'&&m.channel==='pet').length,4);
 assert.equal(before.filter(m=>m.text==='隔离测试回复2').length,1,'assistant只落库一次');
 await stop();await launch();
 assert.equal((await (await fetch(base+'/v1/screen-day',{headers})).json()).count,1,'重启保留独立日记');
 await message('复述我的上上句话','mini');
 const messages=capture.at(-1);
 assert.ok(messages.some(m=>m.role==='assistant'&&m.content==='隔离测试回复3'),'重启后上下文从落库恢复');
 assert.match(messages[0].content,/目标原文.*你刚才的提议不是我的承诺/,'复述只数用户消息');
 assert.match(messages[0].content,/当时的前台屏幕观察/,'origin survives restart and cross-window followups');
 const denied=await fetch(base+'/v1/message',{method:'POST',headers:{...headers,Authorization:'Bearer wrong'},body:JSON.stringify({text:'不应落库'})});
 assert.equal(denied.status,401);
 const final=fs.readFileSync(rawFile,'utf8');assert.ok(!final.includes('不应落库'));
 assert.ok(!final.includes('未经复核的草稿'),'只落最终回复，不存未展示的草稿');assert.equal(reviews.length,4);
 const skipped=await(await fetch(base+'/v1/proactive/topic',{method:'POST',headers,body:JSON.stringify({channel:'pet',session_id:'mini',reason:'idle'})})).json();assert.equal(skipped.skip,true);
 assert.equal(fs.readFileSync(rawFile,'utf8'),final,'跳过主动消息不落库');
 const state={at:Date.now(),available:true,view:'upper',emotion:'cheerful'};
 assert.equal((await fetch(base+'/v1/avatar/act',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state})})).status,401);
 const plan=await(await fetch(base+'/v1/avatar/act',{method:'POST',headers,body:JSON.stringify({state,text:'点个头',image:'data:image/jpeg;base64,YQ=='})})).json();
 assert.equal(plan.seen,true);assert.equal(plan.action.motion,'nod');assert.equal(avatarCalls.length,1);
 assert.equal(avatarCalls[0].at(-1).content[1].image_url.url,'data:image/jpeg;base64,YQ==','真实图像独立传给模型');
 assert.equal(fs.readFileSync(rawFile,'utf8'),final,'自画像与动作不落库');
 assert.equal((await fetch(base+'/v1/avatar/runtime')).status,401);
 const inspect=async(endpoint,body)=>(await fetch(base+'/v1/avatar/runtime'+endpoint,{method:'POST',headers,body:JSON.stringify(body)})).json();
 const queued=await inspect('/check',{action:plan.action});
 const hidden=await inspect('',{label:'main',visible:false,kind:'live2d',state});
 assert.equal(hidden.job,null,'隐藏窗不能接动作');
 const shown=await inspect('',{label:'mini',visible:true,kind:'live2d',state});
 assert.equal(shown.job.id,queued.id);
 assert.equal((await inspect('',{label:'mini',visible:true,state})).job,null,'检查动作只执行一次');
 await inspect('/result',{id:queued.id,label:'mini',result:{status:'executed'},state});
 const runtime=await(await fetch(base+'/v1/avatar/runtime',{headers})).json();
 assert.equal(runtime.result.id,queued.id);assert.equal(runtime.windows.length,2);
 assert.equal(fs.readFileSync(rawFile,'utf8'),final,'运行检查不产生聊天或记忆');
 const feedback={state:{...state,at:Date.now(),emotion:'soft'},status:'observed',seen:true,observation:plan.observation,image:'data:image/jpeg;base64,YQ=='};
 const reply=await fetch(base+'/v1/message',{method:'POST',headers,body:JSON.stringify({text:'我念什么啊？',session_id:'mini',avatar:feedback})});
 const stream=await reply.text();
 assert.ok(capture.at(-1)[0].content.includes('当前立绘运行反馈'));
 assert.ok(reviews.at(-1)[0].content.includes('当前立绘运行反馈'),'回复复核同样保留执行证据');
 for(const messages of [capture.at(-1),reviews.at(-1)]) assert.ok(messages.some(m=>Array.isArray(m.content)&&
   m.content.some(p=>p.type==='image_url'&&p.image_url.url===feedback.image)),'生成和复核均能看当前立绘原图');
 assert.ok(!stream.includes('白裙半身立绘'),'控制字段未泄漏到正文');
 assert.ok(!fs.readFileSync(rawFile,'utf8').includes('白裙半身立绘'),'观察与回执未进入记忆');
 assert.ok(!fs.readFileSync(rawFile,'utf8').includes('data:image/jpeg'),'自我观察图像不落正式聊天');
 console.log('conversation API: 实际HTTP/SSE、主小窗并发顺序、角色/空回复/通道隔离、只落库一次、重启恢复、精确指代、鉴权、主动SKIP通过（仅隔离数据）');
 console.log('Artifacts: '+run);
}finally{await stop();await new Promise(r=>upstream.close(r));}
