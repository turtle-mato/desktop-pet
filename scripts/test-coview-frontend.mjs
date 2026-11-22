import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tsLoader, fakeDate, flush } from './test-utils.mjs';
const start = 1_800_000_000_000;
function fixture() {
  let clock = start, snapshot, pending, reply = '右边这位出场也太突然了。', thinking = false;
  const listeners = new Map(), storage = new Map(), requests = [], said = [];
  const doc = { visibilityState: 'visible', activeElement: null, addEventListener() {} };
  const plugin = tsLoader({ '../../core/session': { now: () => clock } }, {
    Date: fakeDate(() => clock), document: doc, navigator: {},
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k,v) => storage.set(k,v) },
  })(fileURLToPath(new URL('../src/plugins/proactive/index.ts', import.meta.url))).default;
  const config = { ...plugin.manifest.config, quietStartHour: 0, quietEndHour: 0 };
  const base = { enabled: true, status: 'watching', title: '视频', windowId: '1', summary: '动态字幕',
    capturedAt: clock, aiSummary: '一个角色从右侧冲来', aiSummaryAt: clock,
    pageType: 'anime', understandingStatus: 'ready', understandingAt: clock };
  snapshot = { ...base };
  plugin.init({config, bus: { on: (k,v) => listeners.set(k,v) },
    api: { 'screen-awareness': { snapshot: () => snapshot } }, session: { activity: { kind:'none' } },
    chat: { get isThinking(){return thinking;}, generate: async (type,opts) => {requests.push({type,opts});
      return pending ? new Promise(r => pending.resolve=r) : reply;}, sayPet: text => said.push(text) } });
  function moment(key='event-a') { return {kind:'anime',fact:'一名角色从右侧突然冲了过来',key,capturedAt:clock}; }
  async function seconds(n, patch={}) {
    for(let i=0;i<n;i++) {clock+=1000;snapshot={...snapshot,capturedAt:clock,summary:`字幕${clock}`, ...patch};
      if(patch.screenMoment === 'fresh') snapshot.screenMoment=moment();
      listeners.get('tick:1s')();await flush();}
  }
  return { seconds, requests, said, doc, config, storage, moment,
    set snapshot(s){snapshot={...snapshot,...s};}, get snapshot(){return snapshot;},
    set thinking(v){thinking=v;}, set pending(v){pending=v;}, set reply(v){reply=v;}, get clock(){return clock;} };
}
const f=fixture();
await f.seconds(180,{screenMoment:'fresh'});
assert.equal(f.requests.length,1,'字幕不断更新仍可在3分钟门槛后具体陪看');
assert.equal(f.requests[0].opts.screenMoment.key,'event-a'); assert.equal(f.said.length,1);
await f.seconds(300,{screenMoment:'fresh'});assert.equal(f.requests.length,1,'同一瞬间10分钟内不重复');
f.snapshot={screenMoment:{...f.moment('event-b')}};
await f.seconds(5);assert.equal(f.requests.length,2,'新具体事件可以再次接话');
await f.seconds(200,{screenMoment:undefined});assert.equal(f.requests.length,2,'泛娱乐画面不触发OCR问候');
f.snapshot={screenMoment:{...f.moment('stale'),capturedAt:f.clock-31_000}};
await f.seconds(5);assert.equal(f.requests.length,2,'过期瞬间不触发');
f.thinking=true; await f.seconds(190,{screenMoment:'fresh'});assert.equal(f.requests.length,2);
f.thinking=false;f.doc.visibilityState='hidden';await f.seconds(200,{screenMoment:'fresh'});assert.equal(f.requests.length,2);
f.doc.visibilityState='visible';f.config.quietStartHour=0;f.config.quietEndHour=23;
await f.seconds(200,{screenMoment:'fresh'});assert.equal(f.requests.length,2,'静默时段不触发');
const g=fixture();const deferred={};g.pending=deferred;
await g.seconds(180,{screenMoment:'fresh'});assert.equal(g.requests.length,1);
g.snapshot={windowId:'2',title:'另一页面',screenMoment:undefined};deferred.resolve('旧画面不该弹出');await flush();
assert.equal(g.said.length,0,'生成期间切窗不冒旧画面吐槽');
const h=fixture(); const waiting={}; h.pending=waiting;
await h.seconds(180,{screenMoment:'fresh'});
h.doc.activeElement={matches:()=>true,value:'用户正在输入'};waiting.resolve('不要插嘴');await flush();
assert.equal(h.said.length,0,'生成期间开始输入仍不打断');
console.log('coview frontend: 动态字幕、3分钟门槛、事件去重、过期、忙碌、隐藏、静默、生成中切窗/输入通过');
