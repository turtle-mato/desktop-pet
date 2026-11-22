import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {tsLoader,fakeDate,flush} from './test-utils.mjs';
const file=n=>fileURLToPath(new URL(n,import.meta.url));
const at=1_800_000_000_000;
const policy=tsLoader()(file('../src/chat/screenPolicy.ts'));
const context=tsLoader()(file('../src/chat/screenContext.ts'));
const f={windowId:'1',title:'工作窗口',process:'code.exe',kind:'work',minimized:false};
const base={observedAt:at,idleSeconds:1,unavailable:false,foreground:f,background:[],media:[],mediaAvailable:true};
const scene={windowId:'1',pageType:'coding',understandingStatus:'ready',understandingAt:at};
const video={title:'测试番剧 第三集',source:'browser.bilibili',kind:'video',playing:true};
assert.equal(policy.attentionPolicy(base,scene,at).mode,'work');
assert.equal(policy.attentionPolicy(base,scene,at).ocrMs,1_200_000);
assert.equal(policy.attentionPolicy(base,scene,at).visionMs,1_200_000);
const oldArticle={windowId:'1',title:f.title,pageType:'article',understandingStatus:'ready',understandingAt:at-600_000};
assert.equal(policy.attentionPolicy({...base,foreground:{...f,kind:'unknown'}},oldArticle,at).mode,'work','阅读分类保持20分钟，但不刷新事实时间');
assert.equal(policy.attentionPolicy({...base,foreground:{...f,kind:'unknown',title:'另一个页面'}},oldArticle,at).mode,'normal','标题变化不沿用旧阅读分类');
assert.equal(policy.attentionPolicy({...base,media:[video]},scene,at).mode,'work','工作优先，后台视频不提高打扰');
assert.equal(policy.attentionPolicy({...base,foreground:{...f,kind:'unknown'},media:[video]}, {},at).mode,'entertainment');
assert.equal(policy.attentionPolicy({...base,foreground:{...f,kind:'unknown'},idleSeconds:600,media:[video]}, {},at).mode,'entertainment','被动看视频不误判挂机');
assert.equal(policy.attentionPolicy({...base,idleSeconds:181},scene,at).mode,'idle');
assert.equal(policy.attentionPolicy({...base,idleSeconds:181},scene,at).ocrMs,1_800_000,'挂机比20分钟工作档更低频');
assert.equal(policy.attentionPolicy({...base,foreground:{...f,kind:'game'},idleSeconds:181}, {},at).mode,'idle','游戏挂机降频');
assert.equal(policy.attentionPolicy({...base,foreground:{...f,kind:'unknown'},media:[{...video,kind:'music'}],idleSeconds:600}, {},at).mode,'idle','后台音乐不证明有人看屏幕');
assert.equal(policy.attentionPolicy({...base,foreground:{...f,kind:'unknown'},background:[{...f,kind:'game',minimized:true}]},{},at).mode,'normal');
assert.equal(policy.attentionPolicy({...base,foreground:{...f,kind:'game'}}, {},at).mode,'entertainment');
assert.equal(policy.attentionPolicy({...base,foreground:{...f,kind:'game'}}, {...scene,pageType:'game',activity:'游戏暂停菜单'},at).mode,'normal');
assert.equal(policy.attentionPolicy({...base,observedAt:at-21000},scene,at).mode,'normal');
assert.equal(policy.playingVideo({...base,media:[{...video,playing:false}]},at),undefined);
assert.equal(policy.playingVideo({...base,media:[video],sensitiveForeground:true},at),undefined);
assert.equal(policy.playingVideo({...base,media:[{...video,title:'secret password'}]},at),undefined);
assert.equal(policy.playingVideo({...base,media:[{...video,kind:'unknown',title:'ordinary song',source:'chrome'}]},at),undefined);
assert.equal(policy.attentionPolicy({...base,unavailable:true,media:[video]}, {},at).mode,'idle');
console.log('adaptive policy: 前后台、工作优先、最小化仅运行、视频被动观看/暂停、音乐、挂机、敏感/过期通过');

