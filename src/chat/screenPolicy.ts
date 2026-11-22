/** Local scheduling policy. Running/minimized windows alone never prove activity. */
export type AttentionMode = "entertainment" | "work" | "idle" | "normal";
export interface AppActivity { windowId: string; title: string; process: string; minimized: boolean; kind: string }
export interface BackgroundMedia { title: string; source: string; kind: "video"; playing: true; observedAt: number }
export interface ActivitySnapshot {
  observedAt: number; idleSeconds: number | null; unavailable: boolean; sensitiveForeground?: boolean;
  foreground: AppActivity; background: AppActivity[];
  media: Array<{title: string; source: string; playing: boolean; kind: string}>; mediaAvailable: boolean;
}
export interface AttentionPolicy { mode: AttentionMode; ocrMs: number; visionMs: number; proactiveMin: number; reason: string }
export const ATTENTION_POLICIES: Record<AttentionMode, Omit<AttentionPolicy, "reason">> = {
  entertainment: { mode: "entertainment", ocrMs: 4_000, visionMs: 12_000, proactiveMin: 2 },
  work: { mode: "work", ocrMs: 1_200_000, visionMs: 1_200_000, proactiveMin: 45 },
  idle: { mode: "idle", ocrMs: 1_800_000, visionMs: 1_800_000, proactiveMin: 90 },
  normal: { mode: "normal", ocrMs: 8_000, visionMs: 30_000, proactiveMin: 30 },
};
const PRIVATE = /密码|验证码|登录|银行|支付|密钥|token|secret|隐私|无痕|private|password|credential|auth/i;
export function backgroundMediaKey(m: Pick<BackgroundMedia, "title" | "source">): string {
  let hash = 2166136261;
  for (const c of JSON.stringify([m.source, m.title])) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return `media:${(hash >>> 0).toString(16)}`;
}
export function playingVideo(a: ActivitySnapshot | undefined, at = Date.now()): BackgroundMedia | undefined {
  if (!a || a.unavailable || a.sensitiveForeground || at < a.observedAt || at - a.observedAt > 20_000) return;
  const media = a.media?.find(m => m.playing && m.title?.trim() && !PRIVATE.test(`${m.title} ${m.source}`) &&
    (m.kind === "video" || (m.kind === "unknown" && /bilibili|哔哩|番剧|动漫|iqiyi|爱奇艺|优酷|腾讯视频|netflix/i.test(`${m.title} ${m.source}`))));
  if (media) return { title: media.title.slice(0, 160), source: media.source.slice(0, 160), kind: "video", playing: true, observedAt: a.observedAt };
}
export function attentionPolicy(a: ActivitySnapshot | undefined, scene: {
  windowId?: string; title?: string; pageType?: string; understandingAt?: number; understandingStatus?: string; activity?: string;
}, at = Date.now()): AttentionPolicy {
  const result = (mode: AttentionMode, reason: string) => ({ ...ATTENTION_POLICIES[mode], reason });
  if (!a || at < a.observedAt || at - a.observedAt > 20_000) return result("normal", "活动状态暂不可用，保持普通频率");
  if (a.unavailable) return result("idle", "桌面不可用，暂停主动打扰");
  if (a.sensitiveForeground) return result("idle", "当前涉及敏感信息，已暂停读取");
  const f = a.foreground;
  const same = !!f?.windowId && f.windowId === scene.windowId;
  const fresh = same && scene.understandingStatus === "ready" && at >= Number(scene.understandingAt) && at - Number(scene.understandingAt) <= 105_000;
  // Keep a same-window/same-title work classification until the next 20min
  // reading. This schedules sampling only; it does NOT renew old screen facts.
  const stableWork = same && !!scene.title && scene.title === f.title && scene.understandingStatus === "ready" &&
    at >= Number(scene.understandingAt) && at - Number(scene.understandingAt) <= 1_230_000;
  const video = playingVideo(a, at);
  // A real work window takes priority over a background video/game. Music alone
  // never keeps an unattended computer in entertainment mode.
  if (a.idleSeconds !== null && a.idleSeconds >= 180 && !video) return result("idle", "超过3分钟无键鼠活动，且未确认视频播放；减少读取，暂不主动");
  if (f?.kind === "work" || ((fresh || stableWork) && ["coding", "article"].includes(scene.pageType || ""))) return result("work", "当前是工作或阅读页面，约20分钟读取一次，减少主动打扰");
  if (fresh && /暂停|已停止|暂停菜单|pause[ds]?/i.test(scene.activity || "") && !video) return result("normal", "娱乐内容处于暂停状态，恢复普通频率");
  if (f?.kind === "game" || (fresh && ["game", "anime", "video"].includes(scene.pageType || ""))) return result("entertainment", "当前游戏或视频内容，优先陪看具体画面");
  if (video) return result("entertainment", "系统确认视频正在播放（包括后台），提高陪看频率");
  return result("normal", a.background?.length ? "发现后台娱乐窗口，但仅运行不代表正在使用" : "普通使用，按常规节奏");
}
