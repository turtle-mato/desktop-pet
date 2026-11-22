import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {tsLoader,fakeDate,flush} from './test-utils.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const backend=path.resolve(root,'../mind/server/lib');
let clock=new Date(2026,10,15,8).getTime(),calls=0,weatherCalls=0,messages,notes='',reviewAttempts=0;
let state={topicHistory:[],lastActivityTs:clock,lastProactiveAt:0};
const cfg={proactive:{enabled:true,quietStartHour:23,quietEndHour:7,maxPerDay:3,minGapMinutes:45,repeatDays:3,recallRatio:0},llm:{}};
const {generateProactive}=tsLoader({
 './store.ts':{loadState:()=>state,saveState:p=>Object.assign(state,p),loadEpisodic:()=>[],loadEmotional:()=>[],loadVectors:()=>[]},
 './paths.ts':{dateStr:(d=new Date(clock))=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`},
 './persona.ts':{personaBase:()=> '三无短句，只叫哥，偶尔周周。不加动作描写。',selfBlock:()=> '本地时间'},
 './retrieve.ts':{openThreads:()=>[]},'./embed.ts':{embedAvailable:()=>false},
 './weather.ts':{localWeather:async()=>{weatherCalls++;return {ok:true,text:'网络定位：徐州，当天6～17℃，多云，定位可能偏移。'};}},
 './screenDay.ts':{screenDays:{material:()=>notes,attempt:()=>{reviewAttempts++;return true;},finish:raw=>JSON.parse(raw)}},
 './llm.ts':{chatStream:async(c,input,_,opts)=>{calls++;messages=input;assert.equal(c.llm.thinking,'off');return {text:opts.maxTokens===650?JSON.stringify({summary:'今天零散看到改代码，不代表做了一整天。',topic:'哥，那个小按钮后来顺手了吗？'}):'哥，存个档，准备收工？'};}},
},{Date:fakeDate(()=>clock)})(path.join(backend,'proactive.ts'));
state.topicHistory=Array.from({length:6},(_,i)=>({topic:'daily:'+i,at:clock-3*3600_000}));
let out=await generateProactive({reason:'routine-morning',history:[{role:'user',content:'今天准备修按钮'}]},cfg);
assert.equal(out.skip,false);assert.equal(weatherCalls,1);assert.equal(messages[1].content,'今天准备修按钮');
assert.match(messages[0].content,/不重复问/);assert.match(messages[0].content,/哥/);
assert.equal((await generateProactive({reason:'routine-morning'},cfg)).skip,true);assert.equal(weatherCalls,1);
clock=new Date(2026,10,15,22).getTime();state.lastActivityTs=clock;
const beforeEmptyEvening=calls;
out=await generateProactive({reason:'routine-evening'},cfg);assert.equal(out.skip,true,'没有当天事实时不硬找晚间话题');assert.equal(reviewAttempts,0);
assert.equal(calls,beforeEmptyEvening,'空话题不调用模型');
assert.equal((await generateProactive({reason:'routine-sleep'},cfg)).skip,true,'22点不得提前催睡');
clock=new Date(2026,10,15,23,10).getTime();state.lastActivityTs=clock;
assert.equal((await generateProactive({reason:'idle'},cfg)).skip,true,'默认23点普通闲聊仍静默');
assert.equal((await generateProactive({reason:'routine-sleep'},cfg)).skip,false,'只允许一次睡前例外');
assert.match(messages[0].content,/不要催睡/);
clock+=40*60_000;assert.equal((await generateProactive({reason:'routine-sleep'},cfg)).skip,true);
assert.equal((await generateProactive({reason:'routine-morning'},cfg)).skip,true,'不能补发早晨提醒');
clock=new Date(2026,10,16,23,10).getTime();state={topicHistory:[],lastActivityTs:clock,lastProactiveAt:0};
const beforeDeclined=calls;
assert.equal((await generateProactive({reason:'routine-sleep',history:[{role:'user',content:'我今晚有事，别催我睡觉。',at:clock-60000}]},cfg)).skip,true);
assert.equal(calls,beforeDeclined,'明确拒绝后零模型调用，不再突然发知道了');
assert.equal((await generateProactive({reason:'routine-sleep',history:[{role:'user',content:'晚安，我去睡了。',at:clock-60000}]},cfg)).skip,true);
assert.equal((await generateProactive({reason:'routine-sleep'},{...cfg,proactive:{...cfg.proactive,quietStartHour:22}})).skip,true,'用户更早设置的静默不得绕过');
assert.equal((await generateProactive({reason:'routine-sleep'},{...cfg,proactive:{...cfg.proactive,enabled:false}})).skip,true);
assert.equal((await generateProactive({reason:'routine-sleep',attentionMode:'idle'},cfg)).skip,true);
assert.equal((await generateProactive({reason:'routine-sleep'},{...cfg,proactive:{...cfg.proactive,dailyRoutines:{enabled:false}}})).skip,true);
clock=new Date(2026,10,16,22).getTime();notes='今天零散看到修按钮。';
assert.equal((await generateProactive({reason:'routine-evening'},cfg)).skip,false);assert.equal(reviewAttempts,1);
clock+=40*60_000;assert.equal((await generateProactive({reason:'screen-day'},cfg)).skip,true,'旧回顾不能重复今天已聊过的内容');
console.log('daily backend: reserved slots, real history, no-note evening, one sleep exception, custom quiet, dedup, disabled/idle and day-review compatibility passed');

// Network, stale-date, malformed data and zero-persistence weather tests.
let netCalls=0,mode='ok';clock=new Date(2026,10,15,8).getTime();
const {localWeather}=tsLoader({}, {Date:fakeDate(()=>clock),URL,URLSearchParams,fetch:async url=>{
 netCalls++;if(mode==='error')throw Error('offline');
 return {ok:true,json:async()=>String(url).includes('ipwho.is')?{success:true,city:'徐州',region:'江苏省',country:'中国',latitude:34,longitude:117}:
 {daily:{time:[mode==='stale'?'2020-01-01':new Date(clock).toISOString().slice(0,10)],weather_code:[3],temperature_2m_min:[6],temperature_2m_max:[17],precipitation_probability_max:[0]}}};
}})(path.join(backend,'weather.ts'));
let w=await localWeather();assert.equal(w.ok,true);assert.match(w.text,/徐州/);assert.match(w.text,/6～17/);
await localWeather();assert.equal(netCalls,2,'同日重试不重复定位、查天气');
clock+=86400_000;mode='stale';assert.equal((await localWeather()).ok,false,'旧日期预报不可冒认今日天气');
clock+=86400_000;mode='error';w=await localWeather();assert.equal(w.ok,false);assert.doesNotMatch(w.text,/徐州/);
console.log('weather: daily cache, new-day relocation, failed/stale forecast no invented city or weather passed');

// Exercise scheduler in two simulated windows and across a restart, capture OFF.
clock=new Date(2026,10,15,22,58).getTime();let storage=new Map(),requests=[],said=[];
const env={Date:fakeDate(()=>clock),document:{visibilityState:'visible',activeElement:null,addEventListener(){}},navigator:{},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}};
let active=false,late=false;
function start(overrides={}) {
 let tick;const plugin=tsLoader({'../../core/session':{now:()=>clock}},env)(path.join(root,'src/plugins/proactive/index.ts')).default;
 plugin.init({config:{...plugin.manifest.config,...overrides},bus:{on:(n,fn)=>{if(n==='tick:1s')tick=fn;}},
 api:{'screen-awareness':{snapshot:()=>({enabled:active,status:active?'watching':'off',attentionMode:active?'idle':undefined})}},session:{activity:{kind:'none'}},
 chat:{isThinking:false,generate:async type=>{requests.push(type);if(late)clock=new Date(2026,10,16,0,0).getTime();return '哥，存个档，准备收工？';},sayPet:t=>said.push(t)}});return ()=>tick();
}
let tick1=start(),tick2=start();
for(let i=0;i<600;i++){clock+=1000;tick1();tick2();await flush();}
assert.equal(requests.filter(t=>t==='routine-sleep').length,1);assert.equal(said.length,1,'大小窗睡前不重复');
tick1=start();for(let i=0;i<300;i++){clock+=1000;tick1();await flush();}assert.equal(requests.filter(t=>t==='routine-sleep').length,1,'重启不再次催睡');
clock=new Date(2026,10,16,23).getTime();requests=[];said=[];storage=new Map();tick1=start({quietStartHour:22});
for(let i=0;i<300;i++){clock+=1000;tick1();await flush();}assert.equal(requests.length,0,'自定义22点安静不绕过');
clock=new Date(2026,10,17,23,57).getTime();requests=[];said=[];storage=new Map();late=true;tick1=start();
for(let i=0;i<130;i++){clock+=1000;tick1();await flush();}assert.equal(said.length,0,'生成跨午夜后不展示过时催睡');
clock=new Date(2026,10,18,8).getTime();requests=[];said=[];storage=new Map();late=false;active=true;tick1=start();
for(let i=0;i<130;i++){clock+=1000;tick1();await flush();}assert.equal(requests.length,0,'有可靠闲置状态时不向空桌面搭话');
console.log('daily frontend: one sleep exception, two-window/restart dedup, quiet/idle checks, capture stays off and late-result rejection passed');
