import type { PetPlugin, PluginContext } from "../../core/pluginManager";
import { normalizeScreen, SCENE_TTL, SENSITIVE_SCREEN } from "../../chat/screenContext";
import type { RawScreen, ScreenMoment } from "../../chat/screenContext";
import type { ScreenContextState } from "../../chat/screenContext";
import { attentionPolicy, playingVideo, type ActivitySnapshot, type AttentionPolicy } from "../../chat/screenPolicy";
import { buildScreenObservationPrompt, parseScreenObservation, createScreenMoment, screenObservationError,
  isSensitiveObservationText, SCREEN_MOMENT_TTL } from "../../chat/screenObservation";

export interface ScreenSnapshot extends RawScreen {
  title: string; text: string; capturedAt: number; width: number; height: number;
  windowId: string; pauseReason?: string;
}
export interface ScreenState extends ScreenContextState {
  enabled: boolean;
  status: "off" | "waiting" | "watching" | "paused" | "error";
  summary: string; title: string; capturedAt: number; error: string;
  scene: string; sceneAt: number; aiSummary: string; aiSummaryAt: number;
  windowId?: string; pauseReason?: string;
  pageType?: string; activity?: string; focus?: string; understandingAt?: number;
  understandingStatus?: "waiting" | "ready" | "uncertain" | "error";
  understandingError?: string; screenMoment?: ScreenMoment;
  decision: string; rawLineCount: number; keptLineCount: number; filteredLineCount: number;
}
const DEFAULT_INTERVAL = 8000;
const VISION_EVERY = 30_000;
const emptyUnderstanding: Partial<ScreenState> = {
  scene: "", sceneAt: 0, aiSummary: "", aiSummaryAt: 0,
  pageType: undefined, activity: "", focus: "", understandingAt: 0,
  understandingStatus: "waiting", understandingError: "", screenMoment: undefined,
};
const empty = {
  title: "", summary: "", capturedAt: 0, error: "", scene: "", sceneAt: 0,
  aiSummary: "", aiSummaryAt: 0, windowId: "", pauseReason: "",
  decision: "屏幕感知已关闭，已清空内容。", rawLineCount: 0, keptLineCount: 0, filteredLineCount: 0,
  attentionMode: undefined, attentionAt: 0, attentionReason: "", ocrIntervalMs: undefined, visionIntervalMs: undefined,
  proactiveMin: undefined, backgroundMedia: undefined, backgroundApps: [],
  ...emptyUnderstanding,
};
let ctx: PluginContext;
let timer: ReturnType<typeof setTimeout> | undefined;
let busyGeneration: number | undefined;
let generation = 0;
let lastVisionAt = -Infinity;
let retryVisionAt = 0;
let visionController: AbortController | undefined;
let momentTimer: ReturnType<typeof setTimeout> | undefined;
let contextRevision = 0;
let windowKey = "";
let contentKey = "";
let toggleQueue: Promise<void> = Promise.resolve();
let state: ScreenState = { ...empty, enabled: false, status: "off" };
let broadcastQueue: Promise<unknown> = Promise.resolve();
let activity: ActivitySnapshot | undefined;
let policy: AttentionPolicy | undefined;
let lastObserveAt = -Infinity;
let observedWindow = "";
let nextVisionAt = 0;

