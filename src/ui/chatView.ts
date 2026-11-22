// 聊天视图：渲染气泡，订阅 bus 事件
import { h } from "./dom";
import type { EventBus } from "../core/bus";

export function createChatView(bus: EventBus): HTMLElement {
  const log = h("div", { class: "chat-log" });
  const scroll = () => {
    log.scrollTop = log.scrollHeight;
  };

  let streamEl: HTMLElement | null = null;
  let thinkingEl: HTMLElement | null = null;
  bus.on("chat:reset", () => {
    log.replaceChildren();
    streamEl = null;
    thinkingEl = null;
  });

  bus.on("chat:user", ({ text }) => {
    streamEl = null;
    log.appendChild(h("div", { class: "bubble user" }, String(text)));
    scroll();
  });

  bus.on("chat:pet", ({ text, kind }) => {
    if (streamEl) {
      streamEl.remove();
      streamEl = null;
    }
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
    const cls = "bubble pet" + (kind && kind !== "pet" ? ` ${kind}` : "");
    log.appendChild(h("div", { class: cls }, String(text)));
    scroll();
  });

  bus.on("chat:delta", ({ text }) => {
    if (!streamEl) {
      streamEl = h("div", { class: "bubble pet streaming" });
      log.appendChild(streamEl);
    }
    streamEl.textContent = String(text);
    scroll();
  });

  bus.on("chat:divider", ({ text }) => {
    streamEl = null;
    log.appendChild(h("div", { class: "chat-divider" }, String(text || "")));
    scroll();
  });

  bus.on("chat:thinking", ({ on }) => {
    if (on) {
      if (!thinkingEl) {
        thinkingEl = h("div", { class: "bubble pet thinking" }, "…");
        log.appendChild(thinkingEl);
        scroll();
      }
    } else if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  });

  return log;
}
