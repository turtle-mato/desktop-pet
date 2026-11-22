// 语言习惯自测：只跑纯规则那一层（不联网、不发 LLM）
//
// 覆盖三件事：
//   ① detectCorrection：他哪些话算"在纠正我"，哪些不算（宁可漏记也不要记错）
//   ② validateHabits：证据校验——引不到真实消息的说法必须被丢弃
//   ③ matchHabits + 去重：他这句话会不会踩到账本里的习惯
//
// 实现方式：本文件负责"生成 + 运行"，生成的 .tmp-habits-test.ts 里才是真正的断言，
// 中文用 JSON.stringify 注入（避免一层层转义把人绕晕）。
// 输出用 shell 重定向收（沙箱下子进程管道会被拒，见 HANDOFF §五）。
//
// 用法：node tools/test-habits.mjs
// 调试：设 MIND_KEEP_TMP=1 保留生成的 .ts，可直接 node .tmp-habits-test.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, ".tmp-habits-test.ts");

/** 中文原样写，交给 JSON.stringify 转成安全字面量 */
const J = (s) => JSON.stringify(s);

// ---- 用例：他确实在纠正我（值得记） ----
const shouldHit = [
  ["我说废话的意思是吃过了，你问得蠢", ""],
  ["你理解错了，我是说今天不用等我", "那你去吃啊"],
  ["啊不是，我的意思是你别熬夜了", "你少熬点儿吧"],
  ["我说的是明天，不是今天", "你不是说今晚要通宵吗"],
  ["你误会了，我不是那个意思", "你是不是不想理我"],
];
// ---- 用例：平常说话（绝不能记） ----
const shouldMiss = [
  "今天中午吃什么",
  "在吗",
  "行吧",
  "随便你怎么想",
  "这题我算出来了",
  "我下午三点开会，别打扰我",
  // 只说"我的意思是…"、既没说"你理解错了"也没带我改口的语气
  // → 他是在自言自语地解释，不是在纠正她，不该记（这种交给日总结那条路）
  "我的意思是随你",
];

