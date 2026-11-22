// 证据校验：把 LLM 的输出变成"可信的记忆"
// 核心规则：每条情景记忆必须引用真实存在的原始消息 id，否则丢弃（防幻觉记忆）
import type { Episode, Emotion, OpenThread, Habit } from "./store.ts";
import { isSameHabit, habitKey } from "./store.ts";

/** 受限情绪词表（便于统计、配色、接表情） */
export const EMOTIONS = [
  "开心", "平静", "期待", "好奇", "焦虑", "失落", "委屈", "生气", "疲惫", "害羞", "感动", "心疼", "无聊", "得意",
] as const;

export interface DroppedItem {
  reason: string;
  detail: string;
}

export interface RawDigestDraft {
  diary?: string;
  episodes?: any[];
  emotions?: any[];
  open_threads?: any[];
}

export interface Validated {
  diary: string;
  episodes: Episode[];
  emotions: Emotion[];
  openThreads: OpenThread[];
  dropped: DroppedItem[];
}

const clamp = (v: any, lo: number, hi: number, def: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
};

const strArr = (v: any): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : [];

function nearestEmotion(word: string): string {
  const w = (word || "").trim();
  if (!w) return "平静";
  if ((EMOTIONS as readonly string[]).includes(w)) return w;
  // 含相同字 → 归到词表里的近义项
  for (const e of EMOTIONS) if (w.includes(e) || e.includes(w)) return e;
  return "平静";
}

/**
 * 校验并规范化 LLM 的日总结输出
 * @param validIds 当天真实存在的消息 id 集合
 * @param minSalience 拟人价值下限：低于它的记忆不入库（默认 0，即不筛）
 */
export function validateDigest(
  draft: RawDigestDraft,
  validIds: Set<string>,
  date: string,
  nowIso: string,
  minSalience = 0,
): Validated {
  const dropped: DroppedItem[] = [];
  const episodes: Episode[] = [];
  const titleToId = new Map<string, string>();

  const rawEps = Array.isArray(draft.episodes) ? draft.episodes : [];
  rawEps.slice(0, 12).forEach((e: any, i: number) => {
    const title = String(e?.title ?? "").trim();
    const summary = String(e?.summary ?? "").trim();
    if (!title || !summary) {
      dropped.push({ reason: "字段缺失", detail: `第 ${i + 1} 条情景缺少 title/summary` });
      return;
    }
    const evidenceAll = strArr(e?.evidence);
    const valid = evidenceAll.filter((id) => validIds.has(id));
    if (!valid.length) {
      // ★ 防幻觉：引用不到真实消息，直接丢弃
      dropped.push({
        reason: "证据不存在",
        detail: `「${title}」引用了不存在的消息 ${evidenceAll.join(",") || "(空)"}`,
      });
      return;
    }
    const id = `ep_${date.replace(/-/g, "")}_${String(episodes.length + 1).padStart(2, "0")}`;
    const salience = clamp(e?.salience, 0, 1, 0.5);
    // 拟人价值闸门：低于下限的记忆不入库（宁少勿多）
    if (minSalience > 0 && salience < minSalience) {
      dropped.push({
        reason: "拟人价值不够",
        detail: `「${title}」拟人价值 ${salience} < 下限 ${minSalience}，跳过`,
      });
      return;
    }
    titleToId.set(title, id);
    const review = String(e?.review ?? "").trim();
    episodes.push({
      id,
      date,
      title: title.slice(0, 40),
      summary: summary.slice(0, 400),
      time: String(e?.time ?? "").trim().slice(0, 20) || undefined,
      // 复盘：从这件事学到了什么（没有就不写这一栏，不硬凑）
      review: review ? review.slice(0, 200) : undefined,
      people: strArr(e?.people),
      entities: strArr(e?.entities),
      tags: strArr(e?.tags),
      keywords: strArr(e?.keywords),
      salience,
      evidence: valid,
      links: [],
      source: "chat",
      created_at: nowIso,
    });
  });

  const emotions: Emotion[] = [];
  const rawEms = Array.isArray(draft.emotions) ? draft.emotions : [];
  rawEms.slice(0, 12).forEach((m: any, i: number) => {
    const title = String(m?.episode_title ?? m?.episode ?? "").trim();
    const epId = titleToId.get(title) ?? episodes[i]?.id;
    if (!epId) {
      dropped.push({ reason: "情绪无所属情景", detail: `第 ${i + 1} 条情绪找不到对应情景「${title}」` });
      return;
    }
    const evidenceAll = strArr(m?.evidence);
    const valid = evidenceAll.filter((id) => validIds.has(id));
    emotions.push({
      id: `em_${date.replace(/-/g, "")}_${String(emotions.length + 1).padStart(2, "0")}`,
      date,
      episode_id: epId,
      emotion: nearestEmotion(String(m?.emotion ?? "")),
      valence: clamp(m?.valence, -1, 1, 0),
      arousal: clamp(m?.arousal, 0, 1, 0.4),
      cause: String(m?.cause ?? "").slice(0, 200),
      intensity: clamp(m?.intensity, 0, 1, 0.5),
      decay: 0.85,
      evidence: valid.length ? valid : episodes.find((e) => e.id === epId)?.evidence ?? [],
      created_at: nowIso,
    });
  });

  const openThreads: OpenThread[] = [];
  for (const t of Array.isArray(draft.open_threads) ? draft.open_threads : []) {
    const text = String(t?.text ?? "").trim();
    if (!text) continue;
    const episodeId = titleToId.get(String(t?.episode_title ?? "").trim());
    openThreads.push({
      text: text.slice(0, 120),
      since: String(t?.since ?? date).slice(0, 10),
      episode_id: episodeId,
      status: "open",
    });
  }

  return {
    diary: String(draft.diary ?? "").trim().slice(0, 2000),
    episodes,
    emotions,
    openThreads,
    dropped,
  };
}

