import { h, button } from "./dom";

/** Original upload, never canvas-compressed or replaced with an AI summary. */
export function createImageInput(input: HTMLInputElement, dropTarget: HTMLElement, report: (message: string) => void) {
  const filePick = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", class: "file-pick" }) as HTMLInputElement;
  const preview = h("div", { class: "img-preview", hidden: "", role: "button", tabindex: "0", "aria-label": "移除待发送的图片" });
  const attachBtn = button("图", "btn icon-btn", () => filePick.click());
  attachBtn.title = "发送原图给她看（也支持粘贴、拖放）";
  let image = "", version = 0, reading = false;
  const clear = () => { version++; image = ""; reading = false; attachBtn.textContent = "图"; preview.hidden = true; preview.style.backgroundImage = ""; attachBtn.classList.remove("armed"); };
  const readFile = (file: File) => {
    if (!/^(image\/(png|jpeg|webp|gif))$/.test(file.type)) { report("（支持PNG、JPEG、WebP或GIF图片，请换一种格式。）"); return; }
    if (file.size > 8 * 1024 * 1024) { report("（这张图片超过8MB，请换一张较小的。）"); return; }
    clear();
    const request = version;
    reading = true; attachBtn.textContent = "…";
    const reader = new FileReader();
    reader.onload = () => {
      if (request !== version) return;
      reading = false; attachBtn.textContent = "图";
      image = String(reader.result || "");
      preview.style.backgroundImage = `url(${image})`; preview.hidden = false; attachBtn.classList.add("armed"); input.focus();
    };
    reader.onerror = () => { if (request === version) { clear(); report("（图片读取失败，请重新选择。）"); } };
    reader.readAsDataURL(file);
  };
  filePick.addEventListener("change", () => { const f = filePick.files?.[0]; if (f) readFile(f); filePick.value = ""; });
  preview.title = "点一下撤掉这张图";
  preview.addEventListener("click", clear);
  preview.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); clear(); } });
  input.addEventListener("paste", e => {
    const f = Array.from(e.clipboardData?.items || []).find(item => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile();
    if (f) { e.preventDefault(); readFile(f); }
  });
  dropTarget.addEventListener("dragover", e => e.preventDefault());
  dropTarget.addEventListener("drop", e => { const f = e.dataTransfer?.files?.[0]; if (f?.type.startsWith("image/")) { e.preventDefault(); readFile(f); } });
  return { filePick, preview, attachBtn, clear, current: () => image, isReading: () => reading };
}
