// 本地状态机集成测试：模拟 Tauri IPC，校验开启/轮询/关闭时状态与前端事件。
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { tsLoader, flush, fakeDate } from "./test-utils.mjs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const source = readFileSync(new URL("../src/plugins/screen-awareness/index.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const screenContext = tsLoader()(fileURLToPath(new URL("../src/chat/screenContext.ts", import.meta.url)));
const screenObservation = tsLoader()(fileURLToPath(new URL("../src/chat/screenObservation.ts", import.meta.url)));
const screenPolicy = tsLoader()(fileURLToPath(new URL("../src/chat/screenPolicy.ts", import.meta.url)));
const broadcasts = [];
const events = [];
const calls = [];
const config = [];
const timers = new Map();
let nextTimer = 0;
let releaseObservation;
let observation = { title: "记事本", text: "今天整理资料\n下一步写代码", capturedAt: 123, width: 800, height: 600 };
let delayNextObservation = false;
let delayNextToggle = false;
let releaseToggle;
let enabled = false;
const invoke = async (cmd, args) => {
  calls.push(cmd);
  if (cmd === "screen_set_enabled") {
    if (delayNextToggle) {
      delayNextToggle = false;
      await new Promise((resolve) => { releaseToggle = resolve; });
    }
    enabled = args.enabled;
    return;
  }
  if (cmd === "screen_observe") {
    assert.equal(enabled, true, "后端开关必须打开后才能采集");
    if (delayNextObservation) {
      delayNextObservation = false;
      return new Promise((resolve) => { releaseObservation = resolve; });
    }
    return observation;
  }
  if (cmd === "screen_capture_image") return "";
  throw Error(`未知 IPC: ${cmd}`);
};
const sandbox = {
  exports: {},
  AbortController, AbortSignal,
  console,
  window: { __TAURI_INTERNALS__: {} },
  require: (name) => {
    if (name === "../../chat/screenContext") return screenContext;
    if (name === "../../chat/screenObservation") return screenObservation;
    if (name === "../../chat/screenPolicy") return screenPolicy;
    if (name === "@tauri-apps/api/event") return { emit: async (name, data) => broadcasts.push({ name, data }) };
    if (name === "@tauri-apps/api/core") return { invoke };
    if (name === "@tauri-apps/api/window") return { getCurrentWindow: () => ({ label: "main" }) };
    throw Error(`未知依赖: ${name}`);
  },
  setTimeout: (fn, ms) => { assert.equal(ms, 8000); timers.set(++nextTimer, fn); return nextTimer; },
  clearTimeout: (id) => timers.delete(id),
};
vm.runInNewContext(compiled, sandbox, { filename: "screen-awareness.js" });
const appSource = readFileSync(new URL("../src/ui/app.ts", import.meta.url), "utf8");
const appExports = {};
vm.runInNewContext(ts.transpileModule(appSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: appExports, require: () => ({}) }, { filename: "ui/app.js" });
const view = appExports.formatScreenStatus;
assert.match(view({ enabled: false, status: "off" }), /关闭/);
assert.match(view({ enabled: true, status: "waiting" }), /识别中/);
assert.match(view({ enabled: true, status: "paused" }), /已隐藏/);
assert.match(view({ enabled: true, status: "watching", title: "记事本", summary: "段落" }), /记事本 · 段落/);
assert.match(view({ enabled: true, status: "watching", title: "画图", summary: "", aiSummary: "正在编辑蓝色插画" }), /AI总结：正在编辑蓝色插画/);
assert.match(view({ enabled: true, status: "error", error: "OCR 不可用" }), /OCR 不可用/);
const plugin = sandbox.exports.default;
await plugin.init({
  config: { enabled: false },
  bus: { emit: (name, data) => events.push({ name, data }) },
  setConfig: (patch) => config.push(patch),
});
plugin.start();
const api = plugin.publicApi;
assert.equal(api.snapshot().enabled, false);
assert.equal(calls.length, 0, "默认关闭时不触发原生采集");
await api.setEnabled(true);
assert.equal(api.snapshot().status, "watching");
assert.equal(api.snapshot().title, "记事本");
assert.match(api.snapshot().summary, /整理资料/);
assert.equal(api.snapshot().rawLineCount, 2);
assert.equal(api.snapshot().keptLineCount, 2);
assert.equal(api.snapshot().filteredLineCount, 0);
assert.match(api.snapshot().decision, /前台窗口客户区/);
assert.equal(events.at(-1).data.decision, api.snapshot().decision);
assert.equal(timers.size, 1);
observation = { ...observation, title: "代码编辑器", text: "第二轮可见的内容", capturedAt: 456 };
const staleTimer = [...timers.values()][0];
await staleTimer();
assert.equal(api.snapshot().title, "代码编辑器");
assert.equal(api.snapshot().capturedAt, 456);
assert.equal(timers.size, 1, "轮询只留一个定时器");
await api.setEnabled(false);
assert.equal(api.snapshot().status, "off");
assert.equal(api.snapshot().summary, "");
assert.equal(api.snapshot().capturedAt, 0);
assert.equal(api.snapshot().rawLineCount, 0);
assert.equal(api.snapshot().keptLineCount, 0);
assert.equal(api.snapshot().filteredLineCount, 0);
assert.equal(timers.size, 0);
const countAfterStop = calls.length;
assert.equal(calls.filter((c) => !["screen_capture_image", "screen_activity"].includes(c)).length, 4, "2 次采集和 2 次开关（另有轻量活动探测）");
// 关闭途中仍在运行的旧帧不得恢复界面内容。
delayNextObservation = true;
const enabling = api.setEnabled(true);
while (!releaseObservation) await Promise.resolve();
const closing = api.setEnabled(false);
await closing;
releaseObservation({ ...observation, title: "迟到的画面", capturedAt: 789 });
await enabling;
assert.equal(api.snapshot().enabled, false);
assert.equal(api.snapshot().title, "");
assert.equal(timers.size, 0);
assert.ok(events.some((event) => event.name === "screen:status" && event.data.status === "watching"));
assert.equal(config.at(-1).enabled, false);
// 旧帧卡住时，用户重新打开仍须能立即启动本轮新采集；旧帧稍后返回也不能覆盖新帧。
delayNextObservation = true;
releaseObservation = undefined;
const firstOpen = api.setEnabled(true);
while (!releaseObservation) await Promise.resolve();
const finishOld = releaseObservation;
await api.setEnabled(false);
observation = { ...observation, title: "新一轮", capturedAt: 900 };
await api.setEnabled(true);
assert.equal(api.snapshot().title, "新一轮", "旧轮采集不能占用新轮 busy 标志");
finishOld({ ...observation, title: "旧轮迟到", capturedAt: 800 });
await firstOpen;
assert.equal(api.snapshot().title, "新一轮");
assert.equal(timers.size, 1);
const callCountBeforeStaleTimer = calls.length;
await staleTimer();
assert.equal(calls.length, callCountBeforeStaleTimer, "已取消的旧定时回调不能采集新一轮");
assert.equal(timers.size, 1, "旧定时回调不能覆盖新一轮的定时器");
await api.setEnabled(false);
// 原生开启命令尚未完成时按关闭：后端最终必须仍是关闭。
delayNextToggle = true;
const delayedOpen = api.setEnabled(true);
while (!releaseToggle) await Promise.resolve();
const finalClose = api.setEnabled(false);
releaseToggle();
await Promise.all([delayedOpen, finalClose]);
assert.equal(enabled, false, "异步开启完成后不能将关闭请求覆盖掉");
assert.equal(api.snapshot().status, "off");
assert.equal(timers.size, 0);
await flush();
assert.equal(broadcasts.at(-1).data.status, "off", "关闭状态必须传给小窗");
console.log("screen-awareness: 默认关闭、开启识别、持续刷新、关闭清空、旧帧隔离、重启采集、旧定时回调隔离、原生开关竞态均通过");
// Upgrade starts OFF once to stop accidental all-day spend. Subsequent explicit
// ON/OFF choices survive initialization; mini never writes collection defaults.
let preferences={enabled:true};const preferenceCalls=[];
const prefPlugin=tsLoader({
 '@tauri-apps/api/window':{getCurrentWindow:()=>({label:'main'})},
 '@tauri-apps/api/event':{emit:async()=>{}},
 '@tauri-apps/api/core':{invoke:async cmd=>{preferenceCalls.push(cmd);throw Error('unused test capture');}},
},{window:{__TAURI_INTERNALS__:{}}})(fileURLToPath(new URL('../src/plugins/screen-awareness/index.ts',import.meta.url))).default;
const initPref=()=>prefPlugin.init({config:{...preferences},setConfig:p=>Object.assign(preferences,p),bus:{emit(){}}});
await initPref();prefPlugin.start();await flush();assert.equal(preferenceCalls.length,0);assert.equal(preferences.enabled,false);assert.equal(preferences.manualControlV1,true);
preferences.enabled=true;await initPref();assert.equal(prefPlugin.publicApi.snapshot().enabled,true);
preferences.enabled=false;await initPref();prefPlugin.start();await flush();assert.equal(prefPlugin.publicApi.snapshot().enabled,false);assert.equal(preferenceCalls.length,0);
console.log('screen manual upgrade: first install OFF, later explicit ON/OFF preserved across restart passed');

