// 桌面壳钩子（仅 Tauri 生效）：按窗口分发
// main 窗口：拖动区 / 八向缩放 / 顶栏按钮(⤢小窗 －最小化 📌置顶 ✕退出) / 记住手动大小
// mini 窗口：点角色拖动 / 对话头小工具(⇲回完整 📌 🗕收托盘) / 按内容自动贴合窗口大小
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, PhysicalPosition, currentMonitor } from "@tauri-apps/api/window";
import { planMiniPlacement, type MiniPlacement } from "./ui/miniGeometry";
import { setButtonIcon, type IconName } from './ui/icons';

const NON_DRAG = "button, input, textarea, a, select";
const SIZE_KEY = "pet.size"; // 记住 main 窗口手动大小（CSS 逻辑像素，换显示器不变形）

/** IPC（窗口按钮的后端通道）失败时：控制台报错 + 顶栏小圆点变红，便于一眼诊断 */
function ipcFail(where: string, e: unknown): void {
  console.error(`[desktop] 窗口命令失败（${where}）：`, e);
  try {
    document.body.classList.add("ipc-bad");
    const dot = document.querySelector<HTMLElement>(".dot");
    if (dot) {
      dot.title = "IPC 不可用：窗口按钮/拖动会失效（capability 未覆盖当前页面来源）";
    }
  } catch {}
}

function loadSavedSize(): { w: number; h: number } | null {
  try {
    const v = localStorage.getItem(SIZE_KEY);
    if (!v) return null;
    const o = JSON.parse(v);
    if (o && typeof o.w === "number" && typeof o.h === "number" && o.w >= 420 && o.h >= 600) {
      return { w: o.w, h: o.h };
    }
  } catch {}
  return null;
}

function makePinButton(): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "winbtn";
  setButtonIcon(b, 'unpin', '当前不置顶，点按置顶');
  b.title = "当前不置顶，点按置顶";
  b.addEventListener("click", () => {
    invoke("win_toggle_pin")
      .then((on) => {
        const pinned = Boolean(on);
        b.classList.toggle("pinned", pinned);
        setButtonIcon(b, pinned ? 'pin' : 'unpin', pinned ? '当前置顶，点按取消' : '当前不置顶，点按置顶');
        b.title = pinned ? "当前置顶，点按取消" : "当前不置顶，点按置顶";
      })
      .catch(() => {});
  });
  return b;
}

function makeHideButton(): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "winbtn";
  setButtonIcon(b, 'hide', '收进系统托盘');
  b.title = "收进系统托盘（托盘图标唤回）";
  b.addEventListener("click", () => invoke("win_hide").catch((e) => ipcFail("win_hide", e)));
  return b;
}

