import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { tsLoader, fakeDate, flush } from "./test-utils.mjs";

let clock = 1_800_000_000_000;
let snapshot = { enabled: true, status: "watching", title: "绘画", summary: "蓝色画布", capturedAt: clock, windowId: "321" };
let request;
let finish;
let usable = true;
let apiKey = "";
let healthGate, releaseHealth;
const { ChatEngine } = tsLoader({
  "../core/config": { getSection: (_name, defaults) => ({ ...defaults, apiKey }) },
  "../mind/client": {
    mindCfg: () => ({ sessionId: "kept-session" }), mindUsable: async () => healthGate ? new Promise(r=>releaseHealth=r) : usable,
    mindProactive: async (input) => { request = input; return new Promise((resolve) => finish = resolve); },
  },
  "./providers": { chatStream: async () => { throw Error("offline-test"); } },
  "./persona": { buildPersonaPrompt: (_t, _p, context) => context, fillTokens: (s) => s },
  "./fallback": { topicLine: () => "不应作为屏幕回复出现的兜底", localReply: () => "" },
  "../core/session": { greetingByHour: () => "晚上" },
}, { Date: fakeDate(() => clock) })(fileURLToPath(new URL("../src/chat/engine.ts", import.meta.url)));
const session = { activity: { label: "画图" }, minutesOn: () => 4 };
const persona = { name: "她", systemPrompt: "保留人格" };
const engine = new ChatEngine({
  bus: { emit() {} }, session, personas: { active: () => persona },
  apiRef: { "screen-awareness": { snapshot: () => snapshot } },
});
const pending = engine.generate("screen"); await flush();
assert.match(request.screen, /蓝色画布/);
assert.equal(request.session_id, "kept-session"); assert.equal(request.screenCapturedAt, clock);
assert.ok(!engine.composeSystem(persona, { session }).includes("蓝色画布"), "并发的普通对话不沾临时屏幕上下文");
finish({ skip: true }); assert.equal(await pending, "");
request = null; snapshot = { ...snapshot, capturedAt: clock - 31_000 };
assert.equal(await engine.generate("screen"), ""); assert.equal(request, null);
snapshot = { ...snapshot, capturedAt: clock, summary: "", scene: "一幅山水画", sceneAt: clock };
const imageOnly = engine.generate("screen"); await flush();
assert.match(request.screen, /山水画/); finish({ text: "这片山色很舒服。" });
assert.equal(await imageOnly, "这片山色很舒服。");
snapshot = { ...snapshot, scene: "", sceneAt: 0, aiSummary: "正在调整插画的颜色", aiSummaryAt: clock };
const aiSummaryOnly = engine.generate("screen"); await flush();
assert.match(request.screen, /AI画面总结：正在调整插画的颜色/);
finish({ text: "这个配色挺柔和。" });
assert.equal(await aiSummaryOnly, "这个配色挺柔和。");
snapshot = { ...snapshot, summary: '辅助文字'.repeat(200), pageType: 'anime', activity: '显示角色对话', focus: '嘴硬的台词',
  understandingStatus: 'ready', understandingAt: clock,
  screenMoment: {kind:'anime',fact:'角色说完没害怕却后退了一步',key:'moment-a',capturedAt:clock} };
const coview = engine.generate('screen', {screenMoment:snapshot.screenMoment}); await flush();
assert.equal(request.screenMoment.key,'moment-a');
assert.ok(request.screen.indexOf('当前活动') < request.screen.indexOf('可见文字'),'理解优先于辅助OCR');
assert.ok(request.screen.length < 1500,'具体事实不会被OCR挤出后端限长');
finish({text:'这句没害怕怎么听着有点心虚。'}); await coview;
request=null; snapshot.screenMoment.capturedAt=clock-31_000;
assert.equal(await engine.generate('screen',{screenMoment:snapshot.screenMoment}), ''); assert.equal(request,null);
snapshot.screenMoment={...snapshot.screenMoment,capturedAt:clock};
assert.equal(await engine.generate('screen',{screenMoment:{...snapshot.screenMoment,key:'old-window'}}), '');
snapshot={...snapshot,status:'paused',pauseReason:'desktop',summary:'',aiSummary:'',scene:'',capturedAt:0,
 attentionMode:'entertainment',backgroundMedia:{title:'测试番剧 第三集',source:'browser.bilibili',kind:'video',playing:true,observedAt:clock}};
const background=engine.generate('screen',{backgroundMedia:snapshot.backgroundMedia});await flush();
assert.equal(request.backgroundMedia.title,'测试番剧 第三集');assert.equal(request.screenCapturedAt,clock);
assert.match(request.screen,/不知道当前画面/);assert.equal(request.screenMoment,undefined);
finish({text:'这个标题倒是很有悬念。'});await background;
request=null;snapshot.backgroundMedia.playing=false;
assert.equal(await engine.generate('screen',{backgroundMedia:snapshot.backgroundMedia}),'');assert.equal(request,null);
snapshot={enabled:true,status:'watching',title:'绘画',summary:'蓝色画布',capturedAt:clock,windowId:'321'};
healthGate=true;request=null;
const beforeClosed=engine.generate('screen');await flush();snapshot={enabled:false,status:'off'};releaseHealth(true);
assert.equal(await beforeClosed,'');assert.equal(request,null,'健康检查等待期间关闭读屏，不得再发新模型请求');
healthGate=false;snapshot={enabled:true,status:'watching',title:'绘画',summary:'蓝色画布',capturedAt:clock,windowId:'321'};
const inFlight=engine.generate('screen');await flush();snapshot={enabled:false,status:'off'};finish({text:'迟到的读屏回复'});
assert.equal(await inFlight,'','关闭后迟到回复不能重新弹出');
usable = false; apiKey = "test-only";
assert.equal(await engine.generate("screen"), "", "网络错误不生成无依据的屏幕兜底");
assert.equal(await engine.generate("screen-day"), "", "晚间回顾离线不拿泛泛闲聊冒充当天总结");
console.log("engine: 新鲜屏幕传参、保留会话、图像单独上下文、并发隔离、过期不请求、失败不胡编通过");
