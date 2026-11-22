// 思维系统静态检查：用桌宠项目里的 tsc（思维系统本身不装任何依赖）
// 只报"真问题"——漏 import / 名字写错 / 类型对不上；
// Node 内置模块和全局变量由 types/node-shim.d.ts 兜成 any，
// 剩下关于 node: 内置模块本身的报错（TS2307/2580/2694/2749/1470）统一当作噪音过滤掉。
//
// 用法：node tools/check.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tsc = [
  process.env.TSC,
  path.resolve(root, "../pet/node_modules/.bin/tsc.cmd"),
  path.resolve(root, "../pet/node_modules/typescript/bin/tsc"),
].filter(Boolean).find((p) => p && fs.existsSync(p));

if (!tsc) {
  console.error("找不到 tsc。桌宠项目（../pet/node_modules）在的话就能用。");
  process.exit(2);
}

const args = [
  "--noEmit",
  "--skipLibCheck",
  "--strict",
  "false",
  "--module",
  "preserve",
  "--moduleResolution",
  "bundler",
  "--target",
  "es2023",
  "--allowImportingTsExtensions",
  "types/node-shim.d.ts",
  "server/server.ts",
  "server/cli.ts",
];

// 用 shell 重定向把输出落到文件（避免子进程管道；沙箱下管道会被拒）
const tmp = path.join(root, ".check-out.txt");
const cmd = `"${tsc}" ${args.map((a) => `"${a}"`).join(" ")} > "${tmp}" 2>&1`;
spawnSync(cmd, { cwd: root, shell: true, stdio: "inherit" });
const raw = fs.existsSync(tmp) ? fs.readFileSync(tmp, "utf8") : "";
try {
  fs.rmSync(tmp);
} catch {}

const NOISE = [
  /error TS2307: Cannot find module 'node:/, // Node 内置模块类型
  /error TS2580:/, // process / Buffer 这类全局
  /error TS2694: Namespace '"node:\*"'/, // http.IncomingMessage 当类型用
  /error TS2749: 'Buffer'/,
  /error TS1470:/, // import.meta 在 CJS 下的告警
];
const errors = raw
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /error TS\d+/.test(l))
  .filter((l) => !NOISE.some((r) => r.test(l)));

if (!errors.length) {
  console.log("=== 静态检查通过：没有漏 import / 名字写错这类问题 ===");
  process.exit(0);
}
console.log("=== 发现真问题 ===");
for (const e of errors) console.log("  " + e);
process.exit(1);