function updatePolicy() {
  if (!activity) return;
  policy = attentionPolicy(activity, state);
  publish({ attentionMode: policy.mode, attentionAt: activity.observedAt, attentionReason: policy.reason,
    ocrIntervalMs: policy.ocrMs, visionIntervalMs: policy.visionMs, proactiveMin: policy.proactiveMin,
    backgroundMedia: playingVideo(activity),
    backgroundApps: activity.background.map(w => ({ title: w.title, kind: w.kind, minimized: w.minimized })) });
}
async function pollActivity() {
  const startedGeneration = generation;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    if (!state.enabled || generation !== startedGeneration) return;
    const value = await invoke<ActivitySnapshot>("screen_activity");
    if (!state.enabled || generation !== startedGeneration) return;
    if (!value || !Number.isFinite(value.observedAt) || !value.foreground || !Array.isArray(value.media) || !Array.isArray(value.background)) return;
    activity = value;
    if (value.sensitiveForeground || value.unavailable) {
      invalidateScene(); resetKeys();
      publish({ ...empty, enabled: true, status: "paused", pauseReason: value.sensitiveForeground ? "sensitive" : "unavailable",
        decision: value.sensitiveForeground ? "敏感窗口，已暂停并清空内容。" : "桌面不可用，已暂停并清空内容。" });
    } else if (state.windowId && value.foreground.windowId && state.windowId !== value.foreground.windowId) {
      // Metadata notices switches even while expensive OCR is throttled.
      invalidateScene(); resetKeys();
      publish({ ...empty, enabled: true, status: "waiting", decision: "窗口已变化，等待读取新页面。" });
    }
    updatePolicy();
  } catch {
    if (!state.enabled || generation !== startedGeneration) return;
    // Older shells/tests have no metadata command. Fail conservative, never
    // keep an old entertainment mode alive after this poll has failed.
    activity = undefined; policy = undefined;
    if (state.attentionMode) publish({ attentionMode: "normal", attentionAt: 0, attentionReason: "活动状态不可用，按普通节奏",
      backgroundMedia: undefined, backgroundApps: [], ocrIntervalMs: DEFAULT_INTERVAL, visionIntervalMs: VISION_EVERY, proactiveMin: 30 });
  }
}

