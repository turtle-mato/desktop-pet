import { createHash } from "node:crypto";

export interface ScreenMoment {
  kind: "game" | "anime" | "video";
  fact: string;
  subtitle?: string;
  key: string;
  capturedAt: number;
}

// 陪看只接受经视觉理解的短期事件；字幕/屏幕和事件键也不能夹带敏感字段。
const SENSITIVE_MOMENT = /密码|口令|验证码|登录|银行|支付|密钥|隐私|无痕|身份证|银行卡|password|passwd|credential|api[_ -]?key|access[_ -]?token|secret|\btoken\b|\bauth\b|\bprivate\b|\botp\b|\bbearer\b|sk-[a-z0-9]{12,}/i;
const MOMENT_FIELDS = new Set(["kind", "fact", "subtitle", "key", "capturedAt"]);

/** Playback metadata is evidence of playback, never evidence of unseen plot. */
export function backgroundMediaEvidence(input: {screen?: string; screenCapturedAt?: number; screenKey?: string; backgroundMedia?: unknown}, at = Date.now()) {
  if (!screenEvidence(input, at)) return null;
  const m = input.backgroundMedia as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).some(k => !["title", "source", "kind", "playing", "observedAt"].includes(k))) return null;
  if (m.kind !== "video" || m.playing !== true || typeof m.title !== "string" || typeof m.source !== "string" ||
    !m.title.trim() || !m.source.trim() || m.title.length > 160 || m.source.length > 160 ||
    typeof m.observedAt !== "number" || !Number.isFinite(m.observedAt) || at < m.observedAt || at - m.observedAt > 20_000 ||
    SENSITIVE_MOMENT.test(`${m.title} ${m.source}`)) return null;
  const key = createHash("sha256").update(JSON.stringify([m.title.trim(), m.source.trim()])).digest("hex").slice(0, 24);
  return { key: `coview:media:${key}`, material: JSON.stringify({source: m.source, title: m.title, evidence: "系统媒体会话确认视频正在播放。仅知标题/来源，没有读取隐藏画面，不知道当前剧情或台词，也不能认定用户在观看。"}) };
}

function genericMoment(fact: string): boolean {
  const text = fact.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  return !text || /^(?:(?:用户|玩家|哥哥|他|她|屏幕|画面|页面|当前|现在|正在|在|显示|是|一个|一段|一部|打开|观看|看|玩|播放|中|里|的|有|内容|界面|窗口|前台|游戏|动画片|动画|动漫|番剧|视频|电影|电视剧|直播|game|anime|video))+$/.test(text) ||
    // “正在玩原神/正在看《作品名》”仍只有活动或标题，不是当下事件。
    /^(?:(?:用户|玩家|哥哥|当前|现在|正在|在)\s*)+(?:玩|看|观看|播放|打开)[^，。！？；：,\n!?;:]{1,80}[。！!\s]*$/.test(fact) ||
    /^[《「『][^》」』]+[》」』][。\s]*$/.test(fact) ||
    /^(?:(?:now|currently|theuseris|useris|is|a|an|the|playing|watching|showing|game|anime|animation|video|movie|screen|page|open))+$/.test(text);
}

/** 不信任路由 JSON 的形状；无效事件必须拒绝，不能退回普通 screen 话题。 */
export function screenMomentEvidence(
  input: { screen?: string; screenCapturedAt?: number; screenKey?: string; screenMoment?: unknown },
  at = Date.now(),
) {
  if (!screenEvidence(input, at)) return null;
  const raw = input.screenMoment;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (Object.keys(m).some(key => !MOMENT_FIELDS.has(key))) return null;
  if (m.kind !== "game" && m.kind !== "anime" && m.kind !== "video") return null;
  if (typeof m.capturedAt !== "number" || !Number.isFinite(m.capturedAt) || m.capturedAt <= 0 ||
      at < m.capturedAt || at - m.capturedAt > 30_000) return null;
  if (typeof m.fact !== "string" || typeof m.key !== "string" ||
      (m.subtitle !== undefined && typeof m.subtitle !== "string")) return null;
  const fact = m.fact.trim(), key = m.key.trim();
  const subtitle = typeof m.subtitle === "string" ? m.subtitle.trim() : "";
  if (!key || key.length > 160 || fact.length > 500 || subtitle.length > 500 || genericMoment(fact)) return null;
  if ([input.screen, input.screenKey, fact, key, subtitle].some(text => SENSITIVE_MOMENT.test(text || ""))) return null;
  // 不复用窗口 screenKey：同一窗口内的新事件应能独立触发。原文与字幕不写入账本。
  const digest = createHash("sha256").update(JSON.stringify([m.kind, key.normalize("NFKC").toLowerCase()])).digest("hex").slice(0, 24);
  return { key: `coview:${digest}`, material: JSON.stringify({ kind: m.kind, fact, ...(subtitle ? { subtitle } : {}) }) };
}

/** 仅接受近期观察，原始文字不写入话题去重记录。 */
export function screenEvidence(input: { screen?: string; screenCapturedAt?: number; screenKey?: string }, at = Date.now()) {
  const capturedAt = Number(input.screenCapturedAt);
  const material = typeof input.screen === "string" ? input.screen.trim().slice(0, 1500) : "";
  if (!material || !Number.isFinite(capturedAt) || at < capturedAt || at - capturedAt > 30_000) return null;
  const digest = createHash("sha256").update(input.screenKey || material).digest("hex").slice(0, 24);
  return { material, key: `screen:${digest}` };
}
