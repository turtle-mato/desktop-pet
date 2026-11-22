import { h, button } from "./dom";
import type { ScreenState } from "../plugins/screen-awareness";

/** 只消费共享状态；不采集、不推断、不向 AI 或存储发送面板缓存。 */
export type ScreenReadoutState = ScreenState & {
  pageType?: string;
  activity?: string;
  focus?: string;
  understandingAt?: number;
  understandingStatus?: "waiting" | "ready" | "uncertain" | "error";
  understandingError?: string;
  screenMoment?: { kind: string; fact: string; subtitle?: string; key: string; capturedAt: number };
};

export function notifyScreenLayout(): void {
  window.dispatchEvent(new Event("pet:screen-layout"));
}

const pauseReasons: Record<string, string> = {
  self: "当前是桌宠自身窗口，切回其他窗口后继续读取",
  desktop: "当前是桌面，暂停读取",
  shell: "当前是系统界面，暂停读取",
  unavailable: "当前窗口暂不可读取",
  occluded: "当前窗口被遮挡，暂停读取",
  sensitive: "敏感窗口，已清空识别内容",
};
const retainLastReasons = new Set(["self", "desktop", "shell", "unavailable", "occluded"]);
const pageTypes: Record<string, string> = {
  game: "游戏", anime: "动画番剧", video: "视频", article: "文章网页", webpage: "文章网页",
  chat: "聊天", coding: "代码", code: "代码", desktop: "桌面", other: "其他页面", uncertain: "不确定", unknown: "不确定",
  游戏: "游戏", 动画番剧: "动画番剧", 视频: "视频", 文章网页: "文章网页", 聊天: "聊天", 代码: "代码", 不确定: "不确定",
};
const UNDERSTANDING_TTL = 105_000;
const MOMENT_TTL = 30_000;
function timestamp(value: number): string {
  return value > 0 && Number.isFinite(value) ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false }) : "暂无";
}
function fresh(at: number, now: number, ttl: number): boolean {
  return Number.isFinite(at) && at > 0 && at <= now && now - at <= ttl;
}

