// 桌宠 → 思维系统（mind）客户端
// 桌宠只是"窗口"：人格、记忆、情绪都在 mind 那边，这里只负责转发与渲染
import { getSection, setSection } from "../core/config";
import { env } from "../core/env";

export interface MindCfg {
  enabled: boolean;
  url: string;
  token: string;
  channel: string;
  sessionId?: string;
  /** 连不上时自动把思维系统拉起来（仅桌面版 exe 有效） */
  autoStart?: boolean;
}

export const MIND_DEFAULTS: MindCfg = {
  enabled: true,
  url: "http://127.0.0.1:8430",
  token: "",
  channel: "pet",
  autoStart: true,
};

export function mindCfg(): MindCfg {
  return { ...MIND_DEFAULTS, ...(getSection("mind", MIND_DEFAULTS) as Partial<MindCfg>) };
}

export function setMindCfg(patch: Partial<MindCfg>): void {
  setSection("mind", patch as any);
}

/** 从外置目录读握手信息（mind 服务启动时会把 url+token 写进 app/mind.json） */
export async function primeMindHandshake(): Promise<void> {
  try {
    const cur = mindCfg();
    const r = await fetch(`${env.serverBase}/mind.json`, { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    if (j?.token && (j.token !== cur.token || (j.url && j.url !== cur.url))) {
      setMindCfg({ token: j.token, url: j.url || cur.url });
      console.log("[mind] 已从 app/mind.json 读取连接信息");
    }
  } catch {
    /* 没有握手文件就用设置里的配置 */
  }
}

function headers(cfg = mindCfg()): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.token) h["Authorization"] = `Bearer ${cfg.token}`;
  return h;
}

export interface MindHealth {
  ok: boolean;
  version?: string;
  llm?: { mode: string; model: string; hasKey: boolean };
  memory?: { episodes: number; emotions: number; digests: number };
  queue?: string[];
  trash?: { date: string; sizeKB: number }[];
  idle?: { idle: boolean; reason: string };
  persona?: { name: string; age: number; sections: number };
  error?: string;
}

