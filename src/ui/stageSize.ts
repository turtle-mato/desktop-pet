// 立绘区高度：可拖动调节 + 记住你调过的高度；双击恢复默认。
//
// 为什么需要它：恢复聊天记录后聊天区会变高，弹性布局会和立绘抢高度，
// 把立绘挤小。与其让布局自己算，不如高度由你定，并且记住。
import { getSection, setSection } from "../core/config";

const DEFAULTS = { stageHeight: 0 }; // 0 = 不指定，用 CSS 里的默认弹性高度
const MIN_H = 120; // 再小立绘就没法看了
const RESERVE = 300; // 窗口再矮也要给下面（活动条/状态/输入框/聊天）留这么多

export function savedStageHeight(): number {
  const n = Number(getSection("layout", DEFAULTS).stageHeight);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 把高度写进 CSS 变量 --stage-h；窗口太矮时自动压低，保证输入框仍在窗口内。
 * 传 0 = 清除，回到默认弹性高度。
 */
export function applyStageHeight(h: number): number {
  const max = Math.max(MIN_H, window.innerHeight - RESERVE);
  const v = h > 0 ? Math.min(Math.max(Math.round(h), MIN_H), max) : 0;
  if (v > 0) document.documentElement.style.setProperty("--stage-h", v + "px");
  else document.documentElement.style.removeProperty("--stage-h");
  return v;
}

/**
 * 造一根可拖的手柄（由调用方插到立绘区下面）。
 * 不能在这里用 stage.after(grip)：创建时 stage 还没挂进 DOM，after() 会直接空操作。
 */
export function initStageSizing(stage: HTMLElement): HTMLElement {
  const grip = document.createElement("div");
  grip.className = "stage-grip";
  grip.title = "上下拖动 = 调整立绘区高度；双击 = 恢复默认";

  // 启动时套用记住的高度（窗口变化时重新夹一次，避免输入框被挤出窗口）
  applyStageHeight(savedStageHeight());
  window.addEventListener("resize", () => applyStageHeight(savedStageHeight()));

  let dragging = false;
  let startY = 0;
  let startH = 0;
  let cur = 0;

  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startY = e.clientY;
    startH = stage.getBoundingClientRect().height;
    cur = Math.round(startH);
    grip.classList.add("dragging");
    grip.setPointerCapture(e.pointerId);
  });

  grip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    cur = applyStageHeight(startH + (e.clientY - startY));
  });

  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    grip.classList.remove("dragging");
    try {
      grip.releasePointerCapture(e.pointerId);
    } catch {}
    // 以"拖完那一刻量到的真实高度"为准（不存拖动过程中的中间值，避免存进去的跟看到的不一致）
    const h = Math.round(stage.getBoundingClientRect().height);
    if (h > 0) setSection("layout", { stageHeight: h });
  };
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);

  grip.addEventListener("dblclick", () => {
    setSection("layout", { stageHeight: 0 });
    applyStageHeight(0);
  });

  return grip;
}