// Actual scheduler: metadata remains cheap/frequent while OCR/vision rates change.
let clock=at,app={...base},frame={title:'游戏',text:'目前可见内容',windowId:'1',width:800,height:600},calls=[],enabled=false;
const timers=new Map();let id=0;
const observation={summary:'角色站在桥上',pageType:'game',activity:'角色站在桥上',focus:'石桥',confidence:'high',moment:'',subtitle:''};
const plugin=tsLoader({
 '@tauri-apps/api/core':{invoke:async(cmd,args)=>{
  calls.push({cmd,at:clock});
  if(cmd==='screen_set_enabled'){enabled=args.enabled;return;}
  assert.equal(enabled,true);
  if(cmd==='screen_activity')return {...app,observedAt:clock};
  if(cmd==='screen_observe')return {...frame,capturedAt:clock};
  if(cmd==='screen_capture_image')return 'synthetic-image';
  throw Error(cmd);
 }},
 '@tauri-apps/api/window':{getCurrentWindow:()=>({label:'main'})},
 '@tauri-apps/api/event':{emit:async()=>{}},
 '../../chat/vision':{describeImage:async()=>JSON.stringify(observation)},
},{Date:fakeDate(()=>clock),window:{__TAURI_INTERNALS__:{}},
 setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms,due:clock+ms});return id;},clearTimeout:i=>timers.delete(i)
})(file('../src/plugins/screen-awareness/index.ts')).default;
await plugin.init({config:{enabled:false},setConfig(){},bus:{emit(){}}});
app={...base,foreground:{...f,title:'游戏',kind:'game'}};
await plugin.publicApi.setEnabled(true);await flush();
const api=plugin.publicApi;
assert.equal(api.snapshot().attentionMode,'entertainment');
async function tick(ms=4000){clock+=ms;const pair=[...timers].find(([,t])=>t.fn.constructor.name==='AsyncFunction');assert.ok(pair);timers.delete(pair[0]);await pair[1].fn();await flush();}
let n=calls.filter(c=>c.cmd==='screen_capture_image').length;
await tick();await tick();assert.equal(calls.filter(c=>c.cmd==='screen_capture_image').length,n);
await tick();assert.equal(calls.filter(c=>c.cmd==='screen_capture_image').length,n+1,'12秒重新理解');
assert.equal(calls.filter(c=>c.cmd==='screen_observe').length,4,'娱乐4秒OCR');
app={...base,foreground:{...f,windowId:'2'},media:[video]};frame={...frame,title:'工作',windowId:'2'};
await tick();assert.equal(api.snapshot().attentionMode,'work');assert.equal(api.snapshot().aiSummary,'','切窗立刻隔离旧图');
let count=calls.filter(c=>c.cmd==='screen_observe').length;
await tick();await tick();assert.equal(calls.filter(c=>c.cmd==='screen_observe').length,count,'工作不每4秒OCR');
await tick(24000);assert.equal(calls.filter(c=>c.cmd==='screen_observe').length,count);
app={...app,foreground:{...f,windowId:'22'}};frame={...frame,windowId:'22'};
await tick();assert.equal(calls.filter(c=>c.cmd==='screen_observe').length,count,'工作切窗也不绕过20分钟');
await tick(1_140_000);assert.equal(calls.filter(c=>c.cmd==='screen_observe').length,count,'20分钟前不读');
await tick(24000);assert.equal(calls.filter(c=>c.cmd==='screen_observe').length,count+1,'约20分钟读取一次');
app={...app,idleSeconds:200,media:[]};await tick();assert.equal(api.snapshot().attentionMode,'idle');
count=calls.filter(c=>c.cmd==='screen_observe').length;await tick(60000);assert.equal(calls.filter(c=>c.cmd==='screen_observe').length,count,'挂机减少OCR');
app={...base,foreground:{...f,windowId:'3',kind:'unknown'},idleSeconds:600,media:[video]};frame={...frame,title:'其他',windowId:'3'};
await tick();assert.equal(api.snapshot().attentionMode,'entertainment');assert.ok(context.freshBackgroundMedia(api.snapshot(),clock));
app={...app,sensitiveForeground:true};await tick();assert.equal(api.snapshot().pauseReason,'sensitive');
assert.equal(api.snapshot().summary,'');assert.equal(api.snapshot().backgroundMedia,undefined);assert.equal(context.freshBackgroundMedia(api.snapshot(),clock),null);
await api.setEnabled(false);await flush();assert.equal(api.snapshot().backgroundMedia,undefined);assert.equal(api.snapshot().attentionMode,undefined);
assert.equal(timers.size,0);
console.log('adaptive scheduler: 娱乐4/12秒、工作文字/画面20分钟、工作切窗不绕过、阅读分类稳定、挂机/隐私隔离通过');
