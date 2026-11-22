// 立绘小窗（mini 窗口）：只放角色图 + 下方对话框，透明无框，点角色拖动
import { h, button } from "./dom";
import { createSpeechBubble } from "./speechBubble";
import { createScreenReadout, notifyScreenLayout } from "./screenReadout";
import { createScreenToggle } from "./screenToggle";
import { createChatView } from "./chatView";
import { createImageInput } from "./imageInput";
import { createPetRenderer, bindRendererToChat } from "../render";
import type { EventBus } from "../core/bus";
import type { ChatEngine } from "../chat/engine";
import type { IdentityLike } from "./app";
import type { AppearanceStore } from '../core/persona';
import { createViewSwitch } from './viewSwitch';

export interface MiniDeps {
  bus: EventBus;
  engine: ChatEngine;
  identity: IdentityLike;
  /** 外观配置（渲染器/模型路径），来自 AppearanceStore */
  appearance: AppearanceStore;
  /** 可由 main 注入共享快照；未注入时等待 screen:status 广播。 */
  api?: Record<string, any>;
}

export function createMiniApp(deps: MiniDeps): HTMLElement {
  const { bus, engine, identity } = deps;
  document.body.classList.add("mini-page");

  const slot = h("div", { class: "mini-stage-slot" });
  const viewSwitch = createViewSwitch(deps.appearance, bus);
  const stage = h("div", { class: "mini-stage" }, [slot]);
  void createPetRenderer({
    imgClass: "mini-img",
    canvasClass: "mini-canvas",
    wrapClass: "mini-canvas-wrap",
    tightFit: true, // 小窗：按立绘实际像素贴合，于是窗口/判定框就贴着立绘
    cfg: deps.appearance.get(),
  }).then(({ renderer, note }) => {
    slot.appendChild(renderer.element);
    viewSwitch.attach(renderer);
    bindRendererToChat(renderer, bus);
    bus.emit('avatar:renderer', { renderer, note });
    renderer.play("idle");
    // 告诉桌面壳"角色区就绪了"，让它按新的内容高度重新贴合窗口
    // （Live2D 的 canvas 尺寸由渲染器决定，不通知的话外壳量不到高度）
    requestAnimationFrame(() => window.dispatchEvent(new Event("pet:renderer-ready")));
  });

  const nameEl = h("span", { class: "mini-name" }, identity.name);
  const tools = h("div", { class: "mini-tools" });
  const closeChat = button('×', 'mini-close-chat', () => {
    wrap.classList.add('chat-off');
    notifyScreenLayout();
  });
  closeChat.setAttribute('aria-label', '收起聊天');
  const head = h("div", { class: "mini-head" }, [nameEl, closeChat]);

  const log = createChatView(bus);
  log.classList.add("mini-log");

  const input = h("input", {
    class: "inp chat-inp",
    placeholder: `和${identity.name}说…`,
  }) as HTMLInputElement;
  const doSend = () => {
    if (attachment.isReading()) return;
    const v = input.value.trim();
    const image = attachment.current();
    if ((!v && !image) || engine.isThinking) return;
    input.value = "";
    attachment.clear();
    void engine.ask(v, image || undefined);
  };
  const attachment = createImageInput(input, log, text => engine.sayPet(text, "sys"));
  const sendBtn = button("发送", "btn primary", doSend);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSend();
  });

  const body = h("div", { class: "mini-body" }, log);
  const chat = h("div", { class: "mini-chat" }, [
    head,
    body,
    h("div", { class: "input-row mini-input" }, [attachment.filePick, attachment.preview, input, attachment.attachBtn, sendBtn]),
  ]);
  const screen = createScreenReadout();
  const screenVisibilityKey = "desktop-pet.v1.ui.screenReadout";
  let screenVisible = false;
  try { screenVisible = localStorage.getItem(screenVisibilityKey) === "true"; } catch {}
  const screenSwitch = button("屏幕", "mini-screen-switch", () => {
    screenVisible = !screenVisible;
    try { localStorage.setItem(screenVisibilityKey, String(screenVisible)); } catch {}
    applyScreenVisibility();
  });
  screenSwitch.setAttribute("role", "switch");
  screenSwitch.setAttribute("aria-label", "显示屏幕读取核对面板");
  screenSwitch.setAttribute("aria-controls", "mini-screen-readout");
  screen.element.id = "mini-screen-readout";
  function applyScreenVisibility() {
    screen.element.hidden = !screenVisible;
    screenSwitch.setAttribute("aria-checked", String(screenVisible));
    screenSwitch.title = `${screenVisible ? "隐藏" : "显示"}屏幕核对面板（屏幕感知保持运行）`;
    notifyScreenLayout();
  }
  const screenControls = h('div', { class: 'mini-menu-screen' }, [createScreenToggle(bus, deps.api ?? {}), screenSwitch]);
  applyScreenVisibility();
  bus.on("screen:status", screen.update);
  const syncScreen = () => {
    try {
      const state = deps.api?.["screen-awareness"]?.snapshot?.();
      if (state) screen.update(state);
    } catch (e) { console.warn("[mini] 屏幕共享快照读取失败：", e); }
  };
  syncScreen();

  const speech = createSpeechBubble(() => {
    const wrap = chat.closest<HTMLElement>(".mini-wrap");
    wrap?.classList.remove("chat-off");
    window.dispatchEvent(new Event("pet:bubble"));
    requestAnimationFrame(() => input.focus());
  });
  const bubble = speech.element;
  bus.on("pet:bubble", (e: any) => {
    const expanded = !chat.closest(".mini-wrap")?.classList.contains("chat-off");
    if (!expanded || e?.kind === "initiative") {
      console.log("[bubble:mini] show", e?.kind || "pet", String(e?.text || "").slice(0, 80));
      speech.show(e?.text, e?.kind);
    }
  });
  // 人格/外观变化即时同步
  const sync = () => {
    const n = identity.name;
    nameEl.textContent = n;
    const im = slot.querySelector("img");
    if (im) im.alt = n;
    input.placeholder = `和${n}说…`;
  };
  bus.on("personas:changed", sync);
  bus.on("appearance:changed", sync);

  // chat-off：对话框默认隐藏，点击角色才浮现（由桌面壳的点击逻辑切换）
  const wrap = h("div", { class: "mini-wrap chat-off" }, [bubble, stage, chat, screen.element]);
  const openChat = button('聊一会儿', 'mini-menu-chat', () => {
    wrap.classList.remove('chat-off');
    setMenu(false);
    requestAnimationFrame(() => input.focus());
  });
  const menu = h('div', { class: 'mini-menu', id: 'mini-character-menu', role: 'dialog', 'aria-label': '立绘选项' }, [
    h('div', { class: 'mini-menu-title' }, '陪在身边'), viewSwitch.element, openChat,
    screenControls, tools,
  ]);
  menu.hidden = true;
  const menuButton = button('···', 'mini-menu-button', () => setMenu(menu.hidden));
  menuButton.setAttribute('aria-label', '立绘选项');
  menuButton.setAttribute('aria-haspopup', 'dialog');
  menuButton.setAttribute('aria-controls', menu.id);
  menuButton.setAttribute('aria-expanded', 'false');
  function setMenu(open: boolean) {
    menu.hidden = !open;
    menuButton.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector<HTMLButtonElement>('button')?.focus();
    notifyScreenLayout();
  }
  for (const el of [menu, menuButton]) {
    for (const event of ['mousedown','mouseup','pointerdown','click']) el.addEventListener(event, e => e.stopPropagation());
  }
  stage.append(menuButton, menu);
  document.addEventListener('pointerdown', e => {
    if (!menu.hidden && !menu.contains(e.target as Node) && !menuButton.contains(e.target as Node)) setMenu(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !menu.hidden) { setMenu(false); menuButton.focus(); }
    if (e.key === 'Tab' && !menu.hidden) {
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')).filter(b => b.getClientRects().length);
      const first = items[0], last = items[items.length-1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  });
  new MutationObserver(() => {
    if (!wrap.classList.contains("chat-off")) syncScreen();
    notifyScreenLayout();
  }).observe(wrap, { attributes: true, attributeFilter: ["class"] });
  return wrap;
}