export function createScreenReadout() {
  const status = h("span", { class: "mini-screen-status", role: "status", "aria-live": "polite" });
  const updated = h("time", { class: "mini-screen-updated" });
  const frameTime = h("time", { class: "mini-screen-time" });
  const page = h("div", { class: "mini-screen-page" });
  const ai = h("div", { class: "mini-screen-ai", tabindex: "0", role: "region", "aria-label": "画面内容" });
  const activity = h("div", { class: "mini-screen-activity" });
  const focus = h("div", { class: "mini-screen-focus" });
  const moment = h("div", { class: "mini-screen-moment" });
  const previous = h("div", { class: "mini-screen-previous" });
  const title = h("div", { class: "mini-screen-title", tabindex: "0", "aria-label": "窗口标题" });
  const ocr = h("div", { class: "mini-screen-ocr", tabindex: "0", role: "region", "aria-label": "实际选用的 OCR 正文" });
  const reason = h("div", { class: "mini-screen-reason" });
  const counts = h("div", { class: "mini-screen-counts" });
  const pacing = h("div", { class: "mini-screen-pacing" });
  const background = h("div", { class: "mini-screen-background" });
  const captured = h("div", { class: "mini-screen-captured" });
  let expanded = false;
  const toggle = button("展开正文", "mini-screen-toggle", () => {
    expanded = !expanded;
    element.dataset.expanded = String(expanded);
    toggle.textContent = expanded ? "收起正文" : "展开正文";
    toggle.setAttribute("aria-expanded", String(expanded));
    notifyScreenLayout();
  });
  toggle.setAttribute("type", "button");
  toggle.setAttribute("aria-expanded", "false");
  const details = h("details", { class: "mini-screen-details" }, [
    h("summary", {}, "识别详情（展开核对）"), title,
    h("div", { class: "mini-screen-label" }, [h("span", {}, "选用 OCR 正文"), toggle]),
    ocr, reason, counts, captured, updated, background,
  ]) as HTMLDetailsElement;
  details.addEventListener("toggle", notifyScreenLayout);
  const element = h("section", { class: "mini-screen", "aria-label": "她眼中的屏幕", "data-expanded": "false" }, [
    h("div", { class: "mini-screen-head" }, [h("b", {}, "她眼中的屏幕"), status]),
    previous, pacing, page,
    h("div", { class: "mini-screen-content" }, [h("span", { class: "mini-screen-label" }, "画面内容："), ai]),
    activity, focus, moment, frameTime, details,
  ]);

  // 缓存仅供普通暂停时在本 UI 核对；不采用暂停载荷中的任何语义或正文。
  let lastRead: ScreenReadoutState | undefined;
  let current: ScreenReadoutState | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const render = () => {
    if (expiryTimer) clearTimeout(expiryTimer);
    const state = current;
    const modes: Record<string, string> = {entertainment: "陪看", work: "工作少打扰", idle: "空闲省电", normal: "普通"};
    const livePolicy = !!state?.enabled && state?.pauseReason !== "sensitive" && state.attentionAt && Date.now() >= state.attentionAt && Date.now() - state.attentionAt <= 20_000;
    pacing.hidden = !livePolicy;
      const cadence = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 60_000)}分钟` : `${Math.round(ms / 1000)}秒`;
      pacing.textContent = livePolicy ? `节奏：${modes[state!.attentionMode || "normal"] || "普通"} · 读屏 ${cadence(state!.ocrIntervalMs || 8000)} / 理解 ${cadence(state!.visionIntervalMs || 30000)}` : "";
    pacing.title = livePolicy ? state!.attentionReason || "" : "";
    const media = livePolicy ? state!.backgroundMedia : undefined;
    const apps = livePolicy ? state!.backgroundApps || [] : [];
    background.textContent = media?.playing ? `后台播放：${media.title}（仅确认播放标题，未读取隐藏画面）` :
      apps.length ? `后台娱乐窗口：${apps.map(a => `${a.title}${a.minimized ? "（已最小化）" : ""}`).join("、")}；仅运行不代表正在使用` : "后台：未确认正在播放的视频";
    background.hidden = !livePolicy;
    const watching = !!state?.enabled && state.status === "watching" && state.pauseReason !== "sensitive";
    const reading = watching ? state : state?.enabled && state.status === "paused" && retainLastReasons.has(state.pauseReason || "") ? lastRead : undefined;
    const now = Date.now();
    const summary = reading?.aiSummary || reading?.scene || "";
    // 模型时间与 OCR 采集时间不能互相兜底，收到广播也不刷新模型寿命。
    const summaryAt = (reading?.aiSummary ? reading.aiSummaryAt : reading?.sceneAt) || 0;
    const understandingAt = reading?.understandingAt || summaryAt;
    const hasUnderstanding = !!(reading?.pageType || reading?.activity || reading?.focus);
    const modelAt = hasUnderstanding ? understandingAt : summaryAt;
    const hasAI = !!(summary || hasUnderstanding);
    const failed = reading?.understandingStatus === "error";
    const waiting = reading?.understandingStatus === "waiting";
    const uncertain = reading?.understandingStatus === "uncertain";
    const expired = hasAI && (!fresh(modelAt, now, UNDERSTANDING_TTL) || (!!summary && !fresh(summaryAt, now, UNDERSTANDING_TTL)));
    const earlierFrame = hasAI && !!reading?.capturedAt && (modelAt < reading.capturedAt || (!!summary && summaryAt < reading.capturedAt));
    const old = !!reading && (!watching || expired || earlierFrame);
    const usable = hasAI && !waiting && !failed;
    element.dataset.status = state?.status || "waiting";
    element.dataset.understanding = failed ? "error" : waiting || !hasAI ? "waiting" : expired ? "stale" : uncertain ? "uncertain" : "ready";
    status.textContent = !state ? "等待共享状态" : !state.enabled || state.status === "off" ? "已关闭"
      : state.pauseReason === "sensitive" ? "已隐藏" : state.status === "error" ? "读取异常"
      : state.status === "paused" ? "已暂停" : state.status === "waiting" ? "识别中" : "读取中";
    previous.hidden = !old;
    previous.textContent = !old ? "" : !watching ? "上次读取（旧画面，当前未采集）"
      : expired ? "旧画面理解（已过期，等待重新理解）" : "旧画面理解（文字已更新，等待理解新画面）";
    // 只翻译明确的模型字段，绝不按窗口标题、OCR 词或总结内容猜类型。
    const pageType = reading?.pageType || "";
    page.textContent = `${old && usable ? "上次看到" : "正在看"}：${usable && !uncertain && Object.hasOwn(pageTypes, pageType) ? pageTypes[pageType] : "不确定"}`;
    const fallback = failed || uncertain ? "暂时无法理解画面，仅识别到文字" : "文字已读取，正在理解画面";
    const inactive = !state ? "等待屏幕共享" : !state.enabled || state.status === "off" ? "屏幕读取已关闭"
      : state.pauseReason === "sensitive" ? "敏感窗口，已清空内容" : state.status === "error" ? "暂时无法读取画面" : "暂无画面，等待继续读取";
    ai.textContent = reading ? usable && summary ? summary : reading.summary ? fallback : failed ? "暂时无法理解画面" : "正在理解画面" : inactive;
    activity.textContent = `${old && usable ? "上次页面内容" : "页面内容"}：${reading ? usable && reading.activity ? reading.activity : failed || uncertain ? "暂时无法确定页面内容" : "等待画面理解，不推测活动" : "暂无"}`;
    focus.textContent = usable && reading?.focus ? `画面重点：${reading.focus}` : "";
    focus.hidden = !focus.textContent;
    const recent = reading?.screenMoment;
    moment.hidden = !recent?.fact || !fresh(recent.capturedAt, now, MOMENT_TTL);
    moment.textContent = moment.hidden ? "" : `刚才的画面：${recent!.fact}`;
    title.textContent = `窗口：${reading ? reading.title || "未提供标题" : "暂无当前窗口"}`;
    title.title = title.textContent;
    const displayedText = reading?.summary || (watching ? "本帧未选用 OCR 正文" : reading ? "上次未选用 OCR 正文" : "暂无当前 OCR 正文");
    if (ocr.textContent !== displayedText) { ocr.textContent = displayedText; ocr.scrollTop = 0; }
    const reasons: string[] = [];
    if (!state) reasons.push("尚未收到主窗口共享的屏幕状态");
    else if (!state.enabled || state.status === "off") reasons.push("屏幕读取已关闭");
    else if (state.pauseReason === "sensitive") reasons.push(pauseReasons.sensitive);
    else if (state.status === "error") reasons.push(state.error || "未提供异常详情");
    else if (state.status === "paused") reasons.push(pauseReasons[state.pauseReason || ""] || state.pauseReason || "未提供暂停原因");
    else if (state.status === "waiting") reasons.push("等待当前窗口识别结果");
    if (reading?.decision) reasons.push(`${watching ? "" : "上次过滤："}${reading.decision}`);
    if (failed && reading?.understandingError) reasons.push(`画面理解失败：${reading.understandingError}`);
    reason.textContent = `过滤 / 暂停：${reasons.join("；") || "未提供过滤判定"}`;
    const lineCounts = [["原始", reading?.rawLineCount], ["选用", reading?.keptLineCount], ["过滤", reading?.filteredLineCount]]
      .filter(([, value]) => typeof value === "number" && Number.isInteger(value) && Number(value) >= 0);
    counts.textContent = lineCounts.map(([name, value]) => `${name} ${value} 行`).join(" · ");
    counts.hidden = !lineCounts.length;
    captured.textContent = `${!watching && reading ? "上次文字采集" : "文字采集"}：${timestamp(reading?.capturedAt || 0)} · AI 总结：${timestamp(summaryAt)}${hasUnderstanding ? ` · 理解：${timestamp(understandingAt)}` : ""}`;
    // 有可展示的语义时按模型时间标记画面，不能让较新的 OCR 替旧 AI 续命。
    const frameAt = usable ? modelAt : reading?.capturedAt || 0;
    frameTime.textContent = frameAt > 0 ? `画面：${timestamp(frameAt)}（最近一次识别）` : "画面：暂未识别";
    if (frameAt > 0 && Number.isFinite(new Date(frameAt).getTime())) frameTime.setAttribute("datetime", new Date(frameAt).toISOString());
    else frameTime.removeAttribute("datetime");
    // 即使无新广播，30s 瞬间与 105s 理解也会自动失效；不伪造状态更新时间。
    const deadlines = [hasAI && fresh(modelAt, now, UNDERSTANDING_TTL) && modelAt + UNDERSTANDING_TTL + 1,
      summary && fresh(summaryAt, now, UNDERSTANDING_TTL) && summaryAt + UNDERSTANDING_TTL + 1,
      recent?.fact && fresh(recent.capturedAt, now, MOMENT_TTL) && recent.capturedAt + MOMENT_TTL + 1]
      .filter((at): at is number => typeof at === "number" && at > now);
    if (deadlines.length) expiryTimer = setTimeout(render, Math.min(...deadlines) - now);
    notifyScreenLayout();
  };
  const update = (state?: ScreenReadoutState) => {
    const watching = state?.enabled && state.status === "watching" && state.pauseReason !== "sensitive";
    const pausedWithLast = state?.enabled && state.status === "paused" && retainLastReasons.has(state.pauseReason || "");
    if (watching) {
      current = { ...state, screenMoment: state.screenMoment ? { ...state.screenMoment } : undefined };
      lastRead = current;
    } else {
      if (!pausedWithLast) lastRead = undefined;
      // 非采集载荷只保留控制信息，敏感/关闭时不缓存任何旧正文或语义。
      current = state ? { enabled: state.enabled, status: state.status, pauseReason: state.pauseReason, error: state.error,
        ...(state.enabled && state.pauseReason !== "sensitive" ? {attentionMode: state.attentionMode, attentionAt: state.attentionAt,
          attentionReason: state.attentionReason, ocrIntervalMs: state.ocrIntervalMs, visionIntervalMs: state.visionIntervalMs,
          backgroundMedia: state.backgroundMedia, backgroundApps: state.backgroundApps} : {}) } as ScreenReadoutState : undefined;
    }
    if (state) {
      const receivedAt = new Date();
      updated.setAttribute("datetime", receivedAt.toISOString());
      updated.textContent = `状态更新：${timestamp(receivedAt.getTime())}`;
      updated.title = "收到共享状态的时间；文字采集、AI 总结与理解时间分别显示，不代表同一帧";
    } else {
      updated.removeAttribute("datetime");
      updated.textContent = "状态更新：尚未收到";
    }
    render();
  };
  update();
  // 继续通知桌面壳实际高度；原生 details 开合及正文 toggle 也各自通知。
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(notifyScreenLayout).observe(element);
  return { element, update };
}
