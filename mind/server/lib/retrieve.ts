// 记忆检索：关键词倒排 + 多因子打分 + 本地嵌入语义召回 + RRF 融合 + L2 联想 + 上下文打包
//
// 为什么用 RRF（倒数排名融合）而不是直接把分数相加：
// 关键词分和余弦相似度不是一个量纲，直接加权的参数很难调；RRF 只看名次，
// 字面精确命中的不会被语义糊掉，语义召回也不会被字面压死（技术文档 §4）。
import type { MindConfig } from "./config.ts";
import {
  loadIndex, loadEpisodic, loadEmotional, loadVectors, readDigest, digestDates,
  type Episode, type Emotion, type OpenThread,
} from "./store.ts";
import { tokenize, uniq, clip } from "./text.ts";
import { daysBetween, dateStr } from "./paths.ts";
import { embedAvailable, embed, cosine } from "./embed.ts";

export interface RetrievedItem {
  episode: Episode;
  emotion?: Emotion;
  score: number;
  reasons: string[];
}

/** L2 联想：由"这次想起的事"牵出来的另一件事（向量邻居 / 同情绪） */
export interface Association {
  episode: Episode;
  emotion?: Emotion;
  kind: "vector" | "emotion";
  similarity?: number;
  why: string;
}

export interface RetrievalResult {
  items: RetrievedItem[];
  text: string; // 打包好的注入文本
  ids: string[];
  associations: Association[]; // L2 联想
  assocText: string; // 联想的注入文本（【联想】段）
  mode: "keyword" | "hybrid"; // 这次实际用了哪条路（面板/CLI 可看）
}

/** 打分：文档 §4.2 的公式（可解释：每个加分项都记下来） */
export function scoreEpisode(
  ep: Episode,
  qTokens: string[],
  emo: Emotion | undefined,
  cfg: MindConfig,
): { score: number; reasons: string[]; topicHit: boolean } {
  const reasons: string[] = [];
  let score = 0;

  const fieldTokens = {
    title: new Set(tokenize(ep.title)),
    summary: new Set(tokenize(ep.summary)),
    keywords: new Set((ep.keywords ?? []).flatMap((k) => tokenize(k))),
    entities: new Set((ep.entities ?? []).flatMap((k) => tokenize(k))),
    tags: new Set((ep.tags ?? []).flatMap((k) => tokenize(k))),
  };

  const hits = { title: 0, summary: 0, keywords: 0, entities: 0, tags: 0 };
  for (const t of qTokens) {
    if (fieldTokens.title.has(t)) hits.title++;
    if (fieldTokens.summary.has(t)) hits.summary++;
    if (fieldTokens.keywords.has(t)) hits.keywords++;
    if (fieldTokens.entities.has(t)) hits.entities++;
    if (fieldTokens.tags.has(t)) hits.tags++;
  }
  // 字面命中越大越好，但按查询词数归一，避免长文本占便宜
  const nq = Math.max(1, qTokens.length);
  const kwScore = (3 * hits.title + 3 * hits.summary + 3 * hits.keywords + 2 * hits.entities + 1.5 * hits.tags) / Math.sqrt(nq);
  if (kwScore > 0) {
    score += kwScore;
    reasons.push(`关键词命中 标题${hits.title}/摘要${hits.summary}/关键词${hits.keywords}/实体${hits.entities}/标签${hits.tags}`);
  }
  const topicHit =
    hits.title + hits.summary + hits.keywords + hits.entities + hits.tags > 0;

  score += 1.2 * ep.salience;
  const age = Math.max(0, daysBetween(ep.date, dateStr()));
  score += 1.0 * Math.pow(0.5, age / cfg.retrieve.halfLifeDays);
  if (age <= 7) score += 0.5;

  if (emo) {
    score += 0.8 * emo.intensity;
    reasons.push(`情绪：${emo.emotion}(${emo.intensity.toFixed(1)})`);
  }
  return { score, reasons, topicHit };
}

function sharedWhy(a: Episode, b: Episode): string {
  const kw = (a.keywords ?? []).filter((k) => (b.keywords ?? []).includes(k)).slice(0, 3);
  const tg = (a.tags ?? []).filter((k) => (b.tags ?? []).includes(k)).slice(0, 2);
  const bits = [...kw, ...tg];
  if (bits.length) return `都跟「${bits.join("、")}」有关`;
  const ppl = (a.people ?? []).filter((p) => (b.people ?? []).includes(p)).slice(0, 2);
  if (ppl.length) return "都是你和他之间的事";
  return "感觉是同一类事";
}

