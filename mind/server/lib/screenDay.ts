// Observation journal stays separate from dialogue, persona and episodic memory.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { P, dateStr } from "./paths.ts";
const PRIVATE = /密码|口令|验证码|登录|银行|支付|密钥|隐私|无痕|身份证|银行卡|password|passwd|credential|api[_ -]?key|access[_ -]?token|secret|\bbearer\b|sk-[a-z0-9]{12,}|https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\d{11,}/i;
const KINDS = new Set(["game", "anime", "video", "coding", "article", "chat", "other"]);
export interface DayObservation { at: number; pageType: string; summary: string; key: string }
export interface ScreenDay { date: string; observations: DayObservation[]; summary: string; updatedAt: number; attempts: number; lastAttemptAt: number;
  reflection?: { summary: string; topic: string; at: number } }
export function createScreenDayStore(directory?: string) {
  const dir = () => directory ?? path.join(P.data, "screen-days");
  function load(at = Date.now()): ScreenDay {
    const date = dateStr(new Date(at)), file = path.join(dir(), `${date}.json`);
    if (fs.existsSync(file)) {
      const day = JSON.parse(fs.readFileSync(file, "utf8"));
      if (day.date !== date || !Array.isArray(day.observations)) throw Error("读屏日记格式异常，未覆盖原文件");
      return day;
    }
    return { date, observations: [], summary: "", updatedAt: 0, attempts: 0, lastAttemptAt: 0 };
  }
  function save(day: ScreenDay) {
    fs.mkdirSync(dir(), { recursive: true });
    const file = path.join(dir(), `${day.date}.json`), temp = file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(day, null, 2), "utf8"); fs.renameSync(temp, file);
  }
  function record(input: unknown, at = Date.now()) {
    const v = input as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["capturedAt", "pageType", "summary"].includes(k))) return { recorded: false, reason: "只接受精简画面摘要" };
    const captured = v.capturedAt, kind = v.pageType;
    const summary = typeof v.summary === "string" ? v.summary.trim().replace(/\s+/g, " ") : "";
    if (typeof captured !== "number" || !Number.isFinite(captured) || captured > at || at - captured > 105_000 ||
      dateStr(new Date(captured)) !== dateStr(new Date(at)) || typeof kind !== "string" || !KINDS.has(kind) ||
      summary.length < 5 || summary.length > 240 || PRIVATE.test(summary)) return { recorded: false, reason: "过期、不确定或敏感观察不记录" };
    const day = load(at), key = createHash("sha256").update(`${kind}:${summary}`).digest("hex").slice(0, 24), last = day.observations.at(-1);
    if (day.observations.length >= 288 || (last && at - last.at < 300_000) || day.observations.some(o => o.key === key && at - o.at < 1800_000)) return { recorded: false, reason: "采样限频或相同内容去重" };
    day.observations.push({ at: captured, pageType: kind, summary, key }); day.updatedAt = at;
    const groups = new Map<string, DayObservation[]>();
    for (const o of day.observations) { const list = groups.get(o.pageType) || []; list.push(o); groups.set(o.pageType, list); }
    const clock = (ts: number) => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
    day.summary = [...groups].map(([type, list]) => {
      const unique = [...new Map(list.map(o => [o.summary, o])).values()];
      const samples = unique.length <= 5 ? unique : [0, .25, .5, .75, 1].map(q => unique[Math.round(q * (unique.length - 1))]);
      return `${type}（零散采样，不代表持续时长）：${samples.map(o => `${clock(o.at)} ${o.summary}`).join("；")}`;
    }).join("\n").slice(0, 4000);
    save(day); return { recorded: true, count: day.observations.length, date: day.date };
  }
  function material(at = Date.now()): string {
    const d = new Date(at);
    if (d.getHours() < 21 || (d.getHours() === 21 && d.getMinutes() < 30)) return "";
    const day = load(at);
    return day.observations.length ? `日期：${day.date}。今天开启读屏期间零散看到的页面（不是完整行程，不是哥哥亲口说过）：\n${day.summary}` : "";
  }
  function attempt(at = Date.now()) {
    const day = load(at);
    if (day.reflection || day.attempts >= 3 || (day.lastAttemptAt && at - day.lastAttemptAt < 1800_000)) return false;
    day.attempts++; day.lastAttemptAt = at; save(day); return true;
  }
  function finish(raw: string, expectedDate: string, at = Date.now()) {
    if (dateStr(new Date(at)) !== expectedDate) return null;
    let value: any;
    try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { return null; }
    if (!value || Object.keys(value).length !== 2 || typeof value.summary !== "string" || typeof value.topic !== "string" ||
      value.summary.trim().length < 10 || value.summary.length > 600 || value.topic.trim().length < 8 || value.topic.length > 180 ||
      PRIVATE.test(`${value.summary} ${value.topic}`)) return null;
    const day = load(at);
    if (!day.observations.length || day.reflection) return null;
    day.reflection = { summary: value.summary.trim(), topic: value.topic.trim(), at }; save(day);
    return day.reflection;
  }
  return { load, record, material, attempt, finish };
}
export const screenDays = createScreenDayStore();
