// 日总结流水线：预处理 → LLM 抽取 → 证据校验 → 落库 → 原始记录进回收站
// 顺序不可颠倒：**先写成功 digest，才允许移动 raw**
import type { MindConfig } from "./config.ts";
import {
  appendEpisodic, appendEmotional, appendHabits, addToIndex, dequeueDate, digestExists, enqueueDate,
  loadHabits, moveToTrash, readRaw, recordFailure, saveState, writeDigest,
  type Digest, type RawMsg,
} from "./store.ts";
import { buildSummaryMessages, buildHabitMessages, type Segment } from "./prompts.ts";
import { chatJson } from "./llm.ts";
import { validateDigest, validateHabits, type RawDigestDraft, type RawHabitDraft } from "./validate.ts";
import { rebuildIndex } from "./store.ts";
import { embedEpisodes } from "./vectors.ts";
import { habitSnapshot } from "./habits.ts";

export interface PreprocessResult {
  segments: Segment[];
  total: number;
  effective: number;
  dropped: { reason: string; text: string }[];
}

/** 机械预处理：去掉噪音、按话题分段（省 token、提升抽取质量） */
export function preprocess(raw: RawMsg[], cfg: MindConfig): PreprocessResult {
  const dropped: { reason: string; text: string }[] = [];
  const kept: RawMsg[] = [];
  const seen = new Set<string>();

  for (const m of raw) {
    const t = (m.text ?? "").trim();
    if (!t) {
      dropped.push({ reason: "空消息", text: "" });
      continue;
    }
    if (t.length <= 1) {
      dropped.push({ reason: "过短", text: t });
      continue;
    }
    const key = `${m.role}:${t}`;
    if (seen.has(key)) {
      dropped.push({ reason: "重复", text: t.slice(0, 20) });
      continue;
    }
    seen.add(key);
    kept.push({ ...m, text: t });
  }

  // 按时间间隔切段
  const gapMs = cfg.segmentGapMinutes * 60_000;
  const segments: Segment[] = [];
  for (const m of kept) {
    const last = segments[segments.length - 1];
    if (last && m.ts - last.endTs <= gapMs) {
      last.msgs.push(m);
      last.endTs = m.ts;
    } else {
      segments.push({ startTs: m.ts, endTs: m.ts, msgs: [m] });
    }
  }

  return { segments, total: raw.length, effective: kept.length, dropped };
}

const GREET = /^(在吗|在不在|哈+|哈哈+|嗯+|哦+|早|早安|晚安|睡了|你好|hi|hello|ok|好的|拜拜|再见)[。！!~～\s]*$/i;

/** 一整天只有寒暄 → 不值得调 LLM */
function isNoiseOnly(segments: Segment[]): boolean {
  const msgs = segments.flatMap((s) => s.msgs);
  return msgs.every((m) => GREET.test(m.text.trim()) || m.text.trim().length <= 6);
}

export interface SummaryOutcome {
  date: string;
  ok: boolean;
  usedLlm: boolean;
  digest?: Digest;
  note: string;
  ms?: number;
}

/**
 * 哥哥的习惯抽取（情景记忆的分支）：一次额外的结构化调用，只找"他的说法 → 真意"。
 *
 * 失败**绝不影响**记忆本身 —— 档案卡/情景/情绪已经写好了，这里出错就只记一行日志。
 */
async function extractHabits(
  date: string,
  segments: Segment[],
  validIds: Set<string>,
  nowIso: string,
  cfg: MindConfig,
): Promise<{ added: number; merged: number; dropped: number; note: string }> {
  const empty = { added: 0, merged: 0, dropped: 0, note: "" };
  if (!cfg.habits.enabled || !cfg.habits.extract) return { ...empty, note: "哥哥的习惯抽取已关闭" };
  try {
    const messages = buildHabitMessages(date, segments, cfg, habitSnapshot());
    const { data } = await chatJson<RawHabitDraft>(cfg, messages);
    const existing = loadHabits().map((h) => h.key);
    const v = validateHabits(data, validIds, date, nowIso, existing);
    if (!v.habits.length) {
      return { ...empty, dropped: v.dropped.length, note: v.dropped.length ? `哥哥的习惯 0 条（筛掉 ${v.dropped.length}）` : "" };
    }
    const r = appendHabits(v.habits);
    return {
      added: r.added,
      merged: r.merged,
      dropped: v.dropped.length,
      note: `哥哥的习惯 +${r.added}${r.merged ? `／确认 ${r.merged}` : ""}${v.dropped.length ? `（筛掉 ${v.dropped.length}）` : ""}`,
    };
  } catch (e) {
    console.warn("[habits] 哥哥的习惯抽取失败（不影响记忆）：", (e as Error).message);
    return { ...empty, note: `哥哥的习惯抽取失败：${(e as Error).message.slice(0, 60)}` };
  }
}

