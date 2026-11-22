import { button } from "./dom";
import type { EventBus } from "../core/bus";

/** Collection permission, deliberately separate from the readout visibility button. */
export function createScreenToggle(bus: EventBus, api: Record<string, any>, extraClass = "") {
  let enabled = false;
  let pending = false;
  let error = "";
  const element = button("读屏：关", `screen-power ${extraClass}`, async () => {
    if (pending) return;
    pending = true; error = ""; render();
    try {
      const control = api["screen-awareness"];
      if (typeof control?.setEnabled !== "function") throw Error("读屏控制尚未就绪，请稍后再试");
      await control.setEnabled(!enabled);
      update(api["screen-awareness"]?.snapshot?.());
    } catch (e) { error = String(e instanceof Error ? e.message : e); }
    finally { pending = false; render(); }
  }) as HTMLButtonElement;
  element.type = "button";
  element.setAttribute("role", "switch");
  element.setAttribute("aria-label", "自动屏幕读取");
  function render() {
    element.textContent = pending ? "读屏：切换中…" : `读屏：${enabled ? "开" : "关"}`;
    element.disabled = pending;
    element.setAttribute("aria-checked", String(enabled));
    element.title = error || (enabled
      ? "点击关闭：停止自动读屏和画面分析，并清空当前观察；普通聊天和手动发图不受影响"
      : "已停止自动读屏和画面分析（不产生新的读屏模型请求）；点击开启");
    element.dataset.error = String(!!error);
  }
  function update(state: any) {
    if (!state) return;
    enabled = state.enabled === true;
    error = state.status === "error" && !enabled ? String(state.error || "读屏操作失败") : "";
    render();
  }
  bus.on("screen:status", update);
  update(api["screen-awareness"]?.snapshot?.());
  render();
  return element;
}
