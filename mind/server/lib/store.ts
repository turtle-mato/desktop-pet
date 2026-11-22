// 数据层：原始日志 / 档案卡 / 情景 / 情绪 / 索引 / 回收站 / 队列 / 运行状态
// 全部是 JSON(L) 明文文件 —— 你可以直接用记事本看、改、备份、整体搬走
import fs from "node:fs";
import path from "node:path";
import {
  P, CONFIG_PATH, ensureDirs, rawPath, trashPath, digestPath, dateStr, addDays, daysBetween,
} from "./paths.ts";
import { tokenize, uniq } from "./text.ts";

export interface RawMsg {
  id: string;
  ts: number;
  role: "user" | "pet" | "sys";
  text: string;
  channel?: string;
  activity?: string;
  /** Local original-image reference; never base64 in the raw log. */
  imageId?: string;
  /** Minimal source of an assistant's initiated remark, never screen contents. */
  origin?: import("./conversation.ts").AssistantOrigin;
}

export interface Episode {
  id: string;
  date: string; // 归属日（总结的那一天）
  title: string;
  summary: string;
  time?: string; // 事件发生时间（当天内的 HH:MM，可空）
  /** 复盘：这段经历让她学到了什么（她自己写的一句，不是客观经过） */
  review?: string;
  people: string[];
  entities: string[];
  tags: string[];
  keywords: string[];
  /** 拟人价值 0~1：这条记忆能不能让她更像一个真实的人（不是"事情大不大"） */
  salience: number;
  evidence: string[]; // 原始消息 id（必填，防幻觉）
  links: string[];
  source?: "chat" | "seed" | "birthday";
  edited_by?: "user" | null;
  created_at: string;
}

export interface Emotion {
  id: string;
  date: string;
  episode_id: string;
  emotion: string;
  valence: number; // -1~1
  arousal: number; // 0~1
  cause: string;
  intensity: number; // 0~1
  decay: number;
  evidence: string[];
  created_at: string;
}

export interface OpenThread {
  text: string;
  since: string;
  episode_id?: string;
  status?: "open" | "closed";
}

/**
 * 哥哥的习惯（情景记忆的一个分支）：记的是"哥哥这句话到底什么意思"。
 *
 * 存放位置也归在情景记忆这一支下面：`data/episodic/habits.jsonl`。
 * 与情景记忆的分工：
 *  - 情景记忆记的是"发生了什么"（一次性的、带时间的经历）；
 *  - 哥哥的习惯记的是"哥哥这个人怎么说话"（反复成立、不带时间）。
 * 所以它没有 salience/情绪，只有"确认过几次"——确认越多越可信，也就越敢拿来判断。
 *
 * 每一条都带 evidence（真实消息 id），来源见 source：
 *  - correct：哥哥当场纠正我理解错了（实时入账）
 *  - summary：哪天聊天里他自己解释过某个说法（日总结时抽取）
 *  - import：从别处导入（初始记忆、手工整理）
 */
export interface Habit {
  id: string;
  /** 哥哥的原话/说法（检索键，也是注入时给人看的那一栏） */
  key: string;
  /** 哥哥这么说的真实意思 */
  meaning: string;
  /** 以前理解错成的样子（误解账本 —— 她情商的长期来源） */
  misunderstood?: string;
  /** 这句话背后的态度/语气（反讽、嫌弃、逗你…） */
  tone?: string;
  /** 认出这个说法以后该怎么接 */
  behavior?: string;
  tags: string[];
  confidence: number; // 0~1
  confirmations: number; // 被确认过几次（每见一次 +1）
  evidence: string[];
  source: "correct" | "summary" | "import";
  first_seen: string; // YYYY-MM-DD
  last_seen: string;
  created_at: string;
  edited_by?: "user" | null;
}

export interface Digest {
  date: string;
  generated_at: string;
  model: string;
  diary: string; // 她的第一人称日记
  episodes: Episode[];
  emotions: Emotion[];
  open_threads: OpenThread[];
  stats: { messages: number; userMessages: number; segments: number; usedLlm: boolean };
  edited_by?: "user" | null;
  dropped?: { reason: string; detail: string }[]; // 被证据校验丢弃的条目（透明可查）
}

export interface RuntimeState {
  lastActivityTs: number; // 最后一次对话活动
  lastSummaryAt: number;
  startedAt: number;
  routineAttempts?: { key: string; at: number }[];
  topicHistory: { topic: string; at: number }[]; // 主动聊天的去重记录
  /** 上次主动开口的时间（用来判断"被忽略后降频"） */
  lastProactiveAt?: number;
  keyHandoverAt?: number;
  lastPurgeDate?: string; // 回收站轮转（每天一次）
  lastBackupDate?: string; // 备份（每天一次）
}