/**
 * 总结某一天
 * @param force 即使已有 digest 也重做
 */
export async function summarizeDate(date: string, cfg: MindConfig, force = false): Promise<SummaryOutcome> {
  const t0 = Date.now();

  if (!force && digestExists(date)) {
    dequeueDate(date);
    return { date, ok: true, usedLlm: false, note: "已有档案卡，跳过" };
  }

  const raw = readRaw(date);
  if (!raw.length) {
    const empty: Digest = {
      date,
      generated_at: new Date().toISOString(),
      model: "none",
      diary: "这天我们没怎么说话。（她没有写下什么）",
      episodes: [],
      emotions: [],
      open_threads: [],
      stats: { messages: 0, userMessages: 0, segments: 0, usedLlm: false },
    };
    writeDigest(empty);
    dequeueDate(date);
    saveState({ lastSummaryAt: Date.now() });
    return { date, ok: true, usedLlm: false, digest: empty, note: "当天没有记录" };
  }

  const pre = preprocess(raw, cfg);
  const validIds = new Set(raw.map((m) => m.id));
  const nowIso = new Date().toISOString();

  // 内容太少 / 全是寒暄 → 不调 LLM，直接写一张薄档案卡
  if (pre.effective < cfg.minMessages || isNoiseOnly(pre.segments)) {
    const d: Digest = {
      date,
      generated_at: nowIso,
      model: "none",
      diary: "今天只是零散地说了几句话，没什么特别的。",
      episodes: [],
      emotions: [],
      open_threads: [],
      stats: { messages: pre.total, userMessages: raw.filter((m) => m.role === "user").length, segments: pre.segments.length, usedLlm: false },
      dropped: pre.dropped.slice(0, 20).map((x) => ({ reason: x.reason, detail: x.text })),
    };
    writeDigest(d);
    dequeueDate(date);
    saveState({ lastSummaryAt: Date.now() });
    return { date, ok: true, usedLlm: false, digest: d, note: `有效消息 ${pre.effective} 条，未调用 LLM`, ms: Date.now() - t0 };
  }

  // ★ 核心：LLM 抽取
  try {
    const messages = buildSummaryMessages(date, pre.segments, cfg);
    const { data, usage } = await chatJson<RawDigestDraft>(cfg, messages);
    // minSalience：拟人价值低于下限的记忆不入库（情绪跟着情景走，情景被筛掉则情绪也无法归属）
    const v = validateDigest(data, validIds, date, nowIso, cfg.minSalience);

    const digest: Digest = {
      date,
      generated_at: nowIso,
      model: usage.model,
      diary: v.diary,
      episodes: v.episodes,
      emotions: v.emotions,
      open_threads: v.openThreads,
      stats: {
        messages: pre.total,
        userMessages: raw.filter((m) => m.role === "user").length,
        segments: pre.segments.length,
        usedLlm: true,
      },
      dropped: v.dropped,
      edited_by: null,
    };

    // ① 先写档案卡（成功才继续）
    writeDigest(digest);
    // ② 情景/情绪入库 + 关键词索引 + 向量（本地嵌入，离线；失败不影响记忆本身）
    appendEpisodic(v.episodes);
    appendEmotional(v.emotions);
    if (v.episodes.length) addToIndex(v.episodes);
    else rebuildIndex();
    await embedEpisodes(v.episodes);
    // ②b 哥哥的习惯（情景记忆的分支）：单独抽一次，失败不影响上面的记忆
    const hb = await extractHabits(date, pre.segments, validIds, nowIso, cfg);
    // ③ 最后才移动原始记录进回收站
    moveToTrash(date);
    dequeueDate(date);
    saveState({ lastSummaryAt: Date.now() });

    return {
      date,
      ok: true,
      usedLlm: true,
      digest,
      note: `情景 ${v.episodes.length} 条、情绪 ${v.emotions.length} 条` +
        (v.dropped.length ? `，丢弃 ${v.dropped.length} 条（证据校验）` : "") +
        (hb.note ? `；${hb.note}` : ""),
      ms: Date.now() - t0,
    };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const attempts = recordFailure(date, msg);
    enqueueDate(date); // 保留在队列里，下次空闲重试
    // ★ raw 原样保留，绝不因为失败而丢数据
    return { date, ok: false, usedLlm: true, note: `失败（第 ${attempts} 次）：${msg}`, ms: Date.now() - t0 };
  }
}
