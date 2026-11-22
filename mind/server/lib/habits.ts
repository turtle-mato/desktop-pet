// 哥哥的习惯（情景记忆的一个分支）：哥哥是怎么说话的，以及"他这么说到底什么意思"。
//
// 这一支存在的理由（HANDOFF §8.3）：
//   她判断"是我理解错了 / 是他话说得含糊"靠的是模型常识，而常识里没有"哥哥"这个人。
//   所以要把每次纠正沉淀下来 —— 记一次，以后遇到同一个说法就有据可判，而不是每次重新猜。
//
// 三条路往这个库里写（前两条都是零 LLM 成本或极低成本）：
//   ① 实时纠正入账 detectCorrection()：他当场说"我说 X 的意思是 Y" → 立刻记，不等日总结；
//   ② 日总结抽取 buildHabitMessages()：他平时解释过的说法，日总结时一起抽出来；
//   ③ 手工导入 / 面板编辑。
// 读的一方只有一处：matchHabits() → injectText() → 注入提示词的【哥哥的习惯】段。
import type { MindConfig } from "./config.ts";
import {
  loadHabits, habitKey, trimHabitKey, isSameHabit, coreHabitKey, type Habit,
} from "./store.ts";
import { tokenize, uniq, clip } from "./text.ts";
import { dateStr } from "./paths.ts";