/** L2：联想扩展（向量邻居 + 同情绪），零 LLM 成本 */
function collectAssociations(
  selected: RetrievedItem[],
  episodes: Episode[],
  emoByEp: Map<string, Emotion>,
  cfg: MindConfig,
): Association[] {
  const out: Association[] = [];
  const taken = new Set(selected.map((i) => i.episode.id));
  const byId = new Map(episodes.map((e) => [e.id, e]));
  const min = cfg.retrieve.assocMin;
  const max = cfg.retrieve.assocMax;
  const vectors = loadVectors();

  // ① 向量邻居：从"这次想起的事"出发，找相似但不相同的经历
  for (const it of selected) {
    const base = vectors.find((v) => v.id === it.episode.id);
    if (!base) continue;
    let best: { ep: Episode; s: number } | null = null;
    for (const v of vectors) {
      if (taken.has(v.id) || v.id === base.id) continue;
      const ep = byId.get(v.id);
      if (!ep) continue;
      const s = cosine(base.vec, v.vec);
      if (s < min || s > max) continue;
      if (!best || s > best.s) best = { ep, s };
    }
    if (best) {
      taken.add(best.ep.id);
      out.push({
        episode: best.ep,
        emotion: emoByEp.get(best.ep.id),
        kind: "vector",
        similarity: best.s,
        why: sharedWhy(it.episode, best.ep),
      });
    }
    if (out.length >= 2) break;
  }

  // ② 同情绪：当时情绪接近的另一件事（情绪得够强才值得联想，否则很假）
  if (out.length < 2) {
    const strong = selected.find((i) => (i.emotion?.intensity ?? 0) >= 0.6);
    if (strong?.emotion) {
      const want = strong.emotion.emotion;
      const cand = episodes
        .filter((e) => !taken.has(e.id))
        .map((e) => ({ ep: e, emo: emoByEp.get(e.id) }))
        .filter((x) => x.emo && x.emo.emotion === want)
        .sort((a, b) => (b.emo!.intensity ?? 0) - (a.emo!.intensity ?? 0))[0];
      if (cand?.emo) {
        taken.add(cand.ep.id);
        out.push({
          episode: cand.ep,
          emotion: cand.emo,
          kind: "emotion",
          why: `那次也是「${want}」`,
        });
      }
    }
  }
  return out.slice(0, 2);
}

/** 主检索：query → 关键词 + 向量 → RRF → topK → 联想 */
export async function retrieve(query: string, cfg: MindConfig): Promise<RetrievalResult> {
  const qTokens = uniq(tokenize(query));
  const episodes = loadEpisodic();
  const byId = new Map(episodes.map((e) => [e.id, e]));
  const emotions = loadEmotional();
  const emoByEp = new Map(emotions.map((m) => [m.episode_id, m]));

  if (!qTokens.length) {
    return { items: [], text: "", ids: [], associations: [], assocText: "", mode: "keyword" };
  }

  // ① 关键词：候选 + 多因子打分
  const idx = loadIndex();
  const candidateIds = new Set<string>();
  for (const t of qTokens) for (const id of idx.tokens[t] ?? []) candidateIds.add(id);
  // 索引没命中时退化为全量扫描（条目少时开销可忽略，且避免"索引没建好就召回不到"）
  const pool = candidateIds.size
    ? ([...candidateIds].map((id) => byId.get(id)).filter(Boolean) as Episode[])
    : episodes;
  const kwScored = pool
    .map((ep) => ({ ep, ...scoreEpisode(ep, qTokens, emoByEp.get(ep.id), cfg) }))
    // 只有"真的和这句话有关"的才入选：要么字面命中，要么语义够近。
    // 不能只看总分 —— salience+时间衰减+情绪的基础分本身就有 2 分左右，
    // 那样任何一句话都会把最近的事"想起来"（踩过：「今天中午吃什么」也把昨天的记忆拽出来）。
    .filter((x) => x.topicHit)
    .sort((a, b) => b.score - a.score);
  const kwRank = new Map(kwScored.map((x, i) => [x.ep.id, i]));

  // ② 向量：换个说法也能想起来
  const vecRank = new Map<string, number>();
  const sims = new Map<string, number>();
  const wantVec = cfg.retrieve.mode !== "keyword" && embedAvailable();
  if (wantVec) {
    try {
      const vectors = loadVectors().filter((v) => byId.has(v.id));
      if (vectors.length) {
        const qv = (await embed([query]))[0];
        vectors
          .map((v) => ({ id: v.id, s: cosine(qv, v.vec) }))
          .filter((x) => x.s >= cfg.retrieve.vectorMin) // 门槛：不够像的不要，宁可不提
          .sort((a, b) => b.s - a.s)
          .slice(0, cfg.retrieve.vectorTopK)
          .forEach((x, i) => {
            vecRank.set(x.id, i);
            sims.set(x.id, x.s);
          });
      }
    } catch (e) {
      console.warn("[retrieve] 向量召回失败，本次退回纯关键词：", (e as Error).message);
    }
  }

  // ③ RRF 融合（只看名次，两种信号都能起作用）
  const K = cfg.retrieve.rrfK;
  const allIds = new Set([...kwRank.keys(), ...vecRank.keys()]);
  const fused = [...allIds]
    .map((id) => {
      const kr = kwRank.has(id) ? 1 / (K + kwRank.get(id)!) : 0;
      const vr = vecRank.has(id) ? 1 / (K + vecRank.get(id)!) : 0;
      return { id, rrf: kr + vr, kw: kr, vec: vr };
    })
    .sort((a, b) => b.rrf - a.rrf);

  const items: RetrievedItem[] = fused.slice(0, cfg.retrieve.topK).map((f) => {
    const ep = byId.get(f.id)!;
    const emo = emoByEp.get(ep.id);
    const reasons: string[] = [];
    if (f.kw) reasons.push(`关键词第 ${kwRank.get(f.id)! + 1} 名`);
    if (f.vec) reasons.push(`语义相近 ${(sims.get(f.id) ?? 0).toFixed(2)}（第 ${vecRank.get(f.id)! + 1} 名）`);
    if (emo) reasons.push(`当时情绪：${emo.emotion}(${emo.intensity.toFixed(1)})`);
    return {
      episode: ep,
      emotion: emo,
      score: Math.round(f.rrf * 1000) / 1000,
      reasons: reasons.length ? reasons : ["综合分入选"],
    };
  });

  // ④ L2 联想
  const associations = cfg.retrieve.assoc ? collectAssociations(items, episodes, emoByEp, cfg) : [];

  return {
    items,
    text: pack(items, cfg),
    ids: items.map((i) => i.episode.id),
    associations,
    assocText: packAssoc(associations, cfg),
    mode: vecRank.size ? "hybrid" : "keyword",
  };
}

