// 生成"启动器 + 外置资源"发行目录：
//   release/
//   ├── 陪伴桌宠.exe    ← 启动器（只负责开本地服务/建窗口/托盘）
//   └── app/           ← 全部可编辑：界面、角色卡、Live2D 模型、外置插件
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();

// Windows 会把"从网络/聊天工具下载来的文件"打上 Zone.Identifier 备用数据流，
// 双击时 Explorer 就会弹"打开文件 - 安全警告 / 无法验证发布者"。
// 这里在复制完成后把该流删掉，避免每次构建产物都带锁。
function stripMotw(file) {
  if (process.platform !== "win32") return;
  try {
    fs.unlinkSync(`${file}:Zone.Identifier`);
    console.log(`√ 已清除 MOTW：${path.basename(file)}`);
  } catch {
    // 没有该流就是干净文件，忽略
  }
}

const distDir = path.join(root, "dist");
const exeSrc = path.join(root, "src-tauri", "target", "release", "desktop-pet.exe");
const outDir = path.join(root, "release");
const appDir = path.join(outDir, "app");

if (!fs.existsSync(path.join(distDir, "index.html"))) {
  console.error("× 缺少 dist/index.html，请先执行 npm run build");
  process.exit(1);
}
if (!fs.existsSync(exeSrc)) {
  console.error("× 缺少 src-tauri/target/release/pet.exe，请先执行 npm run tauri:build");
  process.exit(1);
}

// 只清掉"由构建产生"的部分（index.html + assets/），
// 其它目录（live2d/ 里用户放进去的模型、core、plugins/、assets/character/ 的改动）保留合并，
// 避免每次重建都把用户自己放进去的东西删掉。
fs.mkdirSync(appDir, { recursive: true });
fs.rmSync(path.join(appDir, "assets"), { recursive: true, force: true });
fs.rmSync(path.join(appDir, "index.html"), { force: true });
fs.rmSync(path.join(appDir, "live2d", "README.md"), { force: true });
fs.rmSync(path.join(appDir, "plugins", "README.md"), { force: true });
fs.cpSync(distDir, appDir, { recursive: true, force: true });

// 保证这些"可编辑目录"一定存在（哪怕暂时是空的）
for (const d of ["assets/character", "live2d", "live2d/core", "plugins"]) {
  fs.mkdirSync(path.join(appDir, d), { recursive: true });
}

const exeDest = path.join(outDir, "陪伴桌宠.exe");
// 名字永远不变：exe 被占用时宁可报错重来，也不另存成"陪伴桌宠-new.exe"。
// （以前那样做，快捷方式指向的文件名会变，每次都得重新建一次快捷方式。）
try {
  fs.copyFileSync(exeSrc, exeDest);
} catch (e) {
  if (e && e.code === "EBUSY") {
    console.error("× 陪伴桌宠.exe 正在运行，关掉桌宠（托盘→退出）后再执行 npm run dist");
    process.exit(1);
  }
  throw e;
}

const finalExe = exeDest;

// 复制会连备用数据流一起带过来，所以复制完必须清一次
stripMotw(exeDest);

// A low mandatory label inherited from build/release directories silently
// downgrades a normally launched desktop process. Repair only the final exe.
// Never claim success if the build environment cannot restore its label.
if (process.platform === "win32") {
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const repair = path.join(root, "scripts", "repair-integrity.ps1");
  const result = spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", repair], {
    stdio: "inherit", windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    console.error("× exe 完整性检查/恢复失败，不能把此分发视为可用版本。");
    console.error(`  请在普通 Windows PowerShell 执行：powershell -NoProfile -ExecutionPolicy Bypass -File "${repair}"`);
    if (result.error) console.error(result.error.message);
    process.exit(1);
  }
}

const size = (fs.statSync(finalExe).size / 1024 / 1024).toFixed(1);
console.log(`√ 启动器：release/${path.basename(finalExe)}（${size} MB）`);
console.log("√ 可编辑资源目录：release/app/");
console.log("  ├─ assets/character/   ← 角色卡 character.json + 立绘 avatar.png");
console.log("  ├─ live2d/             ← model3.json + 贴图 + core/live2dcubismcore.min.js");
console.log("  └─ plugins/            ← plugins.json + 各插件文件夹（改完重启即生效）");
