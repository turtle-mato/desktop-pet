import { h, button } from "./dom";

/** 气泡只提示新消息，完整内容仍由现有聊天记录负责。 */
export function createSpeechBubble(reply: () => void) {
  const textEl = h("div", { class: "mini-bubble-text", tabindex: "0", role: "status", "aria-live": "polite" });
  const bubble = h("div", { class: "mini-bubble", "aria-label": "桌宠消息" });
  bubble.hidden = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline = 0;
  let remaining = 0;
  let hovered = false;
  let focused = false;
  let closing = false;
  let current = "";
  let lastText = "";
  let lastAt = 0;
  const queue: Array<{ text: string; kind?: string }> = [];
  const changed = () => window.dispatchEvent(new Event("pet:bubble"));
  const pause = () => {
    if (closing) return;
    clearTimeout(timer);
    remaining = Math.max(0, deadline - Date.now());
  };
  const resume = () => {
    if (hovered || focused || bubble.hidden || closing) return;
    clearTimeout(timer);
    deadline = Date.now() + remaining;
    timer = setTimeout(hide, remaining);
  };
  const drawNext = () => {
    const next = queue.shift();
    if (!next) return;
    current = next.text;
    textEl.textContent = next.text;
    textEl.scrollTop = 0;
    bubble.hidden = false;
    closing = false;
    void bubble.offsetHeight;
    bubble.classList.add("show");
    remaining = Math.min(45_000, Math.max(12_000, next.text.length * 280));
    deadline = Date.now() + remaining;
    resume(); changed();
  };
  function hide() {
    if (bubble.hidden || closing) return;
    clearTimeout(timer);
    closing = true;
    bubble.classList.remove("show");
    timer = setTimeout(() => {
      bubble.hidden = true; closing = false; current = "";
      hovered = focused = false;
      changed(); drawNext();
    }, 180);
  }
  const close = button("×", "mini-bubble-close", hide);
  close.setAttribute("aria-label", "关闭消息气泡");
  close.title = "关闭（Esc）";
  const replyBtn = button("回复", "mini-bubble-reply", () => {
    queue.length = 0;
    hide(); reply();
  });
  bubble.append(close, textEl,
    h("div", { class: "mini-bubble-actions" }, replyBtn));
  bubble.addEventListener("mouseenter", () => { if (!hovered && !focused) pause(); hovered = true; });
  bubble.addEventListener("mouseleave", () => { hovered = false; resume(); });
  bubble.addEventListener("focusin", () => { if (!focused && !hovered) pause(); focused = true; });
  bubble.addEventListener("focusout", (e) => {
    if (bubble.contains(e.relatedTarget as Node)) return;
    focused = false; resume();
  });
  bubble.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); hide(); } });
  return {
    element: bubble,
    show(raw: string, kind?: string) {
      const text = String(raw || "").trim();
      if (!text || text === current || queue.some((item) => item.text === text) ||
        (text === lastText && Date.now() - lastAt < 30_000)) return;
      lastText = text; lastAt = Date.now();
      // 屏幕提示不堆积：最多保留最近三条，完整对话一直在聊天窗口。
      if (queue.length >= 3) queue.shift();
      queue.push({ text, kind });
      if (bubble.hidden) drawNext();
    },
  };
}
