import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * 开发期把 /live2d/* 直接映射到外置资源目录 release/app/live2d/。
 *
 * 为什么模型不放在 public/：public/ 会被打进 dist/，而 Tauri 会把 dist/ 整个嵌进 exe，
 * 结果 7MB 模型 + 官方 Core 都被塞进二进制（exe 从 15.4MB 涨到 27.5MB），
 * 违背"exe 只当启动器、资源放外面"的设计。所以模型只存外置目录，
 * dev 模式用这个中间件读同一份文件，保证只有一份真相。
 */
function externalLive2d(): Plugin {
  const extDir = path.resolve(import.meta.dirname, "release/app/live2d");
  const MIME: Record<string, string> = {
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".moc3": "application/octet-stream",
  };
  return {
    name: "external-live2d",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || "").split("?")[0];
        if (!url.startsWith("/live2d/")) return next();
        const file = path.resolve(extDir, "." + url.slice("/live2d".length));
        if (!file.startsWith(extDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          return next();
        }
        res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
        res.setHeader("Access-Control-Allow-Origin", "*");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [externalLive2d()],
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // 忽略隐藏文件/编辑临时目录/缓存/桌面壳产物，避免文件监听被占锁搞崩
      ignored: ["**/.*", "**/*.tmpdir/**", "**/.npm-cache/**", "**/.cargo-home/**", "**/dist/**", "**/src-tauri/**", "**/release/**"],
    },
    proxy: {
      // 开发期 CORS 兜底：请求 /dsai/* 会被转发到 DeepSeek（见 docs/教程/第08课）
      "/dsai": {
        target: "https://api.deepseek.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/dsai/, ""),
      },
    },
  },
  preview: {
    port: 5174,
    strictPort: true,
  },
});
