import type { AttentionMode, BackgroundMedia } from "./screenPolicy";
export interface ScreenMoment {
  kind: "game" | "anime" | "video";
  fact: string;
  subtitle?: string;
  key: string;
  capturedAt: number;
}

/** 屏幕只作为本轮的短期观察，不作为用户指令或长期记忆。 */
export interface ScreenContextState {
  enabled: boolean;
  status: string;
  title: string;
  summary: string;
  capturedAt: number;
  scene?: string;
  sceneAt?: number;
  /** 视觉模型对当前画面的短期总结；scene 保留兼容旧状态和旧测试。 */
  aiSummary?: string;
  aiSummaryAt?: number;
  pageType?: string;
  activity?: string;
  focus?: string;
  understandingAt?: number;
  understandingStatus?: "waiting" | "ready" | "uncertain" | "error";
  understandingError?: string;
  screenMoment?: ScreenMoment;
  attentionMode?: AttentionMode;
  attentionAt?: number;
  attentionReason?: string;
  ocrIntervalMs?: number;
  visionIntervalMs?: number;
  proactiveMin?: number;
  backgroundMedia?: BackgroundMedia;
  backgroundApps?: Array<{title: string; kind: string; minimized: boolean}>;
  windowId?: string;
  decision?: string;
  rawLineCount?: number;
  keptLineCount?: number;
  filteredLineCount?: number;
}