/** 归一化一句"表达"：去成对引号、去首尾标点、压缩空白（用作 key 时再走 habitKey） */
export function normalizeExpr(s: string): string {
  return String(s ?? "")
    .replace(/^[\s「"'"'『（(【]+/, "")
    .replace(/[\s」"'"'』）)】。，、！？；：…,.!?;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const clipKey = (s: string) => clip(normalizeExpr(s), 24).replace(/…$/, "");

// 对外沿用习惯的写法；权威实现在 store.ts（那里是数据层，habits 依赖它，不能反过来）
export const keyOf = (kw: string) => habitKey(kw);
export { isSameHabit, coreHabitKey as coreKey };

/** 一句话里最长的中文/英文片段（当作"他的原话"） */
function longestChunk(s: string, min = 2): string {
  const parts = String(s ?? "")
    .split(/[，。！？；、,.!?;:：\n\r\t（）()【】「」""'']+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= min);
  parts.sort((a, b) => b.length - a.length);
  return parts[0] ?? "";
}

// ---------------- ① 实时纠正检测（纯规则，不发 LLM，毫秒级） ----------------
export interface CorrectionHit {
  /** 他的原话/说法 */
  expr: string;
  /** 他这么说的真实意思 */
  meaning: string;
  /** 之前被理解错成的样子 */
  misunderstood?: string;
  confidence: number;
  source: "correct";
  reasons: string[];
}

/** "我说 X 的意思是 Y" / "我说的是 X" / "我是说 X"（"说的"里的"的"是可选的，别让它混进 X） */
const SAY_RE =
  /我(?:说|讲|问)的?是?\s*(?:的意思是|的意思就是)?\s*[「"'『]?\s*([^，。！？；!?;「」""'']{2,40}?)\s*[」"'』]?\s*(?:的意思是|的意思就是|意思是|指的是|是说|代表)/;
/** 只有"我是说 / 我说的是 X"，没给意思（多半是在纠正我理解错了） */
const SAY_ONLY_RE = /我(?:是|说的?是|讲的是|问的是)\s*[「"'『]?\s*([^。！?！？]{2,30})/;
/** "我的意思是…" / "意思是…"：整句就是他这次的真意 */
const MEAN_FULL_RE = /^(?:啊?不是[，、]?\s*)?(?:我的?意思(?:是|就是)?|意思是)\s*[「"'『]?\s*([^「」""'']{2,80})/;
/**
 * "我说的是 X，不是说 Y"：他在纠正"我把他说的记错了"。
 * 这种句子里 X 往往要靠上一句才知道指什么，所以 X 本身不当"说法"，
 * 但它的存在说明"他确实在纠正我"，另给一点可信度。
 */
const SELF_FIX_RE = /我(?:说|讲|问)的?是[^，。！？]{1,20}[，,]?\s*(?:而)?不是/;
/** 只有语气词/纯填充的词不能当成"他的说法" */
const FILLER_ONLY = /^[啊呀嗯哦诶唉呃那个这个就是其实不不]+$/;
/** 开头的口头语/否定起手："啊不是，""不是，""其实我"——剥掉才能露出真正的说法 */
const LEAD_FILLER = /^(?:啊?不是+|其实我|那个|这个|嗯+|呃+|唉+|哦+)[，,、]?\s*/;

/** 剥掉开头的口头语（"啊不是，随你" → "随你"） */
export function stripLead(s: string): string {
  let t = normalizeExpr(s);
  for (let i = 0; i < 3 && t; i++) {
    const next = t.replace(LEAD_FILLER, "");
    if (next === t) break;
    t = normalizeExpr(next);
  }
  return t;
}
/** 他在指出"你理解错了" */
const CORRECT_MARK = /(你(?:理解|听|想|搞|弄|看)错|理解错|不是这个意思|我没这个意思|你误会|误会了|你(?:又|还是)?没听懂|听不懂|你(?:又|还是)?想歪|你搞反|反了|你读错|我什么时候说过|谁跟你说|你确定你懂)/;
/** 他在强调"我这话的意思 / 我的意思是" */
const MEAN_MARK = /(我的?意思|意思是|指的是|说白了|换句话说|我表达的|我不是在说)/;
/** 带点无语的补充说明："啊不是…""其实我…""准确说…" */
const MEND_MARK = /(^|[，。！？\s])(啊?不是|不是[，、]|其实我|准确(?:地)?说|说白(?:了|点))/;

const clean = (s: string): string =>
  normalizeExpr(s)
    .replace(/^[，、。！？\s]*我?说的?\s*(?=(?:这|那|今|明|昨|你|我|他|她|今天|明天))/u, "")
    .replace(/^[的了嘛啊呀]+/, "")
    .trim();

/** 上一句她说的话（她理解错的那句，原样留作"我上次理解错的"） */
function prevPetText(history: { role: string; content: string }[]): string {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].role === "pet") return history[i].content;
  return "";
}

/**
 * 从这一轮对话里认出"他在纠正我"。
 *
 * 刻意保守：宁可漏记，也不要把一句普通闲聊当成习惯记进去（账本脏了就没人看了）。
 * 返回 null = 这不像纠正，什么都不记。
 */
export function detectCorrection(
  userText: string,
  history: { role: string; content: string }[],
  channel?: string,
): CorrectionHit | null {
  void channel;
  const text = String(userText ?? "").trim();
  if (text.length < 4 || text.length > 300) return null;

  const say = text.match(SAY_RE);
  const meanFull = text.match(MEAN_FULL_RE);
  const selfFix = SELF_FIX_RE.test(text);
  const correctMark = CORRECT_MARK.test(text);
  const meanMark = MEAN_MARK.test(text);
  const mendMark = MEND_MARK.test(text);
  const only = text.match(SAY_ONLY_RE);
  // 他给了"真意"（明说 X=Y，或整句就是在解释自己的意思，或"我说的是X不是说Y"）
  const hasMeaning = !!say || !!meanFull || selfFix;

  // 三个信号全无 → 不管
  if (!say && !correctMark && !meanMark && !selfFix) return null;
  // 单纯在解释自己的意思（"我的意思是…"）、既没说她答错、也没带任何"我改口"的语气：
  // 他没有纠正的对象，这是在自言自语，不该记成"他的说话习惯"。
  // （这种解释由日总结那条路去收，那边能看到前后文。）
  const pet = prevPetText(history);
  if (!say && !selfFix && !correctMark && !mendMark) return null;

  // ---- 原话：优先他这次自己的说法；他只在说"你理解错了"时，借她上一句当原话 ----
  let expr = "";
  let exprFromPet = false;
  if (text.includes("理解错") && pet) {
    // 他在否认她答的那句 → 原话就是她刚才答的
    expr = longestChunk(pet);
    exprFromPet = true;
  }
  if (!expr) expr = only?.[1] ?? "";
  if (!expr && say) expr = say[1];
  if (!expr) {
    const before = text.split(/我的?意思/)[0];
    expr = before && before.length >= 2 && before.length <= 24 ? before : "";
  }
  expr = stripLead(expr);
  if (!expr && pet) {
    expr = longestChunk(pet);
    exprFromPet = true;
  }
  expr = clipKey(expr);
  if (expr.length < 2 || FILLER_ONLY.test(habitKey(expr))) return null;

  // 真意：say 的 Y → MEAN_FULL 捕获 → "我是说 X"的 X → 去掉引出语后的整句
  let meaning = say ? clean(say[2]) : meanFull ? clean(meanFull[1]) : "";
  if (!meaning && only) meaning = clean(only[1]);
  if (!meaning) {
    const i = text.search(/我的?意思(?:是|就是)?|意思是/);
    meaning = i >= 0 ? clean(text.slice(i).replace(/^我的?意思(?:是|就是)?|^意思是/, "")) : "";
  }
  if (!meaning) meaning = clean(text);
  meaning = clip(meaning, 60).replace(/…$/, "");
  if (meaning.length < 2) return null;

  const misunderstood = exprFromPet ? clip(pet, 40) : undefined;

  let conf = 0.35;
  const reasons: string[] = [];
  if (say) { conf += 0.3; reasons.push("他明说了「X 的意思是 Y」"); }
  if (meanFull && !say) { conf += 0.15; reasons.push("他在解释自己这句话的意思"); }
  if (correctMark) { conf += 0.2; reasons.push("他明说我理解错了"); }
  if (selfFix) { conf += 0.1; reasons.push("他在澄清「我说的是 X，不是说 Y」"); }
  if (meanMark && !hasMeaning) { conf += 0.05; reasons.push("他在解释自己的意思"); }
  if (mendMark && !hasMeaning) { conf += 0.05; reasons.push("带着补充说明"); }
  if (exprFromPet) { conf -= 0.15; reasons.push("原话取自上一句（他在说我理解错了）"); }
  if (conf < 0.25) return null;

  return {
    expr,
    meaning,
    misunderstood,
    confidence: Math.min(0.95, Math.round(conf * 100) / 100),
    source: "correct",
    reasons,
  };
}

/** 把检测结果变成一条可入账的 Habit */
export function correctionToHabit(hit: CorrectionHit, date = dateStr(), nowIso = new Date().toISOString()): Habit {
  const tags = ["哥哥的习惯"];
  if (hit.misunderstood) tags.push("误解");
  return {
    id: `hb_${date.replace(/-/g, "")}_${Math.random().toString(36).slice(2, 6)}`,
    key: hit.expr,
    meaning: hit.meaning,
    misunderstood: hit.misunderstood,
    tags,
    confidence: hit.confidence,
    confirmations: 1,
    evidence: [],
    source: hit.source,
    first_seen: date,
    last_seen: date,
    created_at: nowIso,
    edited_by: null,
  };
}

// ---------------- ② 日总结抽取（提示词在 prompts.ts，这里只放"现有账本快照"） ----------------
/** 给日总结用的现有习惯清单（喂给 LLM，让它别重复抽已有的） */
export function habitSnapshot(max = 40): string {
  const rows = loadHabits()
    .slice()
    .sort((a, b) => b.confirmations - a.confirmations)
    .slice(0, max);
  if (!rows.length) return "（还没有记过哥哥的习惯）";
  return rows.map((h) => `- ${h.key} → ${clip(h.meaning, 40)}`).join("\n");
}

// ---------------- ③ 读：这次这句话踩到哪几条习惯 ----------------
export interface HabitMatch {
  habit: Habit;
  score: number;
  reasons: string[];
}

/**
 * 匹配当前这句话。
 * 两道信号（都不需要模型）：
 *   ① 原话整串出现在他这句话里（"废话，谁家好人…"）——最强；
 *   ② 倒排 token 命中 —— 他换个说法时还能想起来。
 */
export function matchHabits(
  text: string,
  opts: { limit?: number; minScore?: number } = {},
): HabitMatch[] {
  const limit = opts.limit ?? 3;
  const minScore = opts.minScore ?? 2;
  const q = String(text ?? "").trim();
  if (!q) return [];
  const qTokens = new Set(tokenize(q));
  const qKey = habitKey(q);
  const qTrim = trimHabitKey(qKey);
  const rows = loadHabits();
  if (!rows.length) return [];

  const terms = new Map<string, number>();
  for (const h of rows) {
    for (const t of uniq([...tokenize(h.key), ...tokenize(h.meaning ?? "")])) {
      terms.set(t, (terms.get(t) ?? 0) + 1);
    }
  }

  const out: HabitMatch[] = [];
  // 先给每条习惯算匹配键：把互相包含/只差首尾虚词的说法归成一组，取最短的那个。
  // 这样账本里留的是"废话"还是"的废话"，他一句"废话…"都能命中。
  const cores = new Map<string, string>();
  for (const h of rows) {
    const hk = keyOf(h.key);
    const group = rows.filter((o) => isSameHabit(o.key, h.key)).map((o) => keyOf(o.key));
    cores.set(hk, coreHabitKey(group));
  }

  for (const h of rows) {
    const hk = (cores.get(keyOf(h.key)) || keyOf(h.key));
    const reasons: string[] = [];
    let score = 0;

    if (hk.length >= 2 && qKey.includes(hk)) {
      score += 4;
      reasons.push(`他这句话里就有「${h.key}」`);
    } else if (hk.length >= 2 && qTrim && (qTrim.includes(hk) || hk.includes(qTrim))) {
      score += 3.5;
      reasons.push(`他这句话里就有「${h.key}」`);
    }
    const kt = uniq(tokenize(h.key));
    let hit = 0;
    let idfSum = 0;
    for (const t of kt) {
      if (!qTokens.has(t)) continue;
      hit++;
      const df = terms.get(t) ?? 1;
      idfSum += Math.log(1 + rows.length / df);
    }
    if (hit) {
      const ratio = hit / Math.max(1, kt.length);
      score += 1.2 * ratio + 0.6 * idfSum;
      reasons.push(`用词撞上 ${hit}/${kt.length} 个`);
    }
    if (score >= minScore) out.push({ habit: h, score: Math.round(score * 100) / 100, reasons });
  }

  return out
    .sort((a, b) => b.score * (0.6 + 0.4 * b.habit.confidence) - a.score * (0.6 + 0.4 * a.habit.confidence))
    .slice(0, limit);
}

// ---------------- 注入文本 ----------------
/** 单条习惯的完整写法（面板与注入共用，语义一模一样） */
export function formatHabit(h: Habit): string {
  const bits = [`- 「${h.key}」= ${h.meaning}`];
  if (h.tone) bits.push(`（语气：${h.tone}）`);
  if (h.misunderstood) bits.push(`\n  ↳ 你以前理解成：${clip(h.misunderstood, 40)}（这是错的）`);
  if (h.behavior) bits.push(`\n  ↳ 下次该这么接：${h.behavior}`);
  return bits.join("");
}

/** 注入段正文（受 maxChars 预算约束，超了就丢低分的） */
export function injectText(matches: HabitMatch[], cfg?: MindConfig): string {
  if (!matches.length) return "";
  const cap = cfg?.habits?.maxChars ?? 360;
  const lines: string[] = [];
  let used = 0;
  for (const m of matches) {
    const line = formatHabit(m.habit);
    if (used + line.length > cap) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

/**
 * 给提示词用的一小段行动指令的备用版本。
 * 现在主链路把这段直接写在 prompts.ts 的四步之后（那里位置最好），
 * 这个函数留给"单独试习惯"的场景（CLI habit-try / 调试）。
 */
export function injectGuide(): string {
  return [
    "【怎么用】（这些是事实，不是人设，优先级高于你的性格）",
    "- 他这句话如果踩到上面某条，就按那条的「真实意思」来听，不要按字面怼回去。",
    "- 上面「你以前理解成…」那几条，你这轮**绝不许**再那样理解。",
    "- 用得上就用，用不上就别硬提 —— 这不是要你背给他听的东西。",
  ].join("\n");
}

/** 面板"试一句"用的完整预览（含被匹配到的原因） */
export function previewHabitMatch(text: string, cfg?: MindConfig): {
  matches: { id: string; key: string; meaning: string; score: number; reasons: string[]; confidence: number }[];
  text: string;
} {
  const matches = matchHabits(text, {
    limit: cfg?.habits?.maxInject ?? 3,
    minScore: cfg?.habits?.minScore ?? 2,
  });
  return {
    matches: matches.map((m) => ({
      id: m.habit.id,
      key: m.habit.key,
      meaning: m.habit.meaning,
      score: m.score,
      reasons: m.reasons,
      confidence: m.habit.confidence,
    })),
    text: injectText(matches, cfg),
  };
}