// 模型慢返回、切窗/暂停/关闭：不能把旧描述挂到下一帧。
let clock = 1_800_000_000_000;
let nextFrame = { title: "画图", text: "蓝色的画布", capturedAt: clock, windowId: "101", width: 800, height: 600 };
const pollTimers = new Map();
const sent = [];
const pendingVision = [];
let timerId = 0;
let observationError;
let captureError;
const capturedWindows = [];
const isolated = tsLoader({
  "@tauri-apps/api/core": { invoke: async (cmd, args) => {
    if (cmd === "screen_set_enabled") return;
    if (cmd === "screen_observe") {
      if (observationError) { const error = observationError; observationError = undefined; throw error; }
      return nextFrame;
    }
    if (cmd === "screen_capture_image") {
      capturedWindows.push(args);
      if (captureError) { const error = captureError; captureError = undefined; throw error; }
      return "synthetic-test-frame";
    }
    throw Error(cmd);
  } },
  "@tauri-apps/api/window": { getCurrentWindow: () => ({ label: "main" }) },
  "@tauri-apps/api/event": { emit: async (_name, data) => sent.push(data) },
  "../../chat/vision": { describeImage: async (b64, question, signal) => new Promise((resolve) => pendingVision.push({ resolve, signal, b64, question })) },
}, {
  Date: fakeDate(() => clock), window: { __TAURI_INTERNALS__: {} },
  setTimeout: (fn) => { pollTimers.set(++timerId, fn); return timerId; },
  clearTimeout: (id) => pollTimers.delete(id),
})(fileURLToPath(new URL("../src/plugins/screen-awareness/index.ts", import.meta.url))).default;
await isolated.init({ config: { enabled: false }, setConfig() {}, bus: { emit() {} } });
const isolatedApi = isolated.publicApi;
await isolatedApi.setEnabled(true); await flush();
assert.equal(pendingVision.length, 1);
assert.equal(pendingVision[0].b64, "synthetic-test-frame");
assert.match(pendingVision[0].question, /"title":"画图"/);
assert.match(pendingVision[0].question, /"ocrCandidates":"蓝色的画布"/);
async function poll(patch, advance = 8000) {
  clock += advance;
  nextFrame = { ...nextFrame, ...patch, capturedAt: clock };
  const [id, cb] = [...pollTimers][0];
  pollTimers.delete(id); await cb(); await flush();
}
await poll({ title: "记事本", text: "新窗口里的正文", windowId: "102" });
assert.equal(pendingVision[0].signal.aborted, true);
pendingVision[0].resolve("旧窗口里是一幅蓝色画"); await flush();
assert.equal(isolatedApi.snapshot().scene, "");
await poll({}, 90_000);
assert.equal(pendingVision.length, 2);
pendingVision[1].resolve("这里是新的正文"); await flush();
assert.equal(isolatedApi.snapshot().scene, "这里是新的正文");
assert.equal(isolatedApi.snapshot().aiSummary, "这里是新的正文");
assert.equal(isolatedApi.snapshot().aiSummaryAt, nextFrame.capturedAt);
await poll({});
assert.equal(pendingVision.length, 2, "30 秒内不重复请求视觉模型");
assert.equal(isolatedApi.snapshot().aiSummary, "这里是新的正文");
await poll({ title: "银行登录" });
assert.equal(isolatedApi.snapshot().status, "paused");
assert.equal(isolatedApi.snapshot().scene, "");
assert.equal(isolatedApi.snapshot().aiSummary, "");
assert.equal(sent.at(-1).summary, "");
await poll({ title: "陪伴桌宠", pauseReason: "self", text: "自身聊天不能作为观察" });
assert.equal(isolatedApi.snapshot().pauseReason, "self");
assert.equal(isolatedApi.snapshot().capturedAt, 0);
assert.match(isolatedApi.snapshot().decision, /自身窗口/);
assert.equal(isolatedApi.snapshot().summary, "");
for (const [reason, expected] of Object.entries({ desktop: /桌面/, shell: /任务栏|系统外壳/, unavailable: /没有可采集/, occluded: /遮挡.*80%/ })) {
  await poll({ title: "银行登录", pauseReason: reason, text: "上一窗口的内容", maskedRegions: 2 });
  const snapshot = isolatedApi.snapshot();
  assert.equal(snapshot.status, "paused");
  assert.equal(snapshot.pauseReason, reason);
  assert.match(snapshot.decision, expected);
  assert.doesNotMatch(snapshot.decision, /敏感/);
  assert.match(snapshot.decision, /抹白 2 个/);
  for (const key of ["title", "summary", "scene", "aiSummary", "windowId"]) assert.equal(snapshot[key], "");
  assert.equal(snapshot.capturedAt, 0);
  assert.equal(snapshot.keptLineCount, 0);
  assert.equal(sent.at(-1).decision, snapshot.decision);
  assert.equal(sent.at(-1).filteredLineCount, snapshot.rawLineCount);
}
const selectedBody = [
  "这是文章中真正的正文内容，包含足够长的说明来证明当前页面存在可以阅读的主要段落。",
  "第二段继续解释屏幕筛选规则，顶部菜单和左边的短导航都不应该混入传给视觉服务的文字。",
];
const selectedLines = [
  { text: "File Edit View Go Run Help", left: 5, top: 5, width: 500, height: 24 },
  { text: "首页", left: 10, top: 160, width: 60, height: 24 },
  ...selectedBody.map((text, i) => ({ text, left: 250, top: 180 + i * 40, width: 520, height: 24 })),
];
await poll({ title: "文章 - Chrome", windowId: "201", pauseReason: "", text: "旧格式中的工具栏不应进prompt", lines: selectedLines }, 90_000);
let newestVision = pendingVision.at(-1);
assert.match(newestVision.question, /"ocrCandidates":"这是文章中真正的正文/);
assert.ok(!newestVision.question.includes("File Edit"));
assert.ok(!newestVision.question.includes("首页"));
assert.ok(!newestVision.question.includes("旧格式中的工具栏"));
assert.equal(isolatedApi.snapshot().summary, selectedBody.join("\n"));
assert.equal(sent.at(-1).rawLineCount, 4);
assert.equal(sent.at(-1).keptLineCount, 2);
assert.equal(sent.at(-1).filteredLineCount, 2);
assert.equal(capturedWindows.at(-1).expectedWindowId, "201");
assert.equal(capturedWindows.at(-1).expectedTitle, "文章 - Chrome");

// 新 lines 中出现敏感行，筛选后正文指纹不变，也必须取消旧视觉请求且不发送截图。
const beforeSensitiveVision = pendingVision.length;
const beforeSensitiveCapture = capturedWindows.length;
const fullOcrLines = [
  ...selectedLines,
  ...Array.from({ length: 175 }, () => ({ ...selectedLines[0] })),
  { text: "password=synthetic-secret", left: 250, top: 400, width: 300, height: 24 },
];
const truncatedRawText = fullOcrLines.map(line => line.text).join("\n").slice(0, 3000);
assert.equal(fullOcrLines.length, 180);
assert.equal(truncatedRawText.length, 3000);
assert.ok(!truncatedRawText.includes("password"), "敏感行位于原生text截断之外");
await poll({ text: truncatedRawText, lines: fullOcrLines }, 90_000);
assert.equal(newestVision.signal.aborted, true);
assert.equal(pendingVision.length, beforeSensitiveVision);
assert.equal(capturedWindows.length, beforeSensitiveCapture);
assert.equal(isolatedApi.snapshot().status, "paused");
assert.equal(isolatedApi.snapshot().pauseReason, "sensitive");
assert.equal(isolatedApi.snapshot().summary, "");
assert.equal(isolatedApi.snapshot().rawLineCount, 180);
assert.equal(isolatedApi.snapshot().filteredLineCount, 180);
assert.ok(!JSON.stringify(sent.at(-1)).includes("synthetic-secret"));
newestVision.resolve("过时的图像描述"); await flush();
assert.equal(isolatedApi.snapshot().aiSummary, "");

// 无正文的截图提示词只能描述画面；切窗错误也要清空并隔离迟到模型结果。
await poll({ title: "空白画布", windowId: "202", text: "", lines: [], maskedRegions: 0 }, 90_000);
newestVision = pendingVision.at(-1);
assert.match(newestVision.question, /没有读到可靠文字/);
assert.match(newestVision.question, /只根据画面.*不要猜测用户正在进行的活动/);
observationError = new Error("前台窗口已变化");
await poll({});
assert.equal(isolatedApi.snapshot().status, "waiting");
assert.equal(isolatedApi.snapshot().error, "");
assert.match(isolatedApi.snapshot().decision, /前台窗口已变化/);
assert.equal(newestVision.signal.aborted, true);
newestVision.resolve("切窗前的迟到描述"); await flush();
for (const key of ["title", "summary", "scene", "aiSummary"]) assert.equal(isolatedApi.snapshot()[key], "");
assert.equal(isolatedApi.snapshot().rawLineCount, 0);
assert.equal(isolatedApi.snapshot().capturedAt, 0);
observationError = new Error("OCR 模拟不可用");
await poll({});
assert.equal(isolatedApi.snapshot().status, "error");
assert.equal(isolatedApi.snapshot().summary, "");
assert.match(isolatedApi.snapshot().decision, /采集失败/);
captureError = new Error("前台窗口已变化");
const visionCountBeforeCaptureError = pendingVision.length;
await poll({ text: "", lines: selectedLines, title: "截图前的窗口", windowId: "203" }, 90_000);
assert.equal(isolatedApi.snapshot().status, "waiting", "截图阶段发生切窗也必须等待新帧");
assert.equal(isolatedApi.snapshot().summary, "");
assert.equal(isolatedApi.snapshot().capturedAt, 0);
assert.equal(isolatedApi.snapshot().rawLineCount, 0);
assert.equal(pendingVision.length, visionCountBeforeCaptureError);
await isolatedApi.setEnabled(false); await flush();
assert.equal(sent.at(-1).enabled, false);
assert.equal(sent.at(-1).rawLineCount, 0);
assert.equal(sent.at(-1).keptLineCount, 0);
assert.equal(sent.at(-1).summary, "");
console.log("screen-awareness: 晚到视觉隔离、五种暂停原因、遮挡计数、筛选字段广播、lines敏感行拦截、无文字prompt、切窗waiting、关闭清空通过");
