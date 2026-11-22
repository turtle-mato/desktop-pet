import { button } from "./dom";
import { createScreenReadout } from "./screenReadout";

/** Main-window readout is opt-in UI only; it never toggles screen collection. */
export function createScreenPopover() {
  const screen = createScreenReadout();
  const element = screen.element;
  element.id = "main-screen-readout";
  element.classList.add("main-screen-readout");
  element.hidden = true;
  const trigger = button("屏幕", "tab main-screen-switch", () => setOpen(element.hidden));
  trigger.setAttribute("type", "button");
  trigger.setAttribute("aria-label", "查看屏幕读取核对面板");
  trigger.setAttribute("aria-controls", element.id);
  trigger.setAttribute("aria-expanded", "false");
  trigger.title = "查看她读到了什么（不改变读屏开关）";
  const close = button("收起", "mini-screen-toggle main-screen-close", () => setOpen(false, true));
  close.setAttribute("type", "button");
  element.querySelector(".mini-screen-head")?.append(close);
  function setOpen(open: boolean, restoreFocus = false) {
    element.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (restoreFocus) trigger.focus();
  }
  document.addEventListener("pointerdown", event => {
    if (!element.hidden && event.target instanceof Node && !element.contains(event.target) && !trigger.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !element.hidden) {
      event.preventDefault(); setOpen(false, true);
    }
  });
  return { element, trigger, update: screen.update };
}