// ---------------- 通用文本读写 ----------------
function readJson<T>(file: string, def: T): T {
  try {
    if (!fs.existsSync(file)) return def;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return def;
  }
}

/** 原子写（先写临时文件再改名），避免断电写坏 */
function writeJsonAtomic(file: string, data: unknown): void {
  ensureDirs();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function appendJsonl(file: string, rows: unknown[]): void {
  if (!rows.length) return;
  ensureDirs();
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as T[];
}

function writeJsonl(file: string, rows: unknown[]): void {
  ensureDirs();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  fs.renameSync(tmp, file);
}

// ---------------- 原始日志 ----------------
export function appendRaw(date: string, msg: RawMsg): void {
  ensureDirs();
  fs.appendFileSync(rawPath(date), JSON.stringify(msg) + "\n", "utf8");
}

export function readRaw(date: string): RawMsg[] {
  return readJsonl<RawMsg>(rawPath(date));
}

export function rawDates(): string[] {
  if (!fs.existsSync(P.raw)) return [];
  return fs
    .readdirSync(P.raw)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(".jsonl", ""))
    .sort();
}

export function newMsgId(date: string, seq: number): string {
  return `m_${date.replace(/-/g, "")}_${String(seq).padStart(4, "0")}`;
}

// ---------------- 向量（P2：本地嵌入） ----------------
export interface EpisodeVector {
  id: string; // 情景 id
  date: string;
  hash: string; // 参与编码的文本指纹：文本改了要重算
  dim: number;
  vec: number[];
}

export function loadVectors(): EpisodeVector[] {
  return readJsonl<EpisodeVector>(P.vectors);
}

export function saveVectors(rows: EpisodeVector[]): void {
  writeJsonl(P.vectors, rows);
}

/** 按 id 合并写入（不清掉别的） */
export function upsertVectors(rows: EpisodeVector[]): void {
  if (!rows.length) return;
  const map = new Map(loadVectors().map((v) => [v.id, v]));
  for (const r of rows) map.set(r.id, r);
  saveVectors([...map.values()]);
}

/** 删掉不再存在的情景向量（忘了某条记忆时同步） */
export function pruneVectors(keepIds: Set<string>): number {
  const all = loadVectors();
  const keep = all.filter((v) => keepIds.has(v.id));
  if (keep.length !== all.length) saveVectors(keep);
  return all.length - keep.length;
}

// ---------------- 档案卡（digest） ----------------
export function digestExists(date: string): boolean {
  return fs.existsSync(digestPath(date));
}

export function writeDigest(d: Digest): void {
  writeJsonAtomic(digestPath(d.date), d);
}

export function readDigest(date: string): Digest | null {
  return fs.existsSync(digestPath(date)) ? readJson<Digest | null>(digestPath(date), null) : null;
}

export function digestDates(): string[] {
  if (!fs.existsSync(P.digest)) return [];
  return fs
    .readdirSync(P.digest)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
    .map((f) => f.replace(".json", ""))
    .sort();
}

// ---------------- 情景 / 情绪记忆 ----------------
export function loadEpisodic(): Episode[] {
  return readJsonl<Episode>(P.episodic);
}
export function loadEmotional(): Emotion[] {
  return readJsonl<Emotion>(P.emotional);
}
export function appendEpisodic(rows: Episode[]): void {
  appendJsonl(P.episodic, rows);
}
export function appendEmotional(rows: Emotion[]): void {
  appendJsonl(P.emotional, rows);
}
export function saveEpisodic(rows: Episode[]): void {
  writeJsonl(P.episodic, rows);
}
export function saveEmotional(rows: Emotion[]): void {
  writeJsonl(P.emotional, rows);
}

// ---------------- 哥哥的习惯（情景记忆的分支） ----------------
export function loadHabits(): Habit[] {
  return readJsonl<Habit>(P.habits);
}

export function saveHabits(rows: Habit[]): void {
  writeJsonl(P.habits, rows);
}