export async function initDesktopHooks(): Promise<void> {
  if (!(window as any).__TAURI_INTERNALS__) return;
  const { listen } = await import('@tauri-apps/api/event');
  await listen<{x:number;y:number}>('pet:cursor', ({payload}) => {
    window.dispatchEvent(new CustomEvent('pet:cursor', {detail:payload}));
  });
  document.body.classList.add("desktop");
  document.documentElement.classList.add("desktop");

  // 先做一次 IPC 健康检查（窗口按钮全靠它）
  try {
    const pong = await invoke("win_ping");
    if (pong !== "pong") throw new Error("unexpected ping reply: " + String(pong));
  } catch (e) {
    ipcFail("health-check", e);
    console.error("[desktop] 当前页面来源：", location.origin);
  }

  const win = getCurrentWindow();
  const isMini = win.label === "mini";

  // 拖动开始（避开控件）
  const attachDrag = (el: HTMLElement) => {
    el.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (e.button !== 0) return;
      if (t.closest && t.closest(NON_DRAG)) return;
      void win.startDragging().catch((e) => ipcFail("startDragging", e));
    });
  };

  // ================= main 窗口 =================
  if (!isMini) {
    for (const sel of [".topbar", ".stage", ".activity-bar"]) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) attachDrag(el);
    }

    // 八向缩放手柄
    const addHandle = (dir: string, cls: string) => {
      const hz = document.createElement("div");
      hz.className = "resize-handle " + cls;
      hz.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void win.startResizeDragging(dir as any).catch((e) => ipcFail("startResizeDragging", e));
      });
      return hz;
    };
    const handles = [
      addHandle("North", "rh-n"),
      addHandle("South", "rh-s"),
      addHandle("East", "rh-e"),
      addHandle("West", "rh-w"),
      addHandle("NorthEast", "rh-ne"),
      addHandle("NorthWest", "rh-nw"),
      addHandle("SouthEast", "rh-se"),
      addHandle("SouthWest", "rh-sw"),
    ];
    const appEl = document.querySelector<HTMLElement>(".pet-app");
    if (!appEl) return;
    for (const hz of handles) appEl.appendChild(hz);

    // 顶栏按钮
    const header = document.querySelector<HTMLElement>(".topbar");
    if (!header) return;
    const ctrl = document.createElement("div");
    ctrl.className = "win-ctrl";

    const btn = (icon: IconName, title: string, cmd: string) => {
      const b = document.createElement("button");
      b.className = "winbtn";
      setButtonIcon(b, icon, title);
      b.title = title;
      b.addEventListener("click", () => invoke(cmd).catch((e) => ipcFail(cmd, e)));
      ctrl.appendChild(b);
      return b;
    };
    btn('compact', "切换到 立绘小窗（只留角色和对话）", "win_show_mini");
    btn('minimize', "收进托盘（点托盘图标叫回来）", "win_minimize");
    ctrl.append(makePinButton());
    btn('close', "退出桌宠", "win_exit");
    header.appendChild(ctrl);

    // 记住手动缩放的大小（存 CSS 逻辑像素：换显示器/改缩放后打开还是这个观感）
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    win
      .onResized(() => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          try {
            const w = Math.round(window.innerWidth);
            const h = Math.round(window.innerHeight);
            if (w >= 420 && h >= 600) localStorage.setItem(SIZE_KEY, JSON.stringify({ w, h }));
          } catch {}
        }, 500);
      })
      .catch(() => {});

    // 恢复上次手动大小
    const saved = loadSavedSize();
    if (saved) {
      try {
        await win.setSize(new LogicalSize(saved.w, saved.h));
      } catch {}
    }
    return;
  }

  // ================= mini 窗口 =================
  const wrap = document.querySelector<HTMLElement>(".mini-wrap");
  const stage = document.querySelector<HTMLElement>(".mini-stage");
  const toolsEl = document.querySelector<HTMLElement>(".mini-tools");
  if (!wrap || !stage || !toolsEl) return;

  let hitSyncFrame = 0;
  const syncHitRegions = () => {
    cancelAnimationFrame(hitSyncFrame);
    hitSyncFrame = requestAnimationFrame(() => {
      const elements = [stage, ...wrap.querySelectorAll<HTMLElement>('.mini-chat, .mini-bubble, .mini-screen, .mini-menu, .mini-menu-button')];
      const regions = elements.filter(el => el.getClientRects().length && !el.hidden).map(el => {
        const r = el.getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height};
      });
      void invoke('mini_set_hit_regions',{regions}).catch(e=>ipcFail('mini-hit-regions',e));
    });
  };
  new ResizeObserver(syncHitRegions).observe(wrap);
  window.addEventListener('resize',syncHitRegions);
  window.addEventListener('scroll',syncHitRegions,true);

  // 对话头小工具
  const expand = document.createElement("button");
  expand.className = "winbtn";
  setButtonIcon(expand, 'expand', '完整窗口');
  expand.setAttribute('aria-label', '完整窗口');
  expand.title = "回到完整窗口";
  expand.addEventListener("click", () => invoke("win_show_main").catch(() => {}));
  toolsEl.append(expand, makePinButton(), makeHideButton());
  toolsEl.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
    b.setAttribute('aria-label', b.getAttribute('aria-label') || b.title || b.textContent || '窗口操作');
  });

  // 按内容贴合窗口：立绘是"绝对像素宽的框"，窗口贴着它；打开对话框时自动加宽到能聊天。
  // 角色框的唯一定义处是 styles.css 的 --mini-char-w / --mini-char-aspect，
  // 这里的常数只是读不到 CSS 变量时的兜底。
  const FALLBACK_CHAR_W = 200;
  const FALLBACK_CHAR_ASPECT = 0.806;
  const CHAT_MIN_W = 320; // 对话框展开时窗口至少这么宽，否则气泡没法看
  const SCREEN_MIN_W = 360; // 核对面板的标签、时间和正文需要的最小宽度。
  let placement: MiniPlacement | undefined;
  let pointerHeld = false;
  let dragRevision = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let fitting = false;
  let fitAgain = false;
  const fitOnce = async () => {
    try {
      const revision = dragRevision;
      const img = stage.querySelector<HTMLImageElement>(".mini-img");
      if (img && !img.complete) return; // renderer-ready 会在加载后重新测量。
      const [monitor, scale] = await Promise.all([currentMonitor(), win.scaleFactor()]);
      const chat = wrap.querySelector<HTMLElement>(".mini-chat");
      const screen = wrap.querySelector<HTMLElement>(".mini-screen");
      const chatHidden = wrap.classList.contains("chat-off");
      // 气泡是流式元素，不把它算进来的话窗口会把气泡裁掉
      const bubbleEl = wrap.querySelector<HTMLElement>(".mini-bubble");
      const cs = getComputedStyle(wrap);
      const charW = parseFloat(cs.getPropertyValue("--mini-char-w")) || FALLBACK_CHAR_W;
      const renderPad = parseFloat(cs.getPropertyValue('--mini-canvas-pad')) || 0;
      const charAspect = parseFloat(cs.getPropertyValue("--mini-char-aspect")) || FALLBACK_CHAR_ASPECT;
      const hasCanvas = !!stage.querySelector(".mini-canvas-wrap");
      // 角色区高度：优先量（这样改 CSS 也能跟着变），量不到（窗口隐藏时布局塌成 0）
      // 就按 CSS 里的比例算 —— 以前只量 .mini-img，Live2D 模式下量到 0 被兜成 140px 细条。
      const measured = stage.offsetHeight || 0;
      const roleH =
        measured > 60
          ? measured
          : hasCanvas
            ? Math.round(charW / charAspect)
            : Math.round(charW * (900 / 1600)); // 图片模式：立绘 PNG 是 1600x900
      // 窗口宽度要包住"判定框"（.mini-stage）本身：它的宽度 = 画布宽度 + 左右 padding
      // （padding 是判定框外扩的量，styles.css 里可调），外面再留 8px×2 给投影
      const stageCS = getComputedStyle(stage);
      const stagePadX =
        (parseFloat(stageCS.paddingLeft) || 0) + (parseFloat(stageCS.paddingRight) || 0);
      const stageW = Math.ceil(charW + stagePadX) + 16 + renderPad*2;
      const area = monitor?.workArea;
      const maxH = area ? area.size.height / scale : 900;
      const maxW = area ? area.size.width / scale : 1200;
      const hasBubble = bubbleEl && !bubbleEl.hidden;
      const hasScreen = !chatHidden && !!screen && !screen.hidden;
      const cssW = Math.round(Math.min(maxW, chatHidden && !hasBubble ? stageW : Math.max(stageW, CHAT_MIN_W + renderPad*2, hasScreen ? SCREEN_MIN_W + renderPad*2 : 0)));
      // 先确定宽度再量文字换行后的高度，避免首次展开测到旧宽度。
      wrap.style.width = `${Math.round(cssW)}px`;
      const margins = (el: HTMLElement) => {
        const style = getComputedStyle(el);
        return (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
      };
      const chatH = chatHidden || !chat ? 0 : chat.offsetHeight + margins(chat);
      // 先为气泡保留正文最小阅读高度，再把剩余空间交给核对面板。
      wrap.style.setProperty("--mini-bubble-text-max", "48px");
      const bubbleText = bubbleEl?.querySelector<HTMLElement>(".mini-bubble-text");
      const bubbleChrome = hasBubble ? bubbleEl.offsetHeight + 8 - (bubbleText?.offsetHeight || 0) : 0;
      const screenMargins = hasScreen ? margins(screen) : 0;
      const screenBudget = Math.max(64, maxH - roleH - chatH - screenMargins - (hasBubble ? bubbleChrome + 48 : 0) - 24 - renderPad*2);
      wrap.style.setProperty("--mini-screen-height-budget", `${Math.floor(screenBudget)}px`);
      const screenH = hasScreen ? screen.offsetHeight + screenMargins : 0;
      wrap.style.setProperty("--mini-bubble-text-max", `${Math.min(176, Math.max(48, maxH - roleH - chatH - screenH - bubbleChrome - 24 - renderPad*2))}px`);
      const bubbleH = hasBubble ? bubbleEl.offsetHeight + 8 : 0;
      const contentH = Math.max(140, Math.ceil(roleH + bubbleH + chatH + screenH) + 24 + renderPad*2);
      const cssH = Math.round(Math.min(maxH, contentH));
      // 极小工作区容纳不下角色与聊天时仍可滚动到面板，避免底部永久被裁掉。
      wrap.style.maxHeight = `${Math.floor(maxH)}px`;
      wrap.style.overflowY = contentH > maxH ? "auto" : "visible";
      const rect = stage.getBoundingClientRect();
      const anchor = { x: rect.x + rect.width / 2, y: rect.y + rect.height };
      // Measure position last, so a drag during layout calculation cannot restore a stale position.
      const [position, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
      if (pointerHeld || revision !== dragRevision) { fitAgain = true; return; }
      const next = planMiniPlacement(position, anchor, cssW, cssH, scale, area ? {
        x: area.position.x, y: area.position.y, width: area.size.width, height: area.size.height,
      } : undefined, placement);
      // Repeated screen/focus events are read-only when the layout is unchanged.
      if (Math.abs(size.width - Math.round(cssW * scale)) > 1 || Math.abs(size.height - Math.round(cssH * scale)) > 1) {
        await win.setSize(new LogicalSize(cssW, cssH));
      }
      if (pointerHeld || revision !== dragRevision) { fitAgain = true; return; }
      const resizedPosition = await win.outerPosition();
      if (pointerHeld || revision !== dragRevision) { fitAgain = true; return; }
      if (resizedPosition.x !== next.position.x || resizedPosition.y !== next.position.y) {
        await win.setPosition(new PhysicalPosition(next.position.x, next.position.y));
      }
      placement = next;
      syncHitRegions();
    } catch (e) { console.warn("[desktop] 小窗布局调整失败：", e); }
  };
  const fitWindow = async () => {
    fitAgain = true;
    if (fitting || pointerHeld) return;
    fitting = true;
    try {
      while (fitAgain && !pointerHeld) { fitAgain = false; await fitOnce(); }
    } finally { fitting = false; }
  };
  // 渲染器就绪（Live2D 模型加载完/图片加载完）后立刻重新贴合
  window.addEventListener("pet:renderer-ready", () => requestAnimationFrame(() => void fitWindow()));
  // 气泡出现/收起后窗口高度要跟着变
  window.addEventListener("pet:bubble", () => requestAnimationFrame(() => void fitWindow()));
  window.addEventListener("pet:screen-layout", () => requestAnimationFrame(() => void fitWindow()));

  // 点角色 = 切换对话框显隐（与"按住拖动"区分：位移>6px 视为拖动，不触发切换）
  let down = false;
  let started = false;
  let sx = 0;
  let sy = 0;
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest && t.closest(NON_DRAG)) return;
    down = true;
    pointerHeld = true;
    dragRevision++;
    clearTimeout(settleTimer);
    started = false;
    sx = e.clientX;
    sy = e.clientY;
  };
  const onMove = (e: MouseEvent) => {
    if (!down || started) return;
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > 6) {
      started = true;
      void win.startDragging().catch((e) => ipcFail("startDragging", e));
    }
  };
  const onUp = (e: MouseEvent) => {
    if (!down) return;
    down = false;
    pointerHeld = false;
    dragRevision++;
    settleTimer = setTimeout(() => void fitWindow(), 120);
    if (started) return; // 刚拖完，不切换
    if (Math.hypot(e.clientX - sx, e.clientY - sy) < 8) {
      wrap.classList.toggle("chat-off");
      requestAnimationFrame(() => void fitWindow());
    }
  };
  stage.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  // Native dragging can consume the WebView mouseup. The existing cursor feed
  // supplies the real button state, so queued layout changes resume after release.
  window.addEventListener('pet:cursor', ((e: CustomEvent<{ leftDown?: boolean }>) => {
    if (!pointerHeld || e.detail?.leftDown !== false) return;
    pointerHeld = false;
    dragRevision++;
    if (started) down = false;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => void fitWindow(), 120);
  }) as EventListener);

  // 立绘加载 & 显示后贴合
  setTimeout(() => void fitWindow(), 400);
  setTimeout(() => void fitWindow(), 1500);
  win.onFocusChanged(({ payload: focused }) => {
    // 窗口刚从隐藏变可见时，WebView 布局还没生效（量到 0），
    // 所以延后一拍再量，且量到不合理值时 fitWindow 会按 CSS 比例兜底
    if (focused) setTimeout(() => void fitWindow(), 260);
  });
}
