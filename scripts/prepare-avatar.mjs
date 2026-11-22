// 立绘处理脚本：WebP/任意格式 → PNG（可选：把纯色背景抠成透明 + 裁掉多余空白 + 限宽缩放）
// 用法：
//   node scripts/prepare-avatar.mjs <输入图> [--transparent] [--trim] [--max 900]
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const args = process.argv.slice(2);
const input = args[0];
const wantTransparent = args.includes("--transparent");
const wantTrim = args.includes("--trim");
const maxIdx = args.indexOf("--max");
const maxWidth = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : 0;

if (!input || !fs.existsSync(input)) {
  console.error("用法: node scripts/prepare-avatar.mjs <输入图> [--transparent] [--trim]");
  process.exit(1);
}

const targets = [
  path.join(process.cwd(), "release", "app", "assets", "character", "avatar.png"),
  path.join(process.cwd(), "public", "assets", "character", "avatar.png"),
];

const img = sharp(input, { animated: false });
const meta = await img.metadata();
console.log(`输入：${path.basename(input)}  ${meta.width}x${meta.height}  format=${meta.format}  hasAlpha=${meta.hasAlpha}`);

let pipeline = sharp(input, { animated: false }).ensureAlpha();
let { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;

// === 透明度统计 ===
let transparentPx = 0;
const total = width * height;
for (let i = 3; i < data.length; i += channels) if (data[i] < 250) transparentPx++;
const ratio = ((transparentPx / total) * 100).toFixed(2);
const corner = (x, y) => {
  const i = (y * width + x) * channels;
  return `rgba(${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]})`;
};
console.log(`已有半透明/透明像素：${ratio}%   左上角=${corner(2, 2)}  右下角=${corner(width - 3, height - 3)}`);

// === 可选：从四边洪水填充，去掉与边缘连通的近白背景（不误伤内部白色衣物）===
if (wantTransparent) {
  const isBg = (i) => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return min > 232 && max - min < 20; // 近白且低饱和
  };
  const visited = new Uint8Array(total);
  const stack = [];
  for (let x = 0; x < width; x++) {
    stack.push(x, 0, (height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    stack.push(0, y * width, width - 1 + y * width);
  }
  let removed = 0;
  while (stack.length) {
    const idx = stack.pop();
    if (visited[idx]) continue;
    visited[idx] = 1;
    const i = idx * channels;
    if (!isBg(i)) continue;
    data[i + 3] = 0;
    removed++;
    const x = idx % width, y = (idx - x) / width;
    if (x > 0) stack.push(idx - 1);
    if (x < width - 1) stack.push(idx + 1);
    if (y > 0) stack.push(idx - width);
    if (y < height - 1) stack.push(idx + width);
  }
  console.log(`抠背景：移除边缘连通的近白像素 ${(removed / total * 100).toFixed(1)}%`);
}

let out = sharp(data, { raw: { width, height, channels } });
if (maxWidth > 0 && width > maxWidth) {
  out = out.resize({ width: maxWidth, withoutEnlargement: true });
  console.log(`缩放：${width}px → ${maxWidth}px 宽`);
}
if (wantTrim) {
  out = out.trim({ threshold: 1 });
}
const buf = await out.png({ compressionLevel: 9 }).toBuffer();

for (const t of targets) {
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.writeFileSync(t, buf);
  console.log(`✔ 已写入 ${t.replace(process.cwd() + path.sep, "")}（${(buf.length / 1024).toFixed(0)} KB）`);
}
