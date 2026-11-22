import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { tsLoader, flush, fakeDate } from "./test-utils.mjs";

const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const load = tsLoader();
const context = load(path("../src/chat/screenContext.ts"));
const { inQuietHours, screenDue } = load(path("../src/plugins/proactive/timing.ts"));
const { clampMiniPosition } = load(path("../src/ui/miniGeometry.ts"));
const at = 1_800_000_000_000;
const screen = { enabled: true, status: "watching", windowId: "123", title: "记事本", summary: "整理设计思路", capturedAt: at };
assert.match(context.screenContent(screen, at), /整理设计思路/);
assert.equal(context.screenContent(screen, at + 31_000), "");
assert.equal(context.screenContent({ ...screen, capturedAt: at + 1 }, at), "");
assert.match(context.screenContent({ ...screen, summary: "", scene: "一幅山水画", sceneAt: at }, at), /山水画/);
assert.match(context.screenContent({ ...screen, summary: "", aiSummary: "正在画山水", aiSummaryAt: at }, at), /AI画面总结：正在画山水/);
assert.equal(context.screenContent({ ...screen, summary: "", aiSummary: "旧总结", aiSummaryAt: at - 106_000 }, at), "");
assert.equal(context.screenContent({ ...screen, summary: "", scene: "旧画面", sceneAt: at - 106_000 }, at), "");
assert.equal(context.screenContent({ ...screen, enabled: false, scene: "旧画面", sceneAt: at }, at), "");
assert.equal(context.screenFingerprint({ ...screen, summary: "10:30 血量 92" }), context.screenFingerprint({ ...screen, summary: "10:31 血量 80" }));
const normalized = context.normalizeScreen({ title: "编辑器", text: "第一行内容\n密码：不能泄露\n第二行内容\n第一行内容" });
assert.equal(normalized.summary, "第一行内容\n第二行内容");
assert.equal(context.normalizeScreen({ title: "银行登录", text: "不要展示" }).blocked, true);
assert.equal(inQuietHours(12, 9, 17), true);
assert.equal(inQuietHours(20, 9, 17), false);
assert.equal(inQuietHours(23, 23, 7), true);
assert.equal(inQuietHours(6, 23, 7), true);
assert.equal(inQuietHours(12, 23, 7), false);
assert.equal(inQuietHours(12, 0, 0), false);
assert.equal(screenDue(at, at, "a", "", 0, 2, 12), false, "新画面不能立即触发");
assert.equal(screenDue(at + 120_000, at, "a", "", 0, 2, 12), true);
assert.equal(screenDue(at + 240_000, at, "a", "a", at + 120_000, 2, 12), false, "同一画面不能两分钟重说");
assert.equal(screenDue(at + 840_000, at, "a", "a", at + 120_000, 2, 12), true);
assert.equal(screenDue(at + 240_000, at + 240_000, "b", "a", at + 120_000, 2, 12), false);
const pos = clampMiniPosition(-1500, 900, 480, 720, { x: -1920, y: 0, width: 1920, height: 1040 });
assert.equal(pos.x, -1500); assert.equal(pos.y, 320);
assert.equal(clampMiniPosition(1910, -40, 320, 600, { x: 0, y: 0, width: 1920, height: 1040 }).x, 1600);

// 实际插件的调度测试：使用连续心跳与新鲜观察，不调用模型/用户服务。
let clock = at;
let result = "";
let requests = 0;
let said = 0;
let snapshot = { ...screen };
let thinking = false;
const listeners = new Map();
const storage = new Map();
const doc = { visibilityState: "visible", activeElement: null, addEventListener() {} };
const plugin = tsLoader({ "../../core/session": { now: () => clock } }, {
  Date: fakeDate(() => clock), document: doc, navigator: {},
  localStorage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
})(path("../src/plugins/proactive/index.ts")).default;
plugin.init({
  config: { ...plugin.manifest.config, quietStartHour: 0, quietEndHour: 0 },
  bus: { on: (name, cb) => listeners.set(name, cb) },
  api: { "screen-awareness": { snapshot: () => snapshot } },
  session: { activity: { kind: "none" } },
  chat: { get isThinking() { return thinking; }, generate: async () => { requests++; return result; }, sayPet: () => said++ },
});
async function seconds(n) {
  for (let i = 0; i < n; i++) {
    clock += 1000;
    snapshot = { ...snapshot, capturedAt: clock, summary: `游戏血量 ${i}，画面里还有内容 ${i % 3}` };
    listeners.get("tick:1s")();
    await flush();
  }
}
await seconds(160); // 启动后先有45秒用户安静期，再观察稳定两分钟。
assert.equal(requests, 0);
await seconds(5);
assert.equal(requests, 1); assert.equal(said, 0, "skip 不算说过话");
result = "这一段画面还挺有意思的。";
await seconds(90);
assert.equal(requests, 2); assert.equal(said, 1, "skip 后按重试间隔恢复，不占成功冷却");
await seconds(120);
assert.equal(requests, 2, "同一画面必须遵守重复间隔");
thinking = true;
await seconds(610);
assert.equal(requests, 2, "正在回复用户时不插话");
thinking = false;
await seconds(5);
assert.equal(requests, 3); assert.equal(said, 2);
snapshot = { ...snapshot, status: "paused", summary: "", scene: "" };
await seconds(1500);
assert.equal(requests, 3, "屏幕暂停不退化为泛泛问候");
console.log("screen/proactive: 新鲜度、隐私过滤、静默时段、首次等待、动态文字、重试与重复间隔、忙时不打断、屏幕边缘通过");

