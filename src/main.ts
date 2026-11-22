// 入口：装配总线 / 人格档案 / 会话 / 引擎 / 插件 / UI
import "./styles.css";
import { EventBus } from "./core/bus";
import { installScreenControl } from "./core/screenControl";
import { KV } from "./core/storage";
import { getSection, setSection } from "./core/config";
import { Session } from "./core/session";
import { primeEnv } from "./core/env";
import { primeCharacterFile } from "./core/character";
import { PersonaStore, AppearanceStore } from "./core/persona";
import { ChatEngine } from "./chat/engine";
import { PluginManager, type PluginContext } from "./core/pluginManager";
import { plugins } from "./plugins";
import { loadExternalPlugins } from "./plugins/external";
import { createApp } from "./ui/app";
import { createMiniApp } from "./ui/mini";
import { createAvatarControl } from './render/avatar';
import { primeMindHandshake } from "./mind/client";
import { mindHealth, mindRecentMessages, mindUsable, mindCfg, MIND_DEFAULTS } from "./mind/client";
import type { ActivityKind } from "./types";
import { createRecentChatRestorer } from "./chat/restore";

/**
 * 把最近一天的对话重新画回聊天窗口，重启后不会一片空白。
 * 只取桌宠这个窗口的对话（channel=pet），命令行测试的内容不会混进来。
 * 拿不到就静默跳过（没连上思维系统时不该弹报错）。
 */

/** 运行环境探测：浏览器=null；Tauri 主窗="main"；立绘小窗="mini" */
async function detectWindowLabel(): Promise<string | null> {
  try {
    // 浏览器调试用：?win=mini 可直接预览小窗界面（无头截图/手动调试都靠它）
    const q = new URLSearchParams(location.search).get("win");
    if (q) return q;
    if (!(window as any).__TAURI_INTERNALS__) return null;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().label;
  } catch {
    return null;
  }
}

/**
 * 连不上时自动把思维系统拉起来（桌面壳的 ensure_mind 命令）。
 * 一分钟最多试一次，避免在她真的起不来时反复 spawn。
 * @returns 是否真的拉起了新进程（调用方可以过几秒再探一次状态）
 */
let lastMindStartTry = 0;
async function tryStartMind(): Promise<boolean> {
  if (!(window as any).__TAURI_INTERNALS__) return false; // 浏览器里没这个能力
  const cfg = mindCfg();
  if (cfg.autoStart === false) return false;
  const now = Date.now();
  if (now - lastMindStartTry < 60_000) return false;
  lastMindStartTry = now;
  try {
    const port = Number(new URL(cfg.url || MIND_DEFAULTS.url).port || 8430);
    const { invoke } = await import("@tauri-apps/api/core");
    const r = await invoke<string>("ensure_mind", { port });
    console.log("[mind] 自动拉起思维系统：", r);
    return String(r).startsWith("started");
  } catch (e) {
    console.warn("[mind] 自动拉起失败（继续用本地模式）：", e);
    return false;
  }
}

