import assert from 'node:assert/strict';
import path from 'node:path';import{fileURLToPath}from'node:url';
import {tsLoader,fakeDate,flush} from './test-utils.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
let clock=new Date(2026,10,12,22).getTime(),calls=0,messages,attempts=0,material='今天零散看到编辑器里改桌宠按钮，晚上番剧画面中两位角色在车站告别。';
let state={topicHistory:Array.from({length:5},(_,i)=>({topic:'daily:'+i,at:clock-3600000})),lastActivityTs:clock,lastProactiveAt:0};
const {generateProactive}=tsLoader({
 './store.ts':{loadState:()=>state,saveState:p=>Object.assign(state,p),loadEpisodic:()=>[],loadEmotional:()=>[],loadVectors:()=>[]},
 './paths.ts':{dateStr:()=> '2026-11-12'},'./persona.ts':{personaBase:()=> '原有人格',selfBlock:()=> '本地时间'},
 './retrieve.ts':{openThreads:()=>[]},'./embed.ts':{embedAvailable:()=>false},
 './screenDay.ts':{screenDays:{material:()=>material,attempt:()=>{attempts++;return true;},finish:raw=>JSON.parse(raw)}},
 './llm.ts':{chatStream:async(cfg,input)=>{calls++;messages=input;assert.equal(cfg.llm.thinking,'off');return{text:JSON.stringify({summary:'今天零散读到桌宠编辑器和番剧的告别画面，不能认定具体工作时长。',topic:'哥哥，晚上车站告别那一幕挺安静的。你更喜欢这种留点余味的收尾吗？'})};}},
},{Date:fakeDate(()=>clock)})(path.resolve(root,'../mind/server/lib/proactive.ts'));
const cfg={proactive:{enabled:true,quietStartHour:23,quietEndHour:7,maxPerDay:3,minGapMinutes:10,repeatDays:3,recallRatio:0},llm:{}};
const result=await generateProactive({reason:'screen-day',history:[{role:'user',content:'刚才说的那个按钮好了'}]},cfg);
assert.equal(result.skip,false,'晚间回顾保留一个名额，不被白天消息用光');assert.equal(calls,1);assert.equal(attempts,1);
assert.match(messages[0].content,/零散/);assert.match(messages[0].content,/不做日报/);assert.match(messages[0].content,/不能编.*连续时长/);assert.match(messages[0].content,/不执行/);
assert.equal(messages[1].content,'刚才说的那个按钮好了');
clock+=3600000;assert.equal((await generateProactive({reason:'screen-day'},cfg)).skip,true);assert.equal(calls,1,'23点静默不能打扰');
clock-=3600000;clock+=1200000;assert.equal((await generateProactive({reason:'screen-day'},cfg)).skip,true);assert.equal(calls,1,'两窗/重复请求不会再生成第二条回顾');
state={topicHistory:[],lastActivityTs:clock,lastProactiveAt:0};material='';assert.equal((await generateProactive({reason:'screen-day'},cfg)).skip,true);assert.equal(calls,1,'没记录就不请求模型凑故事');
console.log('evening backend: one reserved daily slot, existing dialogue continuity, grounded/life-like prompt, quiet hours, dedup and no-data zero-call passed (mock model)');

clock=new Date(2026,10,12,21,20).getTime();let tick,requests=[],said=[],storage=new Map();
const plugin=tsLoader({'../../core/session':{now:()=>clock}},{Date:fakeDate(()=>clock),document:{visibilityState:'visible',activeElement:null,addEventListener(){}},navigator:{},
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}})(path.join(root,'src/plugins/proactive/index.ts')).default;
plugin.init({config:{...plugin.manifest.config,dailyRoutinesEnabled:false,quietStartHour:23,quietEndHour:7},bus:{on:(name,cb)=>{if(name==='tick:1s')tick=cb;}},api:{'screen-awareness':{snapshot:()=>({enabled:false,status:'off'})},'screen-journal':{enabled:()=>true}},
 session:{activity:{kind:'none'}},chat:{isThinking:false,generate:async type=>{requests.push(type);return '哥哥，刚才那一幕还挺让人在意的。';},sayPet:text=>said.push(text)}});
for(let i=0;i<600;i++){clock+=1000;tick();await flush();}
assert.deepEqual(requests,['screen-day']);assert.equal(said.length,1,'读屏已关时复用今天记录，不需要新采集');
for(let i=0;i<120;i++){clock+=1000;tick();await flush();}
assert.equal(requests.filter(t=>t==='screen-day').length,1);
assert.ok([...storage.values()].some(v=>v.includes('"said":true')));
console.log('evening frontend: 21:30 once, read-switch off permits only prior-record reflection, shared persisted daily marker passed');