function publish(patch: Partial<ScreenState>) {
  state = { ...state, ...patch };
  if (momentTimer) clearTimeout(momentTimer);
  momentTimer = undefined;
  if (state.screenMoment) {
    const moment = state.screenMoment;
    const remaining = moment.capturedAt + SCREEN_MOMENT_TTL - Date.now();
    if (remaining < 0 || moment.capturedAt > Date.now()) state = { ...state, screenMoment: undefined };
    else momentTimer = setTimeout(() => {
      if (state.screenMoment === moment) publish({ screenMoment: undefined });
    }, remaining + 1);
  }
  const snapshot = { ...state };
  ctx.bus.emit("screen:status", snapshot);
  // 关闭、暂停也必须按顺序广播，防止小窗留着上一帧。
  broadcastQueue = broadcastQueue.then(async () => {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("pet:screen", snapshot);
  }).catch(() => {});
}
function invalidateScene() {
  contextRevision++;
  visionController?.abort();
  // 保留占用直到 finally；即使服务不及时响应 abort，也不能另起并发请求。
}
function resetKeys() { windowKey = ""; contentKey = ""; nextVisionAt = 0; }
async function observe() {
  if (busyGeneration === generation || !state.enabled) return;
  const currentGeneration = generation;
  busyGeneration = currentGeneration;
  lastObserveAt = Date.now();
  try {
    if (!(window as any).__TAURI_INTERNALS__) throw new Error("屏幕感知仅桌面版可用");
    const { invoke } = await import("@tauri-apps/api/core");
    if (!state.enabled || currentGeneration !== generation) return;
    const raw = await invoke<ScreenSnapshot>("screen_observe");
    if (!state.enabled || currentGeneration !== generation) return;
    const { title, summary, blocked, decision, rawLineCount, keptLineCount, filteredLineCount } = normalizeScreen(raw);
    // lines 是新 IPC 的来源；旧 text 或任一原始行含敏感信息时都不发送截图。
    const sensitiveText = SENSITIVE_SCREEN.test(raw.text || "") || isSensitiveObservationText(raw.title || "") ||
      isSensitiveObservationText(raw.text || "") ||
      raw.lines?.some(line => isSensitiveObservationText(line.text));
    const paused = blocked || !!raw.pauseReason || sensitiveText;
    // 窗口身份才取消请求；同窗动态字幕不清理有截图来源时间的上次理解。
    const nextWindowKey = paused ? "" : JSON.stringify([raw.windowId || "", raw.title || ""]);
    const nextContentKey = paused ? "" : summary;
    const changed = nextWindowKey !== windowKey;
    const contentChanged = nextContentKey !== contentKey;
    if (changed || paused) invalidateScene();
    windowKey = nextWindowKey; contentKey = nextContentKey;
    const age = Date.now() - state.sceneAt;
    const undatedSummary = contentChanged && !state.understandingAt && !state.sceneAt && !!state.aiSummary;
    const clearScene = changed || undatedSummary || paused || (state.sceneAt > 0 && (age < 0 || age > SCENE_TTL));
    publish({
      status: paused ? "paused" : "watching",
      title: paused ? "" : title, summary: paused ? "" : summary,
      windowId: paused ? "" : raw.windowId,
      capturedAt: paused ? 0 : raw.capturedAt, error: "",
      pauseReason: raw.pauseReason || (blocked || sensitiveText ? "sensitive" : ""),
      decision: sensitiveText && !raw.pauseReason ? "可见文字涉及敏感内容，已暂停采集并清空内容。" : decision,
      rawLineCount, keptLineCount: paused ? 0 : keptLineCount, filteredLineCount: paused ? rawLineCount : filteredLineCount,
      ...(clearScene ? emptyUnderstanding : {}),
    });
    updatePolicy();
    const cadence = policy?.visionMs || VISION_EVERY;
    if (!paused && !visionController && Date.now() - lastVisionAt >= cadence && Date.now() >= retryVisionAt && Date.now() >= nextVisionAt) {
      lastVisionAt = Date.now();
      void lookOnce(raw, title, summary);
    }
  } catch (e) {
    if (state.enabled && currentGeneration === generation) {
      invalidateScene(); resetKeys();
      const changed = String(e).includes("前台窗口已变化");
      publish({ ...empty, status: changed ? "waiting" : "error", error: changed ? "" : String(e),
        decision: changed ? "前台窗口已变化，已清空旧内容，等待重新采集。" : "采集失败，已清空旧内容。" });
    }
  } finally { if (busyGeneration === currentGeneration) busyGeneration = undefined; }
}
async function lookOnce(raw: ScreenSnapshot, title: string, ocrSummary: string) {
  const controller = new AbortController();
  visionController = controller;
  const revision = contextRevision;
  const currentGeneration = generation;
  const sourceWindowKey = windowKey;
  const valid = () => !controller.signal.aborted && state.enabled && state.status === "watching" &&
    currentGeneration === generation && revision === contextRevision && sourceWindowKey === windowKey;
  publish({ understandingStatus: "waiting", understandingError: "" });
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    if (!valid()) return;
    // 原生目前仅返回 JPEG，无时间戳。以调用前时间作截图来源的保守下界；不是旧 OCR 或返回时刻。
    const capturedAt = Date.now();
    const b64 = await invoke<string>("screen_capture_image", {
      maxWidth: 1280, expectedWindowId: raw.windowId, expectedTitle: raw.title,
    });
    if (!valid()) return;
    if (!b64) throw new Error("空图");
    const { describeImage } = await import("../../chat/vision");
    if (!valid()) return;
    const response = await describeImage(b64, buildScreenObservationPrompt(title, ocrSummary), controller.signal);
    if (!valid()) return;
    const at = Date.now();
    const age = at - capturedAt;
    const ocrAge = at - state.capturedAt;
    // 同窗字幕可以变化，但结果仍属于当初截图；不能替旧图续命或恢复过期场景。
    if (age < 0 || age > SCENE_TTL || ocrAge < 0 || ocrAge > 30_000) {
      publish({ ...emptyUnderstanding, understandingStatus: "uncertain", understandingError: "截图或前台观察已过期，等待新画面。" });
      return;
    }
    const observation = parseScreenObservation(response);
    publish({ scene: observation.summary, sceneAt: capturedAt, aiSummary: observation.summary, aiSummaryAt: capturedAt,
      pageType: observation.pageType, activity: observation.activity, focus: observation.focus,
      understandingAt: capturedAt,
      understandingStatus: observation.confidence === "high" && observation.pageType !== "uncertain" ? "ready" : "uncertain",
      understandingError: "", screenMoment: createScreenMoment(observation, raw.windowId, capturedAt, at) });
    updatePolicy();
    // Vision may complete after the most recent OCR. Keep its independent cadence.
    nextVisionAt = capturedAt + (policy?.visionMs || VISION_EVERY);
  } catch (e) {
    // 含糊/失败从完成时起至少退避30秒，不能按开始时间立即重试。
    if (!controller.signal.aborted) retryVisionAt = Date.now() + VISION_EVERY;
    if (valid() && String(e).includes("前台窗口已变化")) {
      invalidateScene(); resetKeys();
      publish({ ...empty, status: "waiting", decision: "前台窗口已变化，已清空旧内容，等待重新采集。" });
    } else if (valid()) {
      publish({ ...emptyUnderstanding, understandingStatus: "error", understandingError: screenObservationError(e) });
    }
  } finally { if (visionController === controller) visionController = undefined; }
}
function schedule() {
  if (timer) clearTimeout(timer);
  if (!state.enabled) return;
  const scheduledGeneration = generation;
  timer = setTimeout(async () => {
    if (scheduledGeneration !== generation || !state.enabled) return;
    const previousMode = policy?.mode;
    await pollActivity();
    const window = activity?.foreground.windowId || "";
    const switched = !!window && window !== observedWindow;
    const due = Date.now() - lastObserveAt >= (policy?.ocrMs || DEFAULT_INTERVAL);
    if (!policy || due || (switched && policy.mode !== "work") || (previousMode !== policy.mode && policy.mode === "entertainment")) {
      if (!activity?.unavailable && !activity?.sensitiveForeground) { await observe(); observedWindow = window; }
    }
    // Work/read OCR and vision both wait ~20min. Metadata polling is not a
    // screenshot; work-to-work switches clear old content without recapturing.
    if (activity && !activity.unavailable && !activity.sensitiveForeground && state.status === "watching" && !visionController &&
      state.windowId === activity.foreground.windowId && Date.now() - state.capturedAt <= 30_000 &&
      Date.now() - lastVisionAt >= (policy?.visionMs || VISION_EVERY) && Date.now() >= retryVisionAt && Date.now() >= nextVisionAt) {
      lastVisionAt = Date.now();
      void lookOnce({ title: state.title, text: "", capturedAt: state.capturedAt, width: 0, height: 0, windowId: state.windowId || "" }, state.title, state.summary);
    }
    if (scheduledGeneration === generation) schedule();
  }, activity ? 4_000 : DEFAULT_INTERVAL);
}
async function setEnabled(enabled: boolean) {
  const requestGeneration = ++generation;
  // Persist a stop request before awaiting IPC, including on native failure.
  if (!enabled) ctx.setConfig({ enabled: false });
  if (timer) clearTimeout(timer);
  invalidateScene(); resetKeys();
  activity = undefined; policy = undefined; observedWindow = ""; lastObserveAt = -Infinity; nextVisionAt = 0;
  publish({ ...empty, enabled: false, status: "off" });
  if (!(window as any).__TAURI_INTERNALS__) {
    if (enabled) publish({ status: "error", error: "仅 Windows 桌面版可开启屏幕感知", decision: "当前不是桌面环境，无法采集屏幕。" });
    return;
  }
  try {
    const request = toggleQueue.then(async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      if (requestGeneration === generation) await invoke("screen_set_enabled", { enabled });
    });
    toggleQueue = request.catch(() => {});
    await request;
    if (requestGeneration !== generation) return;
    ctx.setConfig({ enabled });
    publish({ ...empty, enabled, status: enabled ? "waiting" : "off",
      ...(enabled ? { decision: "等待采集前台窗口客户区。" } : {}) });
    if (enabled) { await pollActivity(); if (state.enabled && requestGeneration === generation) {
      if (!activity?.unavailable && !activity?.sensitiveForeground) { await observe(); observedWindow = activity?.foreground.windowId || ""; }
      if (state.enabled) schedule();
    } }
  } catch (e) {
    if (requestGeneration === generation) publish({ ...empty, enabled: false, status: "error", error: String(e),
      decision: "屏幕感知开关操作失败，已清空内容。" });
  }
}
const plugin: PetPlugin = {
  manifest: {
    id: "screen-awareness", name: "屏幕感知", order: 20,
    description: "观察前台窗口的文字与画面；画面识别会调用已配置的视觉服务，原始截图不落盘。可随时关闭。",
    config: { enabled: false },
  },
  publicApi: { snapshot: () => ({ ...state }), setEnabled },
  async init(c) {
    ctx = c;
    const isDesktop = !!(window as any).__TAURI_INTERNALS__;
    const { getCurrentWindow } = isDesktop ? await import("@tauri-apps/api/window") : { getCurrentWindow: () => ({ label: "browser" }) };
    const ownsCollection = isDesktop && getCurrentWindow().label === "main";
    // One-time cost-safe upgrade. Thereafter both ON and OFF survive restarts.
    const firstManualUpgrade = ownsCollection && c.config.manualControlV1 !== true;
    if (firstManualUpgrade) c.setConfig({ enabled: false, manualControlV1: true });
    state = { ...empty, enabled: !firstManualUpgrade && c.config.enabled === true && ownsCollection, status: "off" };
  },
  start() { if (state.enabled) void setEnabled(true); },
  stop() { void setEnabled(false); },
};
export default plugin;