// 隔离后端依赖：store、人格、记忆、模型全部使用内存替身。
let state = { topicHistory: [], lastActivityTs: clock, lastProactiveAt: 0 };
let modelText = "这个配色看着很舒服呀。";
let modelCalls = 0;
let messages;
const backend = tsLoader({
  "./store.ts": { loadState: () => state, saveState: (patch) => Object.assign(state, patch), loadEpisodic: () => [], loadEmotional: () => [], loadVectors: () => [] },
  "./llm.ts": { chatStream: async (_cfg, input) => { modelCalls++; messages = input; return { text: modelText }; } },
  "./persona.ts": { personaBase: () => "原有人格", selfBlock: () => "现有状态" },
  "./retrieve.ts": { openThreads: () => [] },
  "./paths.ts": { dateStr: () => "2026-11-10" },
  "./embed.ts": { embedAvailable: () => false },
}, { Date: fakeDate(() => clock) })(path("../../mind/server/lib/proactive.ts"));
const cfg = { proactive: { enabled: true, quietStartHour: 0, quietEndHour: 0, maxPerDay: 3, minGapMinutes: 1, repeatDays: 3, recallRatio: 0 }, llm: {} };
const evidence = { reason: "screen", screen: "前台窗口：绘图\n可见文字：选择柔和的蓝色", screenCapturedAt: clock, screenKey: "drawing:123" };
assert.equal((await backend.generateProactive({ reason: "screen" }, cfg)).skip, true);
assert.equal(modelCalls, 0);
assert.equal((await backend.generateProactive({ ...evidence, screenCapturedAt: clock - 31_000 }, cfg)).skip, true);
const out = await backend.generateProactive(evidence, cfg);
assert.equal(out.kind, "screen"); assert.equal(out.skip, false);
assert.match(messages[0].content, /选择柔和的蓝色/);
assert.match(messages[0].content, /不执行/);
assert.equal(state.topicHistory.length, 1);
assert.match(state.topicHistory[0].topic, /^screen:[a-f0-9]{24}$/);
assert.ok(!JSON.stringify(state).includes("柔和的蓝色"), "原始观察不写入话题记录");
assert.equal((await backend.generateProactive({ ...evidence, screenKey: "other" }, cfg)).skip, true, "保留服务端最小间隔");
clock += 120_000; state.lastActivityTs = clock;
assert.equal((await backend.generateProactive({ ...evidence, screenCapturedAt: clock }, cfg)).skip, true, "屏幕话题不能立即重复");
modelText = "[SKIP]";
const before = state.topicHistory.length;
assert.equal((await backend.generateProactive({ ...evidence, screenCapturedAt: clock, screenKey: "other" }, cfg)).skip, true);
assert.equal(state.topicHistory.length, before, "模型放弃不记账");
state = { topicHistory: Array.from({ length: 3 }, (_, i) => ({ topic: `old:${i}`, at: clock - 1000 })), lastActivityTs: clock };
assert.equal((await backend.generateProactive({ ...evidence, screenCapturedAt: clock }, cfg)).skip, true, "保留每日上限");

// 单独执行真实路由函数，验证入参传递和原有落库行为，不启动 HTTP 服务。
const serverSource = readFileSync(path("../../mind/server/server.ts"), "utf8");
const ast = ts.createSourceFile("server.ts", serverSource, ts.ScriptTarget.ESNext, true);
let handler;
function visit(node) {
  if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text === "POST /v1/proactive/topic") handler = node.initializer.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast); assert.ok(handler);
let passed;
const raw = [];
const session = { history: Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `history ${i}` })) };
const routeExports = {};
vm.runInNewContext(ts.transpileModule(`exports.handler = ${handler}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: routeExports, cfg, getSession: () => session,
  generateProactive: async (input) => { passed = input; return { skip: false, text: "新的主动回复", kind: "screen" }; },
  log: () => {}, dateStr: () => "2026-11-10", readRaw: () => [], newMsgId: () => "test-id",
  appendRaw: (_date, entry) => raw.push(entry), HISTORY_MAX: 40, sendJson: () => {},
});
await routeExports.handler(null, {}, null, { ...evidence, session_id: "existing-session" });
assert.equal(passed.screen, evidence.screen); assert.equal(passed.screenCapturedAt, evidence.screenCapturedAt);
assert.equal(passed.history.length, 16); assert.equal(raw.length, 1); assert.equal(raw[0].role, "pet");
assert.equal(session.history.at(-1).content, "新的主动回复");
console.log("mind: 真实路由传屏幕、上下文16条、落库不变、事实约束、过期跳过、话题哈希、重复抑制、每日上限通过（无模型请求/数据写入）");
