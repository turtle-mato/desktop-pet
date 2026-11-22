// 主界面组装：角色展示 + 活动栏 + 聊天 + 输入 + 面板
import { h, button } from "./dom";
import { createChatView } from "./chatView";
import { createPanelHost } from "./panels";
import { initStageSizing } from "./stageSize";
import { createScreenPopover } from "./screenPopover";
import { createScreenToggle } from "./screenToggle";
import { createImageInput } from "./imageInput";
import { createPetRenderer, bindRendererToChat } from "../render";
import { createViewSwitch } from './viewSwitch';
import { setButtonIcon } from './icons';
import type { EventBus } from "../core/bus";
import type { ChatEngine } from "../chat/engine";
import type { Session } from "../core/session";
import type { PersonaStore, AppearanceStore } from "../core/persona";
import type { ActivityKind } from "../types";
import type { ScreenState } from "../plugins/screen-awareness";

export interface IdentityLike {
  readonly name: string;
  readonly accentColor: string;
}

export interface AppDeps {
  bus: EventBus;
  identity: IdentityLike;
  engine: ChatEngine;
  session: Session;
  api: Record<string, any>;
  personas: PersonaStore;
  appearance: AppearanceStore;
  changeActivity: (kind: ActivityKind, label: string) => void;
}

export function formatScreenStatus(s: ScreenState): string {
  if (s.status === "error") return `👁 屏幕感知异常：${s.error.slice(0, 100)}`;
  if (!s.enabled) return "👁 屏幕感知：关闭（点击“读屏：关”可开启）";
  if (s.status === "paused") {
    const reasons: Record<string, string> = {
      self: "等你切回其他窗口，再继续观察",
      desktop: "当前是桌面，跳过图标和任务栏文字",
      shell: "当前是系统菜单或任务栏，暂停观察",
      unavailable: "暂时没有可读取的前台窗口",
      occluded: "前台窗口被浮窗大面积遮挡，暂不采用",
      sensitive: "敏感窗口，已隐藏识别结果",
    };
    return `👁 屏幕感知：${reasons[s.pauseReason || ""] || "已暂停观察，已隐藏识别结果"}`;
  }
  if (s.status === "waiting" || s.status === "off") return "👁 屏幕感知：识别中…";
  const head = `👁 正在看：${s.title || "未识别窗口"}${s.summary ? " · " + s.summary : "（暂未读到文字）"}`;
  // 看图得到的一句画面描述：她说"你游戏打得怎么样"靠的是这一句，不是 OCR。
  const scene = String(s.aiSummary || s.scene || "").trim();
  return scene ? `${head}　🤖 AI总结：${scene}` : head;
}

