/**
 * ompet 桌面端 dev 服务器（bun run dev）：
 * tauri devUrl 为 http://localhost:1420，这里提供该端口的静态服务，
 * 同时保持前端 watch 构建（cp 静态资源 + bun build --watch）。
 *
 * 修复背景：旧 dev 脚本只构建静态文件不起 HTTP 服务器，dev 模式下
 * WebView2 必然出现 "localhost 拒绝连接" 错误页。
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = import.meta.dir; // desktop/
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");
// 默认 1420（tauri devUrl）；被占用时可用 PORT 环境变量换端口调试
const PORT = Number(process.env.PORT) || 1420;

// 1. 初始构建：复制静态资源 + bundle main.ts（--watch 持续重建）
cpSync(path.join(SRC, "index.html"), path.join(DIST, "index.html"));
cpSync(path.join(SRC, "styles.css"), path.join(DIST, "styles.css"));
const watch = spawn(
  "bun",
  ["build", path.join(SRC, "main.ts"), "--outdir", DIST, "--watch"],
  { stdio: "inherit" },
);

// 2. 静态服务器（仅服务 dist，路径逃逸拒绝）
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".webp": "image/webp",
  ".png": "image/png",
};

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const rel = url.pathname === "/" ? "index.html" : url.pathname;
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response("forbidden", { status: 403 });
    if (!existsSync(file)) return new Response("not found", { status: 404 });
    return new Response(readFileSync(file), {
      headers: { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" },
    });
  },
});
console.log(`[ompet] dev server: http://localhost:${PORT}/（dist watch 构建中）`);

process.on("SIGINT", () => {
  watch.kill();
  process.exit(0);
});
