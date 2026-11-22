// 检查 PSD 分层结构（只看元数据，不解码像素，快）
// 用法: node scripts/inspect-psd.mjs <file.psd>
import fs from "node:fs";
import path from "node:path";
import { readPsd } from "ag-psd";

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("用法: node scripts/inspect-psd.mjs <file.psd>");
  process.exit(1);
}

const psd = readPsd(fs.readFileSync(file), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
console.log(`文件: ${path.basename(file)}  ${psd.width}x${psd.height}  通道=${psd.channels}  位深=${psd.bitsPerChannel}`);

let total = 0;
const lines = [];
function walk(nodes, depth) {
  for (const n of nodes ?? []) {
    const isGroup = Array.isArray(n.children) && n.children.length > 0;
    const pad = "  ".repeat(depth) + (isGroup ? "📁 " : "• ");
    const pos = `@(${n.left ?? 0},${n.top ?? 0}) ${(n.right ?? 0) - (n.left ?? 0)}x${(n.bottom ?? 0) - (n.top ?? 0)}`;
    const flags = [n.hidden ? "隐藏" : "", n.opacity != null && n.opacity < 1 ? `不透明度${Math.round(n.opacity * 100)}%` : ""]
      .filter(Boolean)
      .join(" ");
    lines.push(`${pad}${n.name || "(未命名)"}  ${pos}${flags ? "  [" + flags + "]" : ""}`);
    if (!isGroup) total++;
    if (isGroup) walk(n.children, depth + 1);
  }
}
walk(psd.children, 0);
console.log(`图层总数(不含组): ${total}\n---- 结构 ----`);
console.log(lines.join("\n"));