/** 归一化检索键：去空白、统一标点，避免"废话，谁家…"和"废话 谁家…"被当成两条 */
export function habitKey(text: string): string {
  return String(text ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：""''（）,.!?;:()[\]"'`~…—-]+/g, "")
    .toLowerCase();
}

/**
 * 剥掉首尾的"虚词"（的/了/是/啊/吧…）。
 * 用来兜住这种真实情况：他先说"废话"，后来说"我说的废话的意思是…"，
 * 抽出来的 key 是"的废话"——归一化后多了个"的"，两个说法其实是同一个。
 */
export function trimHabitKey(text: string): string {
  let t = habitKey(text);
  for (let i = 0; i < 3; i++) {
    const next = t.replace(/^[的了是地得啊呀吧呢吗哦嗯]+/, "").replace(/[的了是地得啊呀吧呢吗哦嗯]+$/, "");
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * 两个说法算不算同一条习惯（账本去重的唯一权威）。
 * 完全相等 / 剥掉虚词后相等 / 一个是另一个的一部分（"废话" ⊂ "我说的废话"）都算。
 * 单字不参与包含匹配（太容易误合）。
 */
export function isSameHabit(a: string, b: string): boolean {
  const x = habitKey(a);
  const y = habitKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (trimHabitKey(x) && trimHabitKey(x) === trimHabitKey(y)) return true;
  return x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x));
}

/** 匹配用：一组说法的"核心词"（原始键和剥掉虚词的键一起比，取最短的，命中面最广） */
export function coreHabitKey(keys: string[]): string {
  const list = keys
    .flatMap((k) => [habitKey(k), trimHabitKey(k)])
    .filter((k) => k.length >= 1);
  if (!list.length) return "";
  return list.sort((a, b) => a.length - b.length)[0];
}

/**
 * 入账一条「哥哥的习惯」（带去重）。
 *
 * 去重规则（两条，防止账本被同一个说法攒出好几条）：
 *   ① 完全同一个 key → 不新增，改成"又确认了一次"（confirmations+1、confidence 上浮）；
 *   ② 一个是另一个的一部分（"废话" vs "的废话"）→ 也算同一条，并且**留下更长的那个**
 *      （更长的说法更有信息量，也是他更完整的原话）。
 * 同一天内重复抽取直接跳过，避免日总结里同一段被抽两次。
 */
export function appendHabits(rows: Habit[]): { added: number; merged: number } {
  if (!rows.length) return { added: 0, merged: 0 };
  const all = loadHabits();
  let added = 0;
  let merged = 0;
  for (const n of rows) {
    const nk = habitKey(n.key);
    if (!nk) continue;
    // "算不算同一个说法"的规则只有一处定义（habits.ts 的 isSameHabit），这里不重复实现
    let old = all.find((h) => habitKey(h.key) === nk);
    if (!old) old = all.find((h) => isSameHabit(h.key, n.key));
    if (old) {
      if (old.last_seen === n.last_seen) continue; // 同一天重复抽取，忽略
      old.confirmations += 1;
      old.confidence = Math.min(0.95, Math.round((old.confidence + 0.08) * 100) / 100);
      old.last_seen = n.last_seen;
      if ((n.meaning ?? "").length > (old.meaning ?? "").length) old.meaning = n.meaning;
      if (habitKey(n.key).length > habitKey(old.key).length) old.key = n.key; // 留更完整的原话
      if (n.misunderstood && !(old.misunderstood ?? "").includes(n.misunderstood)) {
        old.misunderstood = old.misunderstood ? `${old.misunderstood}｜${n.misunderstood}` : n.misunderstood;
      }
      if (n.behavior && !old.behavior) old.behavior = n.behavior;
      if (n.tone && !old.tone) old.tone = n.tone;
      old.tags = uniq([...(old.tags ?? []), ...(n.tags ?? [])]).slice(0, 8);
      old.evidence = uniq([...(old.evidence ?? []), ...(n.evidence ?? [])]).slice(-8);
      merged += 1;
      continue;
    }
    all.push(n);
    added += 1;
  }
  if (added || merged) {
    saveHabits(all);
    rebuildHabitIndex(all);
  }
  return { added, merged };
}

export function updateHabit(id: string, patch: Partial<Habit>): Habit | null {
  const rows = loadHabits();
  const i = rows.findIndex((h) => h.id === id);
  if (i < 0) return null;
  rows[i] = { ...rows[i], ...patch, edited_by: "user" } as Habit;
  saveHabits(rows);
  rebuildHabitIndex(rows);
  return rows[i];
}

export function forgetHabit(id: string): boolean {
  const rows = loadHabits();
  const keep = rows.filter((h) => h.id !== id);
  if (keep.length === rows.length) return false;
  saveHabits(keep);
  rebuildHabitIndex(keep);
  return true;
}

/** 删除某天的记忆（面板"忘掉这一天"） */
export function forgetDate(date: string): { episodes: number; emotions: number } {
  const eps = loadEpisodic();
  const ems = loadEmotional();
  const keepEps = eps.filter((e) => e.date !== date);
  const ids = new Set(eps.filter((e) => e.date === date).map((e) => e.id));
  const keepEms = ems.filter((m) => m.date !== date && !ids.has(m.episode_id));
  const removed = { episodes: eps.length - keepEps.length, emotions: ems.length - keepEms.length };
  saveEpisodic(keepEps);
  saveEmotional(keepEms);
  rebuildIndex(keepEps);
  pruneVectors(new Set(keepEps.map((e) => e.id)));
  const d = readDigest(date);
  if (d) writeDigest({ ...d, episodes: [], emotions: [], diary: d.diary, edited_by: "user" });
  return removed;
}

/** 按 id 删除单条情景（连带其情绪，以及日记里的同一段副本） */
export function forgetEpisode(episodeId: string): boolean {
  const eps = loadEpisodic();
  const target = eps.find((e) => e.id === episodeId);
  if (!target) return false;
  const keep = eps.filter((e) => e.id !== episodeId);
  saveEpisodic(keep);
  saveEmotional(loadEmotional().filter((m) => m.episode_id !== episodeId));
  rebuildIndex(keep);
  pruneVectors(new Set(keep.map((e) => e.id))); // 向量也跟着删，别留孤儿
  // 日记（面板「日记」页读的就是它）里还留着同一段的副本：情景、情绪、未解线索都要一起清，
  // 否则会出现"在记忆库里删了、日记里还在"（真实踩过）。
  const d = readDigest(target.date);
  if (d) {
    const keepEp = (d.episodes ?? []).filter((e) => e.id !== episodeId);
    const keepEm = (d.emotions ?? []).filter((m: any) => m.episode_id !== episodeId && m.id !== episodeId);
    const keepTh = (d.open_threads ?? []).filter((t: any) => t.episode_id !== episodeId);
    const changed =
      keepEp.length !== (d.episodes?.length ?? 0) ||
      keepEm.length !== (d.emotions?.length ?? 0) ||
      keepTh.length !== (d.open_threads?.length ?? 0);
    if (changed) {
      writeDigest({ ...d, episodes: keepEp, emotions: keepEm, open_threads: keepTh, edited_by: "user" });
    }
  }
  return true;
}

export function updateEpisode(episodeId: string, patch: Partial<Episode>): Episode | null {
  const eps = loadEpisodic();
  const i = eps.findIndex((e) => e.id === episodeId);
  if (i < 0) return null;
  eps[i] = { ...eps[i], ...patch, edited_by: "user" } as Episode;
  saveEpisodic(eps);
  rebuildIndex(eps);
  return eps[i];
}

// ---------------- 倒排索引 ----------------
export interface IndexFile {
  updated_at: string;
  tokens: Record<string, string[]>; // token -> episode ids
}

export function loadIndex(): IndexFile {
  return readJson<IndexFile>(P.index, { updated_at: "", tokens: {} });
}

export function rebuildIndex(episodes = loadEpisodic()): IndexFile {
  const tokens: Record<string, string[]> = {};
  for (const e of episodes) {
    const text = [e.title, e.summary, ...(e.keywords ?? []), ...(e.entities ?? []), ...(e.tags ?? []), ...(e.people ?? [])].join(" ");
    for (const t of uniq(tokenize(text))) {
      (tokens[t] ??= []).push(e.id);
    }
  }
  const idx = { updated_at: new Date().toISOString(), tokens };
  writeJsonAtomic(P.index, idx);
  return idx;
}

export function addToIndex(episodes: Episode[]): void {
  const idx = loadIndex();
  for (const e of episodes) {
    const text = [e.title, e.summary, ...(e.keywords ?? []), ...(e.entities ?? []), ...(e.tags ?? []), ...(e.people ?? [])].join(" ");
    for (const t of uniq(tokenize(text))) {
      const arr = (idx.tokens[t] ??= []);
      if (!arr.includes(e.id)) arr.push(e.id);
    }
  }
  idx.updated_at = new Date().toISOString();
  writeJsonAtomic(P.index, idx);
}

// ---------------- 哥哥的习惯：倒排索引 ----------------
export interface HabitIndexFile {
  updated_at: string;
  tokens: Record<string, string[]>; // token -> habit ids
}

export function loadHabitIndex(): HabitIndexFile {
  return readJson<HabitIndexFile>(P.habitsIndex, { updated_at: "", tokens: {} });
}

export function rebuildHabitIndex(rows = loadHabits()): HabitIndexFile {
  const tokens: Record<string, string[]> = {};
  for (const h of rows) {
    // 原话整串也进索引：习惯经常是"一整句口头禅"，二元组切碎反而召回不准
    const text = [h.key, h.key, h.meaning, h.misunderstood ?? "", h.tone ?? "", ...(h.tags ?? [])].join(" ");
    for (const t of uniq([...tokenize(text), habitKey(h.key)])) {
      if (!t) continue;
      (tokens[t] ??= []).push(h.id);
    }
  }
  const idx = { updated_at: new Date().toISOString(), tokens };
  writeJsonAtomic(P.habitsIndex, idx);
  return idx;
}

// ---------------- 回收站 ----------------
export function moveToTrash(date: string): boolean {
  const src = rawPath(date);
  if (!fs.existsSync(src)) return false;
  ensureDirs();
  fs.renameSync(src, trashPath(date));
  return true;
}

export function restoreFromTrash(date: string): boolean {
  const src = trashPath(date);
  if (!fs.existsSync(src)) return false;
  ensureDirs();
  fs.renameSync(src, rawPath(date));
  return true;
}

export function listTrash(): { date: string; sizeKB: number; deletedAt: string }[] {
  if (!fs.existsSync(P.trash)) return [];
  return fs
    .readdirSync(P.trash)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const p = path.join(P.trash, f);
      const st = fs.statSync(p);
      return { date: f.replace(".jsonl", ""), sizeKB: Math.round(st.size / 1024), deletedAt: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 清掉超过 days 天的回收站文件，返回删除的日期 */
export function purgeTrash(days: number): string[] {
  const today = dateStr();
  const removed: string[] = [];
  for (const t of listTrash()) {
    if (daysBetween(t.date, today) >= days) {
      fs.rmSync(trashPath(t.date), { force: true });
      removed.push(t.date);
    }
  }
  return removed;
}

// ---------------- 待总结队列 / 失败重试 ----------------
export interface QueueFile {
  dates: string[]; // 待总结（老的在前）
  attempts: Record<string, number>;
  lastError?: Record<string, string>;
}

export function loadQueue(): QueueFile {
  return readJson<QueueFile>(P.queue, { dates: [], attempts: {}, lastError: {} });
}
export function saveQueue(q: QueueFile): void {
  writeJsonAtomic(P.queue, q);
}
export function enqueueDate(date: string): void {
  const q = loadQueue();
  if (!q.dates.includes(date)) q.dates.push(date);
  q.dates.sort();
  saveQueue(q);
}
export function dequeueDate(date: string): void {
  const q = loadQueue();
  q.dates = q.dates.filter((d) => d !== date);
  delete q.attempts[date];
  delete (q.lastError ?? {})[date];
  saveQueue(q);
}
export function recordFailure(date: string, err: string): number {
  const q = loadQueue();
  q.attempts[date] = (q.attempts[date] ?? 0) + 1;
  q.lastError ??= {};
  q.lastError[date] = err.slice(0, 300);
  saveQueue(q);
  return q.attempts[date];
}

/** 扫描 raw 目录，把"今天之前且还没总结"的日期补进队列（补跑机制） */
export function refillQueueFromRaw(): string[] {
  const today = dateStr();
  const q = loadQueue();
  const missing = rawDates().filter((d) => d < today && !digestExists(d) && !q.dates.includes(d));
  const fromTrash = listTrash().map((t) => t.date).filter((d) => d < today && !digestExists(d) && !q.dates.includes(d));
  const add = uniq([...missing, ...fromTrash]).sort();
  if (add.length) {
    q.dates = uniq([...q.dates, ...add]).sort();
    saveQueue(q);
  }
  return add;
}

// ---------------- 运行状态 ----------------
export function loadState(): RuntimeState {
  return readJson<RuntimeState>(P.state, {
    lastActivityTs: 0,
    lastSummaryAt: 0,
    startedAt: Date.now(),
    topicHistory: [],
  });
}
export function saveState(patch: Partial<RuntimeState>): RuntimeState {
  const next = { ...loadState(), ...patch };
  writeJsonAtomic(P.state, next);
  return next;
}

// ---------------- 备份（把当天的记忆文件复制一份） ----------------
export function backupNow(): string {
  ensureDirs();
  const dir = path.join(P.backups, dateStr());
  fs.mkdirSync(dir, { recursive: true });
  for (const f of [P.episodic, P.emotional, P.habits, P.index, P.habitsIndex, P.state, CONFIG_PATH]) {
    if (f && fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, path.basename(f)));
  }
  return dir;
}

// 便捷：某天是否已总结
export function isSummarized(date: string): boolean {
  return digestExists(date);
}

// 近 n 天的 digest 摘要（面板/归纳用）
export function recentDigests(n: number): Digest[] {
  return digestDates()
    .slice(-n)
    .map((d) => readDigest(d))
    .filter(Boolean) as Digest[];
}

export { addDays, dateStr };
