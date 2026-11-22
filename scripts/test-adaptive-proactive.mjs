import assert from 'node:assert/strict';import{fileURLToPath}from'node:url';
import{tsLoader,fakeDate,flush}from'./test-utils.mjs';
const path=n=>fileURLToPath(new URL(n,import.meta.url));
let clock=new Date(2026,10,11,12).getTime(),state,calls=0,messages,delay=0;
const load=tsLoader({
 './store.ts':{loadState:()=>state,saveState:p=>Object.assign(state,p),loadEpisodic:()=>[],loadEmotional:()=>[],loadVectors:()=>[]},
 './llm.ts':{chatStream:async(_cfg,input)=>{calls++;messages=input;clock+=delay;return{text:'这一集的标题还挺会吊胃口的。'};}},
 './persona.ts':{personaBase:()=>'',selfBlock:()=>''},'./retrieve.ts':{openThreads:()=>[]},
 './paths.ts':{dateStr:()=> '2026-11-11'},'./embed.ts':{embedAvailable:()=>false},
 },{Date:fakeDate(()=>clock)});
const{generateProactive}=load(path('../../mind/server/lib/proactive.ts'));
const{backgroundMediaEvidence}=load(path('../../mind/server/lib/screen.ts'));
const config={proactive:{enabled:true,maxPerDay:5,minGapMinutes:30,quietStartHour:0,quietEndHour:0,repeatDays:3,recallRatio:0,
 coView:{enabled:true,minGapMinutes:2,maxPerDay:20,repeatMinutes:10}},llm:{}};
function reset(){state={topicHistory:[],lastActivityTs:clock,lastProactiveAt:0};calls=0;delay=0;}
const media=()=>({title:'测试番剧 第三集',source:'browser.bilibili',kind:'video',playing:true,observedAt:clock});
const req=()=>({reason:'screen',screen:'系统媒体会话确认视频正在播放，仅有标题',screenKey:'media:test',screenCapturedAt:clock,attentionMode:'entertainment',backgroundMedia:media()});
reset();
const emptyState=JSON.stringify(state);
for (const input of [{reason:'idle'},{reason:'askActivity'},{reason:'todoNag',todoOpen:0},
  {reason:'todoNag',todoOpen:2,todoFirst:'整理文档',history:[{role:'user',content:'有病'}]}]) {
 assert.equal((await generateProactive(input,config)).skip,true,JSON.stringify(input));
 assert.equal(calls,0,'无具体由头或用户拒绝时不调用模型');assert.equal(JSON.stringify(state),emptyState,'跳过不写话题状态');
}
let request=req();assert.ok(backgroundMediaEvidence(request,clock));
for(const patch of [{playing:false},{kind:'music'},{observedAt:clock-21000},{observedAt:clock+1},{title:'password secret'},{source:''},{title:'x'.repeat(161)}]) {
 assert.equal(backgroundMediaEvidence({...request,backgroundMedia:{...request.backgroundMedia,...patch}},clock),null);
 assert.equal((await generateProactive({...request,backgroundMedia:{...request.backgroundMedia,...patch}},config)).skip,true);
}
assert.equal(calls,0);
assert.equal((await generateProactive({...req(),attentionMode:'work'},config)).skip,true);
assert.equal((await generateProactive({...req(),attentionMode:'idle'},config)).skip,true);assert.equal(calls,0);
let result=await generateProactive(req(),config);assert.equal(result.skip,false);
assert.ok(state.topicHistory[0].topic.startsWith('coview:media:'));assert.ok(!JSON.stringify(state).includes('测试番剧'),'账本不存原始播放标题');
assert.match(messages[0].content,/禁止假装|没有读取隐藏画面/);assert.match(messages[0].content,/标题/);
clock+=121000;state.lastActivityTs=clock;
assert.equal((await generateProactive(req(),config)).skip,true,'同片名20分钟内不循环问');
result=await generateProactive({...req(),backgroundMedia:{...media(),title:'另一部番剧 第八集'}},config);assert.equal(result.skip,false,'新内容可走2分钟陪看通道');
reset();state.lastProactiveAt=clock-31*60000;
const work={reason:'screen',screen:'页面主题：在修改代码结构',screenCapturedAt:clock,screenKey:'work',attentionMode:'work'};
assert.equal((await generateProactive(work,config)).skip,true,'工作31分钟仍不打断');
clock+=15*60000;assert.equal((await generateProactive({...work,screenCapturedAt:clock},config)).skip,false,'工作45分钟后才允许少量主动');
reset();delay=21000;assert.equal((await generateProactive(req(),config)).skip,true);assert.equal(state.topicHistory.length,0,'生成后后台证据过期不落库');
console.log('adaptive backend: 后台视频真实性/隐私/时效、2分钟陪看、20分钟标题去重、工作45分钟/挂机静默、生成后过期通过');

// Real proactive scheduling plugin with dynamic snapshots; no model or real store.
clock=new Date(2026,10,11,12).getTime();let snap={enabled:true,status:'paused',pauseReason:'desktop',title:'',summary:'',capturedAt:0,
 attentionMode:'entertainment',attentionAt:clock,backgroundMedia:media()},requests=[],said=[],pending;
const listeners=new Map(),storage=new Map(),doc={visibilityState:'visible',activeElement:null,addEventListener(){}};
const plugin=tsLoader({'../../core/session':{now:()=>clock}},{Date:fakeDate(()=>clock),document:doc,navigator:{},
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}})(path('../src/plugins/proactive/index.ts')).default;
plugin.init({config:{...plugin.manifest.config,quietStartHour:0,quietEndHour:0},bus:{on:(k,v)=>listeners.set(k,v)},
 api:{'screen-awareness':{snapshot:()=>snap}},session:{activity:{kind:'none'}},
 chat:{isThinking:false,generate:async(type,opts)=>{requests.push({type,opts});return pending?new Promise(r=>pending.resolve=r):'这集标题倒是很有悬念。';},sayPet:t=>said.push(t)}});
async function seconds(n){for(let i=0;i<n;i++){clock+=1000;snap={...snap,attentionAt:clock,backgroundMedia:snap.backgroundMedia?{...snap.backgroundMedia,observedAt:clock}:undefined};listeners.get('tick:1s')();await flush();}}
await seconds(119);assert.equal(requests.length,0);await seconds(1);assert.equal(requests.length,1);assert.equal(said.length,1);
assert.ok(requests[0].opts.backgroundMedia);assert.ok(!JSON.stringify([...storage]).includes('测试番剧'),'跨窗冷却只保存哈希');
await seconds(130);assert.equal(requests.length,1);
snap={...snap,attentionMode:'work',backgroundMedia:{...media(),title:'另一部番剧'}};
await seconds(500);assert.equal(requests.length,1,'工作时后台播放不插话');
snap={...snap,attentionMode:'idle'};await seconds(500);assert.equal(requests.length,1,'挂机不泛泛问候');
snap={...snap,attentionMode:'entertainment'};pending={};await seconds(5);assert.equal(requests.length,2);
snap={...snap,attentionMode:'work'};pending.resolve('旧的后台话题');await flush();assert.equal(said.length,1,'生成期间开始工作不弹旧话题');
console.log('adaptive frontend: 实际插件后台播放2分钟、跨窗哈希去重、工作/挂机抑制、生成中模式切换通过');
