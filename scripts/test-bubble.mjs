import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { tsLoader, fakeDate } from "./test-utils.mjs";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

let clock = 1_800_000_000_000;
const timers = new Map();
let nextId = 0;
class Element {
  children = []; events = {}; attrs = {}; hidden = false; textContent = ""; offsetHeight = 100;
  classes = new Set();
  classList = { add: (v) => this.classes.add(v), remove: (v) => this.classes.delete(v) };
  setAttribute(k, v) { this.attrs[k] = v; }
  append(...children) { this.children.push(...children.flat()); }
  addEventListener(name, fn) { this.events[name] = fn; }
  contains(el) { return this === el || this.children.some((c) => c instanceof Element && c.contains(el)); }
  fire(name, args = {}) { this.events[name]?.(args); }
}
function h(_tag, attrs = {}, ...children) {
  const el = new Element(); el.className = attrs.class; el.append(...children); return el;
}
const changed = [];
const { createSpeechBubble } = tsLoader({
  "./dom": { h, button: (text, cls, cb) => { const el = h("button", { class: cls }, text); el.fireClick = cb; return el; } },
}, {
  Date: fakeDate(() => clock), Event: class { constructor(type) { this.type = type; } },
  window: { dispatchEvent: (event) => changed.push(event.type) },
  setTimeout: (fn, ms) => { timers.set(++nextId, { fn, at: clock + ms }); return nextId; },
  clearTimeout: (id) => timers.delete(id),
})(fileURLToPath(new URL("../src/ui/speechBubble.ts", import.meta.url)));
function advance(ms) {
  const until = clock + ms;
  for (;;) {
    const next = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    clock = next[1].at; timers.delete(next[0]); next[1].fn();
  }
  clock = until;
}
let replied = 0;
const speech = createSpeechBubble(() => replied++);
const bubble = speech.element;
const text = bubble.children[1];
assert.equal(bubble.hidden, true);
speech.show("<script>只是一段文字</script>", "initiative");
assert.equal(bubble.hidden, false); assert.equal(text.textContent, "<script>只是一段文字</script>");
advance(5000); bubble.fire("mouseenter"); advance(60_000);
assert.equal(bubble.hidden, false, "悬停时保持可读");
bubble.fire("focusin"); bubble.fire("mouseleave"); advance(60_000);
assert.equal(bubble.hidden, false, "键盘聚焦时也不消失");
bubble.fire("focusout", { relatedTarget: null }); advance(7200);
assert.equal(bubble.hidden, true, "移开后按剩余时间收起");
speech.show("第一条"); speech.show("第二条"); speech.show("第二条");
assert.equal(text.textContent, "第一条", "阅读期间新消息不覆盖");
bubble.children[0].fireClick(); advance(180);
assert.equal(text.textContent, "第二条");
advance(12_180); assert.equal(bubble.hidden, true, "重复的第二条没有排队两次");
speech.show("可以回复的消息"); speech.show("后续消息");
bubble.children[2].children[0].fireClick(); advance(180);
assert.equal(replied, 1); assert.equal(bubble.hidden, true, "回复会打开聊天并清空提示队列");
speech.show("按 Esc 关闭"); bubble.fire("keydown", { key: "Escape", stopPropagation() {} }); advance(180);
assert.equal(bubble.hidden, true); assert.ok(changed.includes("pet:bubble"));
console.log("bubble: 文本安全、悬停/聚焦暂停、剩余阅读时间、消息排队去重、关闭/回复/Esc、布局通知通过");

// 执行真实的新消息转发回调：mini 自己生成的消息也应立即显示，恢复历史不弹旧气泡。
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.ESNext, true);
let relay;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'bus.on' && node.arguments[0]?.getText(ast) === '"chat:pet"' && node.arguments[1]?.getText(ast).includes('"pet:bubble"')) relay = node.arguments[1].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast); assert.ok(relay);
const local = [], broadcast = [];
const route = {};
vm.runInNewContext(ts.transpileModule(`exports.run = ${relay}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: route, bus: { emit: (name, payload) => local.push({ name, payload }) },
  emitAll: async (name, payload) => broadcast.push({ name, payload }), winLabel: "mini",
});
route.run({ text: "这是一条主动消息", kind: "initiative" });
assert.equal(local.length, 1); assert.equal(broadcast.length, 1); assert.equal(local[0].payload.kind, "initiative");
route.run({ text: "旧消息", kind: "initiative", restore: true });
route.run({ text: "系统消息", kind: "sys" });
assert.equal(local.length, 1); assert.equal(broadcast.length, 1);
console.log("bubble: 小窗本地产生的消息立即显示、跨窗广播一次、恢复历史和系统消息不弹泡通过");