export async function mindHealth(timeoutMs = 2500): Promise<MindHealth> {
  const cfg = mindCfg();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${cfg.url}/v1/health`, { headers: headers(cfg), signal: ctl.signal });
    const health: MindHealth = r.ok ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
    cachedOk = { at: Date.now(), ok: !!health.ok };
    return health;
  } catch (e) {
    cachedOk = { at: Date.now(), ok: false };
    return { ok: false, error: (e as Error).message };
  } finally { clearTimeout(timer); }
}

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const cfg = mindCfg();
  const r = await fetch(`${cfg.url}${path}`, { headers: headers(cfg), ...init });
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!r.ok) throw new Error(`mind HTTP ${r.status}：${String(data?.error ?? text).slice(0, 160)}`);
  return data as T;
}

export interface MindReply {
  text: string;
  session_id?: string;
  emotion?: string | null;
  memory_used?: string[];
  model?: string;
  ms?: number;
}

/** 一轮对话（SSE 流式） */
export async function mindSend(
  text: string,
  onDelta: (full: string) => void,
  opts: { activity?: string; image?: string; avatar?: unknown } = {},
): Promise<MindReply> {
  const cfg = mindCfg();
  const res = await fetch(`${cfg.url}/v1/message`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({
      text,
      channel: cfg.channel || "pet",
      session_id: cfg.sessionId,
      activity: opts.activity,
      ...(opts.avatar ? { avatar: opts.avatar } : {}),
      ...(opts.image ? { image: opts.image } : {}),
    }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${t.slice(0, 120)}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let final: MindReply = { text: "" };
  let err = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (!chunk.startsWith("data:")) continue;
      const payload = chunk.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        if (j.delta) onDelta(j.delta);
        if (j.final) final = j.final;
        if (j.error) err = j.error;
      } catch {
        /* 半行 */
      }
    }
  }
  if (err && !final.text) throw new Error(err);

  // 记住会话 id（后续轮次保持上下文）
  if (final.session_id && final.session_id !== cfg.sessionId) setMindCfg({ sessionId: final.session_id });
  return final;
}

// ---------------- 记忆面板用的接口 ----------------
export const mindSearch = (q: string, k?: number) =>
  api<any>(`/v1/memory/search?q=${encodeURIComponent(q)}${k ? `&k=${k}` : ""}`);
export const mindDiaries = (n = 30) => api<any>(`/v1/memory/diaries?n=${n}`);
export const mindDiary = (date: string) => api<any>(`/v1/memory/diary?date=${date}`);
export const mindList = (limit = 200) => api<any>(`/v1/memory/list?limit=${limit}`);
export const mindTrash = () => api<any>("/v1/memory/trash");
export const mindRestore = (date: string) =>
  api<any>("/v1/memory/restore", { method: "POST", body: JSON.stringify({ date }) });
export const mindForget = (payload: { ids?: string[]; date?: string }) =>
  api<any>("/v1/memory/forget", { method: "POST", body: JSON.stringify(payload) });
export const mindEditEpisode = (episodeId: string, patch: any) =>
  api<any>("/v1/memory/edit", { method: "POST", body: JSON.stringify({ episodeId, patch }) });
export const mindEditDiary = (date: string, diary: string) =>
  api<any>("/v1/memory/edit", { method: "POST", body: JSON.stringify({ date, diary }) });
export const mindRunJob = (job: "summarize" | "tick", date?: string, force = false) =>
  api<any>("/v1/job/run", { method: "POST", body: JSON.stringify({ job, date, force }) });
export const mindState = () => api<any>("/v1/state");
export const mindPersona = () => api<any>("/v1/persona");
/**
 * 主动聊天：问她的思维系统"现在该不该开口、说什么"。
 * 话题池/由头/去重/每天限额都在她那边决定，桌宠只负责把结果显示出来。
 * 返回 { skip, reason, kind?, text? }：skip=true 就是"这轮先不打扰"。
 */
export const mindRecordScreenDay = (observation: {capturedAt: number; pageType: string; summary: string}) =>
  api("/v1/screen-day/observation", { method: "POST", body: JSON.stringify(observation), signal: AbortSignal.timeout(5000) });
export const mindScreenDay = () => api<{date: string; summary: string; reflection?: string; count: number}>("/v1/screen-day", { signal: AbortSignal.timeout(5000) });

export const mindProactive = (state: Record<string, unknown>) =>
  api<any>("/v1/proactive/topic", { method: "POST", body: JSON.stringify(state) });
/** 最近的对话记录（桌宠启动时用来恢复聊天窗口）；hours>0 只取这段时间以内，channel 只取某个窗口的对话 */
export const mindRecentMessages = (limit = 30, hours = 0, channel = "") =>
  api<any>(
    `/v1/messages/recent?limit=${limit}` +
      (hours > 0 ? `&hours=${hours}` : "") +
      (channel ? `&channel=${encodeURIComponent(channel)}` : ""),
  );
export const mindMessages = (date: string, limit = 300) =>
  api<any>(`/v1/messages?date=${date}&limit=${limit}`);
export const mindMessageDates = () => api<any>("/v1/messages/dates");

/** 把桌宠设置里的 API Key 交给服务端（避免手动复制） */
export async function handoverKey(apiKey: string, baseUrl?: string, model?: string): Promise<any> {
  return api<any>("/v1/llm/key", { method: "POST", body: JSON.stringify({ apiKey, baseUrl, model }) });
}

// ---------------- 可用性缓存（避免每轮都等超时） ----------------
let cachedOk: { at: number; ok: boolean } = { at: 0, ok: false };
const OK_TTL = 20_000;
const FAIL_TTL = 30_000;

export async function mindUsable(): Promise<boolean> {
  const cfg = mindCfg();
  if (!cfg.enabled) return false;
  const now = Date.now();
  const ttl = cachedOk.ok ? OK_TTL : FAIL_TTL;
  if (now - cachedOk.at < ttl) return cachedOk.ok;
  const h = await mindHealth();
  cachedOk = { at: now, ok: !!h.ok };
  return cachedOk.ok;
}

export function markMindFailed(): void {
  cachedOk = { at: Date.now(), ok: false };
}