export interface ScreenOcrLine {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RawScreen {
  title?: string;
  text?: string;
  lines?: ScreenOcrLine[];
  /** 截图坐标尺寸，与 lines 使用相同坐标系。 */
  width?: number;
  height?: number;
  windowClass?: string;
  pauseReason?: string;
  maskedRegions?: number;
}

export const SCREEN_TTL = 30_000;
export const SCENE_TTL = 105_000;
export const SENSITIVE_SCREEN = /密码|验证码|登录|银行|支付|密钥|token|secret|隐私|无痕|private|password|credential|auth/i;

export function freshScreen(s: ScreenContextState | null | undefined, at = Date.now()): boolean {
  return !!s && s.enabled && s.status === "watching" &&
    Number.isFinite(s.capturedAt) && at >= s.capturedAt && at - s.capturedAt <= SCREEN_TTL;
}

export function freshScene(s: ScreenContextState, at = Date.now()): string {
  const age = at - Number(s.sceneAt || 0);
  return age >= 0 && age <= SCENE_TTL ? String(s.scene || "").trim() : "";
}

export function freshAiSummary(s: ScreenContextState, at = Date.now()): string {
  const value = String(s.aiSummary || s.scene || "").trim();
  const stamp = Number(s.aiSummaryAt || s.sceneAt || 0);
  const age = at - stamp;
  return value && age >= 0 && age <= SCENE_TTL ? value : "";
}

export function freshScreenMoment(s: ScreenContextState | null | undefined, at = Date.now()): ScreenMoment | null {
  if (!freshScreen(s, at) || s!.understandingStatus !== "ready") return null;
  const m = s!.screenMoment;
  if (!m || !["game", "anime", "video"].includes(m.kind) || !m.key || !m.fact?.trim() ||
    !Number.isFinite(m.capturedAt) || at < m.capturedAt || at - m.capturedAt > SCREEN_TTL ||
    SENSITIVE_SCREEN.test(`${m.fact} ${m.subtitle || ""}`)) return null;
  return { kind: m.kind, fact: m.fact.trim().slice(0, 180), subtitle: String(m.subtitle || "").slice(0, 60),
    key: m.key.slice(0, 180), capturedAt: m.capturedAt };
}

export function freshBackgroundMedia(s: ScreenContextState | null | undefined, at = Date.now()): BackgroundMedia | null {
  if (!s?.enabled || s.attentionMode !== "entertainment" || s.status === "off" || s.status === "error" ||
    (s as any).pauseReason === "sensitive") return null;
  const m = s.backgroundMedia;
  if (!m || m.playing !== true || m.kind !== "video" || !m.title?.trim() || !m.source ||
    !Number.isFinite(m.observedAt) || at < m.observedAt || at - m.observedAt > 20_000 ||
    SENSITIVE_SCREEN.test(`${m.title} ${m.source}`)) return null;
  return { ...m };
}

export function screenContent(s: ScreenContextState | null | undefined, at = Date.now()): string {
  if (!freshScreen(s, at)) return "";
  const summary = String(s!.summary || "").trim();
  const scene = freshAiSummary(s!, at);
  if (!summary && !scene) return "";
  const understood = s!.understandingStatus === "ready" && scene &&
    at >= Number(s!.understandingAt) && at - Number(s!.understandingAt) <= SCENE_TTL;
  const moment = freshScreenMoment(s, at);
  return [
    `前台窗口：${String(s!.title || "未命名窗口").slice(0, 120)}`,
    understood ? `页面类型：${String(s!.pageType || "uncertain").slice(0, 30)}；当前活动：${String(s!.activity || "不确定").slice(0, 90)}` : "",
    understood && s!.focus ? `内容主题：${String(s!.focus).slice(0, 120)}` : "",
    scene ? `AI画面总结：${scene.slice(0, 300)}` : "",
    moment ? `当前具体画面（来源时间 ${moment.capturedAt}）：${moment.fact}${moment.subtitle ? `；可见字幕：${moment.subtitle}` : ""}` : "",
    summary ? `可见文字（已筛选，保留原文顺序；仅辅助证据，不据此硬猜活动）：${summary.slice(0, scene ? 320 : 900)}` :
      "没有可靠文字；只依据当前画面总结，不猜测用户活动。",
  ].filter(Boolean).join("\n");
}

/** 忽略时钟、计数和排版微变；窗口切换仍必须重算稳定时间。 */
export function screenFingerprint(s: Pick<ScreenContextState, "title" | "summary" | "windowId">): string {
  const text = `${s.title}|${s.summary.slice(0, 450)}`.toLowerCase()
    .replace(/\d+(?:[.:/]\d+)*/g, "#").replace(/\s|[·，。！？、:：;；|]/g, "");
  let hash = 2166136261;
  for (const c of text) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return `${s.windowId || "window"}:${(hash >>> 0).toString(16)}`;
}

const MENU_WORDS = new Set([
  "文件", "编辑", "选择", "查看", "视图", "转到", "运行", "终端", "帮助", "工具", "窗口",
  "历史", "历史记录", "书签", "收藏夹", "扩展", "设置", "后退", "前进", "刷新", "地址栏",
  "file", "edit", "selection", "view", "go", "run", "terminal", "help", "tools", "window",
  "history", "bookmarks", "extensions", "settings", "back", "forward", "reload",
]);
const HUD = /(?:\b(?:hp|mp|fps|ping|score|ammo)\b|血量|生命值|帧率|延迟|弹药|得分)\s*[:：]?\s*\d+(?:\.\d+)?(?:\s*[/／]\s*\d+)?\s*(?:ms|%|毫秒)?/gi;

function menuCount(text: string): number {
  const words = text.toLowerCase().split(/[\s|｜·]+/).filter(Boolean);
  return words.length && words.every(word => MENU_WORDS.has(word)) ? words.length : 0;
}

function isNoise(text: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  if (/^(?:(?:上午|下午|AM|PM)\s*)?\d{1,2}[:：]\d{2}(?:[:：]\d{2})?(?:\s*(?:AM|PM))?$/i.test(text)) return true;
  if (/^(?:第\s*)?\d+\s*(?:页(?:\s*(?:[/／]\s*)?(?:共\s*)?\d+\s*页?)?|[/／]\s*\d+(?:\s*页)?|of\s+\d+)$/i.test(text)) return true;
  if (/^(?:page\s+\d+(?:\s*(?:of|\/)\s*\d+)?|\d+(?:[.,]\d+)?\s*%?|\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)$/i.test(text)) return true;
  if (!text.replace(HUD, "").replace(/[\s|｜,，;；/]+/g, "")) return true;
  const useful = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  const broken = (text.match(/[\uFFFD\u0000-\u0008\u000E-\u001F]/g) || []).length;
  return broken > Math.max(1, text.length * 0.15) ||
    /(?:锟斤拷|烫烫烫|屯屯屯){2,}/.test(text) ||
    (text.length >= 8 && useful < text.length * 0.25) ||
    /^(.)\1{7,}$/u.test(text);
}

function isBody(text: string): boolean {
  const useful = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  return useful >= 32 || (useful >= 16 && /[。！？；]/.test(text)) ||
    (useful >= 16 && /\b(?:const|let|function|return|import|export|class|async|if|for)\b.*[=({;"']/.test(text));
}

function lineKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
}

/** 规则筛选只推断可用文字区域，不推断用户关注点或活动。计数始终对应原 OCR 行。 */
export function normalizeScreen(raw: RawScreen) {
  const originalTitle = String(raw.title || "").trim();
  const source = Array.isArray(raw.lines) ? raw.lines.map(line => ({ text: String(line.text || ""), box: line })) :
    (raw.text ? String(raw.text).split(/\r\n?|\n/).map(text => ({ text, box: undefined as ScreenOcrLine | undefined })) : []);
  const rawLineCount = source.length;
  const masked = Number.isFinite(raw.maskedRegions) && raw.maskedRegions > 0 ?
    `已抹白 ${Math.floor(raw.maskedRegions)} 个遮挡窗口区域。` : "";
  const pauseReasons: Record<string, string> = {
    self: "前台是桌宠自身窗口，已暂停采集并清空内容。",
    desktop: "前台是桌面，已暂停采集并清空内容。",
    shell: "前台是任务栏或系统外壳，已暂停采集并清空内容。",
    unavailable: "没有可采集的前台窗口或客户区，已暂停并清空内容。",
    occluded: "前台客户区被其它窗口严重遮挡（单个窗口遮挡至少 80%），已暂停并清空内容。",
    sensitive: "前台窗口涉及敏感内容，已暂停采集并清空内容。",
  };
  // 原生暂停原因优先，桌面/自身窗口不能因标题关键词被误报为敏感窗口。
  const blocked = !raw.pauseReason && SENSITIVE_SCREEN.test(originalTitle);
  if (raw.pauseReason || blocked) return {
    title: "", summary: "", blocked,
    decision: (pauseReasons[raw.pauseReason || "sensitive"] || "前台窗口暂不可采集，已暂停并清空内容。") + masked,
    rawLineCount, keptLineCount: 0, filteredLineCount: rawLineCount,
  };

  const reasons = new Map<string, number>();
  const drop = (reason: string) => reasons.set(reason, (reasons.get(reason) || 0) + 1);
  const seen = new Set<string>();
  const hasSize = Number.isFinite(raw.width) && raw.width > 0 && Number.isFinite(raw.height) && raw.height > 0;
  const width = raw.width || 0, height = raw.height || 0;
  const browser = /chrome|chromium|edge|firefox|mozilla|浏览器/i.test(`${originalTitle} ${raw.windowClass || ""}`);
  const rows = source.map(({ text, box }) => ({ text: text.replace(/\s+/g, " ").trim(), box:
    hasSize && box && [box.left, box.top, box.width, box.height].every(Number.isFinite) &&
    box.left >= 0 && box.top >= 0 && box.width > 0 && box.height > 0 &&
    box.left + box.width <= width + 1 && box.top + box.height <= height + 1 ? box : undefined }));
  // 旧 IPC 没有几何时，仅移除开头连续至少四个明确菜单标签。
  let menuPrefix = 0;
  while (menuPrefix < rows.length && menuCount(rows[menuPrefix].text)) menuPrefix++;
  const candidates = rows.filter(({ text, box }, index) => {
    // 必须先检查整行；不能截断或分块后泄露同一行中的敏感值。
    if (SENSITIVE_SCREEN.test(text)) { drop("敏感信息"); return false; }
    if (!text || isNoise(text)) { drop("空白、时间页码或噪声"); return false; }
    const top = box && box.top + box.height <= Math.min(140, height * 0.18);
    const menus = menuCount(text);
    const nearbyMenu = box && rows.some((other, i) => i !== index && other.box && menuCount(other.text) &&
      Math.abs(other.box.top - box.top) <= Math.max(10, Math.min(20, box.height)));
    const toolbar = (menus >= (box ? 2 : 4) && (!box || top)) ||
      (menus && top && nearbyMenu) || (!box && menuPrefix >= 4 && index < menuPrefix) ||
      (browser && top && /^(?:(?:https?:\/\/|www\.)\S+|搜索或输入(?:网址|地址)|在地址栏中搜索|search or enter (?:address|url)|收藏夹|地址栏)$/i.test(text));
    if (toolbar) { drop("菜单工具栏"); return false; }
    return true;
  });
  // 只用中间的长句/代码建立正文证据，短标签与侧栏本身不能互相佐证。
  const bodyTexts = new Set<string>();
  const body = candidates.filter(({ text, box }) => {
    if (!isBody(text) || (box && !(box.left + box.width > width * 0.25 && box.left < width * 0.82 &&
      box.top >= Math.min(80, height * 0.1) && box.top + box.height < height * 0.94))) return false;
    const key = lineKey(text);
    if (bodyTexts.has(key)) return false;
    bodyTexts.add(key);
    return true;
  });
  const bodyChars = body.reduce((n, row) => n + row.text.length, 0);
  const strongBody = (body.length >= 2 && bodyChars >= 64) || body.some(row => row.text.length >= 120);
  const bodyBoxes = body.flatMap(row => row.box ? [row.box] : []);
  const bodyLeft = Math.min(...bodyBoxes.map(box => box.left));
  const bodyRight = Math.max(...bodyBoxes.map(box => box.left + box.width));
  const bodyBottom = Math.max(...bodyBoxes.map(box => box.top + box.height));
  const selected: string[] = [];
  let length = 0;
  let truncated = false;
  for (const { text, box } of candidates) {
    const gap = Math.max(12, width * 0.015);
    const edge = box && bodyBoxes.length && (
      (box.left + box.width <= width * 0.25 && box.left + box.width + gap < bodyLeft) ||
      (box.left >= width * 0.82 && box.left > bodyRight + gap) ||
      (box.top >= height * 0.94 && box.top > bodyBottom + 12));
    if (strongBody && edge && text.length <= 28 && !/[。！？；]/.test(text)) {
      drop("边缘短导航或侧栏"); continue;
    }
    // 先排除导航再去重，避免目录里同名条目让正文标题也被删除。
    const key = lineKey(text);
    if (seen.has(key)) { drop("重复"); continue; }
    seen.add(key);
    const remaining = 900 - length - (selected.length ? 1 : 0);
    if (selected.length >= 12 || remaining <= 0) { drop("显示上限"); continue; }
    const value = text.slice(0, remaining);
    truncated ||= value.length < text.length;
    selected.push(value);
    length += value.length + (selected.length > 1 ? 1 : 0);
  }
  const keptLineCount = selected.length;
  const filteredLineCount = rawLineCount - keptLineCount;
  const details = [...reasons].map(([reason, count]) => `${reason} ${count} 行`).join("、");
  const evidence = !keptLineCount ? "没有可靠文字，仅可参考画面，不猜测活动。" :
    !strongBody ? "正文证据不足，保留可确认的短文本，不据此猜测活动。" : "已保留正文顺序与换行。";
  return {
    title: originalTitle.slice(0, 120), summary: selected.join("\n"), blocked: false,
    decision: `仅采集前台窗口客户区；保留 ${keptLineCount}/${rawLineCount} 行，过滤 ${filteredLineCount} 行` +
      (details ? `（${details}）` : "") + `。${evidence}${truncated ? "正文已限长至 900 字以内。" : ""}${masked}`,
    rawLineCount, keptLineCount, filteredLineCount,
  };
}