// ---------------- 哥哥的习惯（情景记忆的分支） ----------------

/** 语气词表：跟情绪词表一样限死，免得同一种语气攒出七八种写法 */
export const TONES = ["反讽", "嫌弃", "逗你", "敷衍", "认真", "无奈", "试探", "自嘲"] as const;

function nearestTone(word: string): string {
  const w = (word || "").trim();
  if (!w) return "";
  if ((TONES as readonly string[]).includes(w)) return w;
  for (const t of TONES) if (w.includes(t) || t.includes(w)) return t;
  return "";
}

export interface RawHabitDraft {
  habits?: any[];
}

/**
 * 校验「哥哥的习惯」——规则和情景记忆一样硬：**引不到真实消息的说法不许入账**。
 * 另外两层筛子：
 *   ① 长度（说法 2~24 字、真意 2~80 字）：太长的多半是整句话，不是"说法"；
 *   ② 与现有账本按 habitKey 去重（避免日总结和实时纠正重复记）。
 */
export function validateHabits(
  draft: RawHabitDraft,
  validIds: Set<string>,
  date: string,
  nowIso: string,
  existingKeys: string[] = [],
): { habits: Habit[]; dropped: DroppedItem[] } {
  const dropped: DroppedItem[] = [];
  const habits: Habit[] = [];
  const seen: string[] = [];
  const raw = Array.isArray(draft?.habits) ? draft.habits : [];

  raw.slice(0, 8).forEach((h: any, i: number) => {
    const key = String(h?.key ?? "").trim();
    const meaning = String(h?.meaning ?? "").trim();
    if (!key || !meaning) {
      dropped.push({ reason: "字段缺失", detail: `第 ${i + 1} 条习惯缺少 key/meaning` });
      return;
    }
    if (key.length < 2 || key.length > 24) {
      dropped.push({ reason: "说法长度不合适", detail: `「${key}」不是"说法"该有的长度（2~24 字）` });
      return;
    }
    if (meaning.length < 2) {
      dropped.push({ reason: "真意太短", detail: `「${key}」的 meaning 没有信息量` });
      return;
    }
    const nk = habitKey(key);
    if (existingKeys.some((k) => isSameHabit(k, key)) || seen.some((k) => isSameHabit(k, key))) {
      dropped.push({ reason: "已有同样说法", detail: `「${key}」账本里已经记过了` });
      return;
    }
    const evidenceAll = strArr(h?.evidence);
    const valid = evidenceAll.filter((id) => validIds.has(id));
    if (!valid.length) {
      // ★ 防幻觉：跟情景记忆同一条底线
      dropped.push({
        reason: "证据不存在",
        detail: `「${key}」引用了不存在的消息 ${evidenceAll.join(",") || "(空)"}`,
      });
      return;
    }
    seen.push(nk);
    habits.push({
      id: `hb_${date.replace(/-/g, "")}_${String(habits.length + 1).padStart(2, "0")}`,
      key: key.slice(0, 24),
      meaning: meaning.slice(0, 80),
      misunderstood: String(h?.misunderstood ?? "").trim().slice(0, 40) || undefined,
      tone: nearestTone(String(h?.tone ?? "")) || undefined,
      behavior: String(h?.behavior ?? "").trim().slice(0, 60) || undefined,
      tags: strArr(h?.tags).slice(0, 6),
      confidence: clamp(h?.confidence, 0, 1, 0.5),
      confirmations: 1,
      evidence: valid,
      source: "summary",
      first_seen: date,
      last_seen: date,
      created_at: nowIso,
      edited_by: null,
    });
  });

  return { habits, dropped };
}

