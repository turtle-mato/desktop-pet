// mind 的路径常量与目录准备（数据全部落在 mind/data/，可整体搬走）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIND_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const DATA_DIR = path.join(MIND_ROOT, "data");
export const CONFIG_PATH = path.join(MIND_ROOT, "config.json");

export const P = {
  data: DATA_DIR,
  raw: path.join(DATA_DIR, "raw"), // 当天原始日志（临时层）
  digest: path.join(DATA_DIR, "digest"), // 每天一张"档案卡"
  trash: path.join(DATA_DIR, "trash"), // 回收站（默认留 2 天）
  pending: path.join(DATA_DIR, "pending"), // 失败重试
  backups: path.join(DATA_DIR, "backups"),

  // ---- 情景记忆（一支）----
  // 情景/情绪/索引/向量/哥哥的习惯 全部收在 data/episodic/ 这一个目录下，
  // 「哥哥的习惯」是情景记忆的分支：每段经历总结时顺带记下"哥哥这个人怎么说话"。
  episodicDir: path.join(DATA_DIR, "episodic"),
  episodic: path.join(DATA_DIR, "episodic", "episodic.jsonl"), // 情景记忆
  emotional: path.join(DATA_DIR, "episodic", "emotional.jsonl"), // 情绪记忆
  index: path.join(DATA_DIR, "episodic", "index.json"), // 关键词倒排索引
  vectors: path.join(DATA_DIR, "episodic", "vectors.jsonl"), // 情景记忆的向量（本地嵌入，P2）
  habits: path.join(DATA_DIR, "episodic", "habits.jsonl"), // 哥哥的习惯（说法 → 真意）
  habitsIndex: path.join(DATA_DIR, "episodic", "habits_index.json"), // 哥哥的习惯：倒排索引

  state: path.join(DATA_DIR, "state.json"), // 运行时状态
  queue: path.join(DATA_DIR, "pending", "queue.json"), // 待总结日期队列
  personaDoc: path.join(MIND_ROOT, "docs", "设定", "林阅心.md"),
  dialogueSkill: path.join(MIND_ROOT, "docs", "skills", "dialogue", "SKILL.md"),
};

/** 老版本的数据落点（平铺在 data/ 下）；启动时会被搬进 episodic/，搬完就没人再读这里 */
export const LEGACY = {
  episodic: path.join(DATA_DIR, "episodic.jsonl"),
  emotional: path.join(DATA_DIR, "emotional.jsonl"),
  index: path.join(DATA_DIR, "index.json"),
  vectors: path.join(DATA_DIR, "vectors.jsonl"),
  habits: path.join(DATA_DIR, "habits.jsonl"),
  habitsIndex: path.join(DATA_DIR, "habits_index.json"),
};

/**
 * 一次性搬家：把老的平铺文件挪进 data/episodic/。
 * 只在"新位置还没有、老位置有"时搬，绝不覆盖已有数据。
 */
export function migrateLegacyFiles(): string[] {
  const moved: string[] = [];
  const pairs: [string, string][] = [
    [LEGACY.episodic, P.episodic],
    [LEGACY.emotional, P.emotional],
    [LEGACY.index, P.index],
    [LEGACY.vectors, P.vectors],
    [LEGACY.habits, P.habits],
    [LEGACY.habitsIndex, P.habitsIndex],
  ];
  fs.mkdirSync(P.episodicDir, { recursive: true });
  for (const [from, to] of pairs) {
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.renameSync(from, to);
        moved.push(path.basename(from));
      }
    } catch {
      /* 搬不动就算了，不影响启动 */
    }
  }
  return moved;
}

export function ensureDirs(): void {
  for (const d of [P.data, P.raw, P.digest, P.trash, P.pending, P.backups, P.episodicDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // 老版本把 episodic/emotional/index/vectors/habits 平铺在 data/ 下，
  // 这里顺手搬进 data/episodic/（只搬一次，不覆盖已有文件）。
  migrateLegacyFiles();
}

/** 今天的日期字符串（本地时区）YYYY-MM-DD */
export function dateStr(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 日期加减（按本地日历天） */
export function addDays(date: string, delta: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return dateStr(dt);
}

export function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((new Date(y2, m2 - 1, d2).getTime() - new Date(y1, m1 - 1, d1).getTime()) / 86400000);
}

export function rawPath(date: string): string {
  return path.join(P.raw, `${date}.jsonl`);
}
export function trashPath(date: string): string {
  return path.join(P.trash, `${date}.jsonl`);
}
export function digestPath(date: string): string {
  return path.join(P.digest, `${date}.json`);
}