async function main() {
  // ① 启动器环境信息 ② 外置角色卡 ③ 思维系统连接信息（本地握手）
  await primeEnv();
  await primeCharacterFile();
  await primeMindHandshake();

  const bus = new EventBus();
  const session = new Session();
  const personaStore = new PersonaStore(bus);
  const appearance = new AppearanceStore(bus);
  const apiRef: Record<string, any> = {};

  // 界面身份 = 当前人格名字 + 外观设置（动态 getter，切换人格即时变化）
  const identity = {
    get name(): string {
      return personaStore.active().name;
    },
    get accentColor(): string {
      return appearance.get().accentColor;
    },
  };

  // 对话引擎（实现 ChatApi，人设来自激活人格）
  const engine = new ChatEngine({ bus, session, apiRef, personas: personaStore });
  const restoreRecentChat = createRecentChatRestorer({
    usable: mindUsable,
    recent: () => mindRecentMessages(200, 24, mindCfg().channel || "pet"),
    thinking: () => engine.isThinking,
    apply: turns => engine.restoreRecent(turns),
  });

  // 插件管理器（内置 + 外置）
  const makeCtx = (id: string): PluginContext => {
    const defaults = mgr.defaultConfig(id) ?? {};
    return {
      id,
      bus,
      kv: new KV("plg." + id),
      config: getSection(id, defaults),
      setConfig: (patch) => setSection(id, patch),
      session,
      chat: engine,
      api: apiRef,
      log: (m) => console.log(`[plugin:${id}]`, m),
    };
  };
  const mgr = new PluginManager(makeCtx);
  mgr.api = apiRef; // publicApi 汇集到同一引用，引擎/UI 可读
  for (const p of plugins) mgr.register(p);

  // 外置插件：app/plugins/plugins.json + 各文件夹（改文件即生效，无需重打包）
  const external = await loadExternalPlugins({ mgr, makeCtx });

  await mgr.initAll();

  // UI：main 窗口 = 完整界面；mini 窗口 = 只有立绘 + 对话框
  const changeActivity = (kind: ActivityKind, label: string) => {
    session.setActivity(kind, label);
    bus.emit("activity:changed", { kind, label });
  };
  const winLabel = await detectWindowLabel();
  const isMini = winLabel === "mini";
  apiRef.avatar = await createAvatarControl(bus, winLabel);
  if (winLabel && (window as any).__TAURI_INTERNALS__) {
    await installScreenControl(apiRef, bus, isMini, await import("@tauri-apps/api/event"));
  }
  const app = isMini
    ? createMiniApp({ bus, engine, identity, appearance, api: apiRef })
    : createApp({
        bus,
        identity,
        engine,
        session,
        api: apiRef,
        personas: personaStore,
        appearance,
        changeActivity,
      });
  const rootEl = document.getElementById("app")!;
  rootEl.textContent = ""; // 清掉"加载中"占位
  rootEl.appendChild(app);

  // 大小窗共用同一段对话：任一边说的话都广播给另一边画出来。
  // 只同步显示——真正的上下文在思维系统服务端，两边问的是同一段记忆。
  if (winLabel) {
    const { emit: emitAll, listen } = await import("@tauri-apps/api/event");
    // 只同步视角，不重建窗口，也不触碰聊天或人格。
    let lastView = appearance.get().view;
    await listen<{ from: string; view: 'full' | 'upper' }>('pet:view-sync', ({ payload }) => {
      if (!payload || payload.from === winLabel || !['full', 'upper'].includes(payload.view)) return;
      lastView = payload.view;
      appearance.set({ view: payload.view });
    });
    bus.on('appearance:changed', () => {
      const view = appearance.get().view;
      if (view === lastView) return;
      lastView = view;
      void emitAll('pet:view-sync', { from: winLabel, view });
    });
    const seenSync = new Set<string>();
    const messageId = (role: "user" | "assistant", e: any) => {
      const ts = Number(e?.ts) || Date.now();
      return String(e?.id || `${winLabel}:${role}:${ts}:${String(e?.text || "")}`);
    };
    const relay = (role: "user" | "assistant", e: any) => {
      if (!e || e.restore || !String(e.text || "").trim()) return;
      const id = messageId(role, e);
      if (seenSync.has(id)) return;
      seenSync.add(id);
      const payload = { id, role, text: String(e.text), ts: Number(e.ts) || Date.now(), from: winLabel };
      console.log(`[sync:${winLabel}] send chat`, payload.id, payload.role, payload.text.slice(0, 40));
      void emitAll("pet:chat-sync", payload);
    };
    bus.on("chat:user", (e) => relay("user", e));
    bus.on("chat:pet", (e) => relay("assistant", e));
    bus.on("chat:thinking", (e: any) => {
      void emitAll("pet:thinking", { from: winLabel, on: !!e?.on });
    });
    await listen<{ from: string; on: boolean }>("pet:thinking", ({ payload }) => {
      if (payload?.from !== winLabel) bus.emit("chat:remote-thinking", payload);
    });
    // 她主动开口时，小窗那边要弹气泡（聊天记录是收着的，只写进记录人看不见）
    bus.on("chat:pet", (e: any) => {
      if (!e || e.restore || !String(e.text || "").trim()) return;
      if (e.kind === "sys") return;
      const bubble = { text: String(e.text), kind: e.kind, from: winLabel };
      console.log(`[bubble:${winLabel}] local`, e.kind || "pet", String(e.text).slice(0, 80));
      bus.emit("pet:bubble", bubble);
      void emitAll("pet:bubble", bubble).catch((err) => console.warn(`[bubble:${winLabel}] broadcast failed`, err));
    });
    await listen<{ id?: string; role: "user" | "assistant"; text: string; ts?: number; from: string }>("pet:chat-sync", (ev) => {
      const p = ev.payload;
      if (!p || p.from === winLabel || !String(p.text || "").trim()) return;
      const id = String(p.id || `${p.from}:${p.role}:${p.ts || 0}:${p.text}`);
      if (seenSync.has(id)) return;
      seenSync.add(id);
      const n = engine.merge([{ role: p.role, text: p.text, ts: p.ts }]);
      console.log(`[sync:${winLabel}] recv chat`, id, `added=${n}`);
    });
    await listen<{ text: string; from: string; kind?: string }>("pet:bubble", (ev) => {
      const p = ev.payload;
      if (!p || p.from === winLabel || !String(p.text || "").trim()) return;
      console.log(`[bubble:${winLabel}] remote`, p.kind || "pet", String(p.text).slice(0, 80));
      bus.emit("pet:bubble", { text: String(p.text), kind: p.kind });
    });
    await listen<{ from: string }>("pet:chat-request", (ev) => {
      const from = String(ev.payload?.from || "");
      if (!from || from === winLabel) return;
      console.log(`[sync:${winLabel}] snapshot requested by ${from}, turns=${engine.history.length}`);
      void emitAll("pet:chat-snapshot", {
        from: winLabel,
        to: from,
        turns: engine.history.slice(-40),
      });
    });
    await listen<{ from: string; to?: string; turns?: Array<{ role: "user" | "assistant"; text: string; ts?: number }> }>("pet:chat-snapshot", (ev) => {
      const p = ev.payload;
      if (!p || p.from === winLabel || (p.to && p.to !== winLabel) || !Array.isArray(p.turns)) return;
      const n = engine.merge(p.turns);
      console.log(`[sync:${winLabel}] snapshot from ${p.from}, turns=${p.turns.length}, added=${n}`);
    });
    // 两个 WebView 启动时间可能不同；请求一次完整快照，补上启动阶段或 mind 查询失败造成的缺口。
    void emitAll("pet:chat-request", { from: winLabel });
    // 小窗自己没有屏幕采集权限，用主窗广播过来的快照
    if (isMini) {
      await listen<any>("pet:screen", (ev) => {
        const p = ev.payload;
        if (!p) return;
        apiRef["screen-awareness"] = { ...(apiRef["screen-awareness"] ?? {}), snapshot: () => p };
        bus.emit("screen:status", p);
      });
      // The first observation may finish before mini's listener is ready.
      void emitAll("pet:screen-request", { from: winLabel });
    } else {
      await listen<{ from?: string }>("pet:screen-request", ({ payload }) => {
        if (payload?.from !== "mini") return;
        const snapshot = apiRef["screen-awareness"]?.snapshot?.();
        if (snapshot) void emitAll("pet:screen", snapshot);
      });
    }
  }

  // 每秒心跳（插件计时/提醒用）
  setInterval(() => bus.emit("tick:1s", { ts: Date.now() }), 1000);

  // 她的状态探测：启动即探一次，之后每 30 秒一次；状态栏能看到"🧠已连/未连"
  const probeMind = async () => {
    const hs = await mindHealth();
    bus.emit("mind:status", hs);
    if (hs.ok) {
      await primeMindHandshake();
      await restoreRecentChat();
    }
    if (!hs.ok) {
      console.warn("[mind] 没连上她的思维系统：", hs.error, "（先用本地模式顶着）");
      const started = await tryStartMind();
      if (started) setTimeout(() => void probeMind(), 4000); // 等她起来再报一次状态
    }
  };
  void probeMind();
  setInterval(() => void probeMind(), 30_000);

  // 恢复重启前的聊天记录（一天以内）：重启不该让聊天窗口变空
  await restoreRecentChat();

  // 启动插件 & 打招呼：只在完整窗口里跑，免得两个窗口各说一遍
  if (!isMini) {
    mgr.startAll();
    engine.boot();
  } else {
    // 小窗才是常显的那个。主窗口被隐藏后 WebView 会把定时器节流到几乎不跑，
    // 主动对话的循环就断了——所以小窗也要把 proactive 起起来。
    // 两个窗口都可见时由插件内部的可见性判断 + 抢占锁保证只有一边开口。
    mgr.startOnly(["proactive"]);
  }

  // Tauri 桌面环境钩子（非桌面环境自动跳过）
  import("./desktop").then((m) => m.initDesktopHooks()).catch(() => {});

  // 调试入口（控制台可用）
  (window as any).__pet = {
    engine,
    api: apiRef,
    bus,
    session,
    personas: personaStore,
    appearance,
    mgr,
    externalPlugins: external,
  };
}

main().catch((e) => {
  console.error("[main] 启动失败", e);
  const root = document.getElementById("app")!;
  root.innerHTML = `<pre style="padding:20px;color:#c0392b">启动失败：${String(e)}</pre>`;
});