const src = `
import { detectCorrection, matchHabits } from "./server/lib/habits.ts";
import { validateHabits } from "./server/lib/validate.ts";
import { appendHabits, loadHabits, saveHabits, rebuildHabitIndex, habitKey, type Habit } from "./server/lib/store.ts";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (extra ? "  ← " + extra : "")); }
};

const shouldHit: [string, string][] = ${J(shouldHit)};
const shouldMiss: string[] = ${J(shouldMiss)};
const PET = ${J("那你去吃啊")};

console.log("[1] detectCorrection：他哪些话算「在纠正我」");
for (const [text, pet] of shouldHit) {
  const hist = pet ? [{ role: "pet", content: pet }] : [];
  const hit = detectCorrection(text, hist);
  ok("应命中：" + text, !!hit, hit ? "" : "没认出来");
  if (hit) console.log("       → 「" + hit.expr + "」= " + hit.meaning + "（可信 " + hit.confidence + "）");
}
for (const text of shouldMiss) {
  const hit = detectCorrection(text, [{ role: "pet", content: PET }]);
  ok("不该命中：" + text, !hit, hit ? "误记成「" + hit.expr + "」= " + hit.meaning : "");
}

console.log("[2] validateHabits：引不到真实消息的说法必须丢弃");
const date = "2026-10-06";
const valid = new Set(["m_real_0001", "m_real_0002"]);
const v = validateHabits(
  {
    habits: [
      { key: "废话", meaning: "他早就做过了", evidence: ["m_real_0001"], tone: "嫌弃" },
      { key: "编造的习惯", meaning: "引用不存在的 id", evidence: ["m_fake_9999"] },
      { key: "a", meaning: "太短，不算说法", evidence: ["m_real_0001"] },
      { key: "已经记过的", meaning: "跟现有一模一样", evidence: ["m_real_0002"] },
      { key: "missing meaning", evidence: ["m_real_0002"] },
    ],
  },
  valid, date, new Date().toISOString(), ["已经记过的"],
);
ok("保留 1 条、丢弃 4 条", v.habits.length === 1 && v.dropped.length === 4,
   "实得保留 " + v.habits.length + " / 丢弃 " + v.dropped.length);
ok("保留的那条证据都是真的", v.habits.every((h) => h.evidence.every((id) => valid.has(id))));
ok("语气被规范到词表里", v.habits[0]?.tone === ${J("嫌弃")}, String(v.habits[0]?.tone));
for (const d of v.dropped) console.log("       ✗ [" + d.reason + "] " + d.detail);

console.log("[3] matchHabits：他这句话会不会踩到习惯（用真账本，跑完还原）");
const backup = JSON.stringify(loadHabits());
try {
  saveHabits([]);
  const today = "2026-10-06";
  const base = (key: string, meaning: string, extra: Partial<Habit> = {}): Habit => ({
    id: "hb_test_" + habitKey(key).slice(0, 6),
    key, meaning, tags: [], confidence: 0.7, confirmations: 1, evidence: [],
    source: "import", first_seen: today, last_seen: today,
    created_at: new Date().toISOString(), edited_by: null, ...extra,
  });
  const r1 = appendHabits([base("废话", "他早就做过了")]);
  const r2 = appendHabits([base("废话", "他早就做过了", { last_seen: "2026-10-07" })]);
  const rows = loadHabits();
  ok("首次入账 +1", r1.added === 1 && r1.merged === 0);
  ok("同一说法跨天只算确认、不新增", r2.added === 0 && r2.merged === 1 && rows.length === 1);
  ok("确认次数上浮", rows[0].confirmations === 2 && rows[0].confidence > 0.7,
     "conf=" + rows[0].confidence + " n=" + rows[0].confirmations);

  // 包含关系也算同一条：先说「废话」，后来说「我说的废话的意思是…」抽出「的废话」
  // （真实踩过：不处理的话账本里会出现两条几乎一样的）
  const r3 = appendHabits([base("的废话", "早就吃过了", { last_seen: "2026-10-08" })]);
  ok("包含关系不新增（仍是同一条）", r3.added === 0 && r3.merged === 1 && loadHabits().length === 1,
     "added=" + r3.added + " merged=" + r3.merged + " n=" + loadHabits().length);
  ok("留下更完整的原话", loadHabits()[0].key === "的废话", loadHabits()[0].key);

  rebuildHabitIndex(rows);
  const hit = matchHabits("废话，谁家好人半夜10点还没吃饭");
  ok("原话出现 → 命中（哪怕账本里留的是更长的「的废话」）", hit.length === 1 && hit[0].score >= 4,
     "命中 " + hit.length + " 条");
  const miss = matchHabits("今天天气不错");
  ok("不相干的话 → 不命中", miss.length === 0, "误命中 " + miss.map((m) => m.habit.key).join(","));
} finally {
  saveHabits(JSON.parse(backup) as Habit[]);
  rebuildHabitIndex();
}

console.log("\\n" + (fail ? "❌ 失败 " + fail + " 项（通过 " + pass + "）" : "✅ 全部通过（" + pass + " 项）"));
if (fail) process.exitCode = 1;
`;

fs.writeFileSync(script, src, "utf8");

const outFile = path.join(root, ".tmp-habits-out.txt");
spawnSync(`node "${script}" > "${outFile}" 2>&1`, { cwd: root, shell: true, stdio: "inherit" });
const raw = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "(没有输出)";
try { fs.rmSync(outFile); } catch {}
if (!process.env.MIND_KEEP_TMP) { try { fs.rmSync(script); } catch {} }

process.stdout.write(raw.endsWith("\n") ? raw : raw + "\n");
process.exitCode = /失败|Error/.test(raw) ? 1 : 0;