/** 打包成注入文本（含 token 预算控制：超了就丢低分项） */
export function pack(items: RetrievedItem[], cfg: MindConfig): string {
  if (!items.length) return "";
  const lines: string[] = [];
  let used = 0;
  for (const it of items) {
    const e = it.episode;
    const when = e.time ? `${e.date.slice(5)} ${e.time}` : e.date.slice(5);
    let line = `- (${when}) ${e.title}：${clip(e.summary, 120)}`;
    if (it.emotion) {
      line += `【当时情绪：${it.emotion.emotion}`;
      if (it.emotion.cause) line += `，因为${clip(it.emotion.cause, 30)}`;
      line += `】`;
    }
    if (used + line.length > cfg.retrieve.maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

/** 联想段（文档 §4.3 的【联想】）：由关系图拼出来，不需要 LLM */
export function packAssoc(list: Association[], cfg: MindConfig): string {
  if (!list.length) return "";
  const lines: string[] = [];
  let used = 0;
  for (const a of list) {
    const when = a.episode.time ? `${a.episode.date.slice(5)} ${a.episode.time}` : a.episode.date.slice(5);
    const emo = a.emotion ? `（那次${a.emotion.emotion}）` : "";
    const line = `- 这条让你想起 (${when}) ${a.episode.title}${emo}——${a.why}`;
    if (used + line.length > Math.min(cfg.retrieve.maxChars, 200)) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

/** 未完结事务（主动聊天与询问的话题来源） */
export function openThreads(limit = 3): OpenThread[] {
  const out: OpenThread[] = [];
  const dates = digestDates().slice(-14);
  for (const d of dates.reverse()) {
    const dg = readDigest(d);
    for (const t of dg?.open_threads ?? []) {
      if (t.status !== "closed" && !out.some((o) => o.text === t.text)) out.push(t);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function openThreadsText(limit = 3, maxChars = 120): string {
  const list = openThreads(limit);
  if (!list.length) return "";
  let s = "";
  for (const t of list) {
    const line = `- ${clip(t.text, maxChars)}（${t.since} 起）`;
    if (s.length + line.length > maxChars * 2) break;
    s += (s ? "\n" : "") + line;
  }
  return s;
}

/** 给面板/调试：为什么想起这条 */
export async function explain(
  query: string,
  cfg: MindConfig,
): Promise<{ id: string; title: string; score: number; reasons: string[] }[]> {
  const r = await retrieve(query, cfg);
  return r.items.map((i) => ({
    id: i.episode.id,
    title: i.episode.title,
    score: i.score,
    reasons: i.reasons,
  }));
}