export function createApp(deps: AppDeps): HTMLElement {
  const { bus, identity, engine, session, api, personas, appearance, changeActivity } = deps;

  const panels = createPanelHost({ bus, engine, api, personas, appearance });

  // 调试入口：?panel=memory / ?panel=settings … 启动即打开某面板（无头截图与手动调试都靠它）
  const q = new URLSearchParams(location.search);
  const wantPanel = q.get("panel");
  if (wantPanel) setTimeout(() => panels.open(wantPanel), 600);
  // 调试入口：?say=你好 启动后自动发一句（用来验证"桌宠→mind→回复"整条链路）
  const wantSay = q.get("say");
  if (wantSay) setTimeout(() => void engine.ask(wantSay), 1500);

  // ---- 状态栏文本 ----
  const statusEl = h("div", { class: "status" });
  let mindState = "探测中…";
  let mindConnected = false;
  const refreshStatus = () => {
    const act = session.activity.label || "未选择";
    const mins = session.minutesOn();
    const todoOpen = api.todo?.stats?.().open ?? 0;
    const pomo = api.pomodoro?.describe?.() || "";
    const mode = mindConnected ? "大脑回复" : engine.isAi ? "AI" : "本地回复";
    statusEl.textContent =
      `${identity.name} · 正在：${act}（${mins} 分）· 待办 ${todoOpen} 项 · ${pomo ? pomo + " · " : ""}${mode} · ${mindState}`;
  };
  bus.on("mind:status", (hs: any) => {
    mindConnected = !!hs?.ok;
    mindState = hs?.ok ? `🧠 已连（情景 ${hs.memory?.episodes ?? 0}）` : "🧠 未连（本地模式）";
    refreshStatus();
  });
  bus.on("activity:changed", refreshStatus);
  bus.on("todo:changed", refreshStatus);
  bus.on("pomodoro:changed", refreshStatus);
  refreshStatus();

  const screen = createScreenPopover();
  bus.on("screen:status", screen.update);
  screen.update(api["screen-awareness"]?.snapshot?.() ?? { enabled: false, status: "off" } as ScreenState);

  // ---- 顶部栏 ----
  const nameEl = h("b", {}, identity.name);
  const tabs = h("div", { class: "tabs" }, [
    createScreenToggle(bus, api),
    screen.trigger,
    setButtonIcon(button("", "tab", () => panels.open("pomodoro")), 'timer', '番茄钟'),
    setButtonIcon(button("", "tab", () => panels.open("todo")), 'todo', '待办清单'),
    setButtonIcon(button("", "tab", () => panels.open("persona")), 'persona', '人格管理'),
    setButtonIcon(button("", "tab", () => panels.open("memory")), 'memory', '记忆'),
    setButtonIcon(button("", "tab", () => panels.open("settings")), 'settings', '设置'),
  ]);
  const header = h("header", { class: "topbar" }, [
    h("div", { class: "brand" }, [h("span", { class: "dot" }), nameEl]),
    tabs,
  ]);

  // ---- 角色舞台（界面统一使用中性色，保留立绘原色）----
  const flagEl = h("div", { class: "pet-flag" }, "");
  const stageSlot = h("div", { class: "pet-stage-slot" });
  const viewSwitch = createViewSwitch(appearance, bus);
  const stage = h("div", { class: "stage" }, [stageSlot, flagEl, viewSwitch.element]);
  const stageGrip = initStageSizing(stage); // 立绘区高度可拖 + 记住（见 ui/stageSize.ts）
  void createPetRenderer({
    imgClass: "pet-img",
    canvasClass: "pet-canvas",
    cfg: appearance.get(),
  }).then(({ renderer, note }) => {
    stageSlot.appendChild(renderer.element);
    viewSwitch.attach(renderer);
    bindRendererToChat(renderer, bus);
    bus.emit('avatar:renderer', { renderer, note });
    renderer.play("idle");
  });

  // ---- 当前活动设置 ----
  const gameNameIn = h("input", { class: "inp", placeholder: "在玩什么？回车确认" }) as HTMLInputElement;
  const gameRow = h("div", { class: "game-row", style: { display: "none" } }, gameNameIn);
  const confirmGame = () => {
    const v = gameNameIn.value.trim();
    changeActivity("game", v || "游戏");
    gameNameIn.value = "";
    gameRow.style.display = "none";
  };
  gameNameIn.addEventListener("keydown", (e) => e.key === "Enter" && confirmGame());

  const mkChip = (t: string, kind: ActivityKind, label: string) =>
    button(t, "chip", () => {
      changeActivity(kind, label);
      if (kind === "game") {
        gameRow.style.display = gameRow.style.display === "none" ? "" : "none";
        if (gameRow.style.display !== "none") gameNameIn.focus();
      } else {
        gameRow.style.display = "none";
      }
    });

  const activityBar = h("div", { class: "activity-bar" }, [
    h("span", { class: "lbl" }, "我在："),
    mkChip("工作", "work", "工作"),
    mkChip("学习", "study", "学习"),
    mkChip("游戏", "game", "游戏"),
    mkChip("休息", "rest", "休息"),
    mkChip("出门", "outside", "出门"),
    mkChip("不选了", "none", ""),
    gameRow,
  ]);

  // ---- 聊天区 ----
  const chatLog = createChatView(bus);

  const input = h("input", { class: "inp chat-inp", placeholder: `和${identity.name}说点什么…` }) as HTMLInputElement;
  const sendBtn = button("发送", "btn primary", () => doSend());

  const attachment = createImageInput(input, chatLog, text => engine.sayPet(text, "sys"));

  function doSend() {
    if (attachment.isReading()) return;
    const v = input.value.trim();
    const img = attachment.current();
    if ((!v && !img) || engine.isThinking) return;
    input.value = "";
    attachment.clear();
    void engine.ask(v, img || undefined);
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSend();
  });

  const inputRow = h("div", { class: "input-row" }, [attachment.filePick, attachment.preview, input, attachment.attachBtn, sendBtn]);

  const chat = h("section", { class: "chat" }, [chatLog, inputRow]);

  // 人格/外观变化 → 界面即时同步（名字 / 输入框占位）
  const syncVisuals = () => {
    const n = identity.name;
    nameEl.textContent = n;
    input.placeholder = `和${n}说点什么…`;
  };
  const onIdentityChange = () => {
    syncVisuals();
    refreshStatus();
  };
  bus.on("personas:changed", onIdentityChange);
  bus.on("appearance:changed", onIdentityChange);
  syncVisuals();

  // ---- 组装 ----
  return h("div", { class: "pet-app" }, [header, stage, stageGrip, activityBar, statusEl, chat, screen.element, panels.root]);
}
