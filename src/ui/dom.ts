// 极简 DOM 工具（超轻、无框架）
export function h(tag: string, attrs?: Record<string, any>, ...children: any[]): HTMLElement {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === "class") {
        el.className = v;
      } else if (k === "style" && typeof v === "object") {
        Object.assign(el.style, v);
      } else if (k === "text") {
        el.textContent = v;
      } else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === "checked" || k === "disabled" || k === "value") {
        (el as any)[k] = v; // 属性赋值（checkbox/value 初值必须走 property）
      } else {
        el.setAttribute(k, typeof v === "string" ? v : String(v));
      }
    }
  }
  // 递归追加子节点，支持传单节点、字符串或（嵌套）数组
  const append = (nodes: any[]) => {
    for (const ch of nodes) {
      if (ch == null || ch === false) continue;
      if (Array.isArray(ch)) {
        append(ch);
      } else if (typeof ch === "string" || typeof ch === "number") {
        el.appendChild(document.createTextNode(String(ch)));
      } else if (ch instanceof Node) {
        el.appendChild(ch);
      } else if (ch && typeof ch === "object" && typeof ch.nodeType === "number") {
        el.appendChild(ch); // 跨 window 的 Node（如测试环境）
      }
    }
  };
  append(children);
  return el;
}

export const clear = (el: HTMLElement) => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

export function button(text: string, cls: string, onClick: () => void): HTMLElement {
  return h("button", { class: cls, onclick: onClick }, text);
}
