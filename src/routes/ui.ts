import { Hono } from "hono";
import { readFileSync } from "fs";

// Static web UI: "/" for students/teams, "/console" for admins.
// Desktop only: mobile user agents get a short notice instead of the page
// (the page itself also refuses to run on touch-only devices).
const PUBLIC_DIR = new URL("../../public/", import.meta.url);

const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/console": { file: "console.html", type: "text/html; charset=utf-8" },
  "/ui/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/ui/common.js": { file: "common.js", type: "text/javascript; charset=utf-8" },
  "/ui/team.js": { file: "team.js", type: "text/javascript; charset=utf-8" },
  "/ui/console.js": { file: "console.js", type: "text/javascript; charset=utf-8" },
};

const CACHE = new Map(
  Object.entries(FILES).map(([path, f]) => [path, { body: readFileSync(new URL(f.file, PUBLIC_DIR), "utf8"), type: f.type }])
);

const MOBILE_PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>PC에서 접속해 주세요</title>
<link rel="stylesheet" href="/ui/style.css"><link rel="icon" href="data:,"></head>
<body><h1>PC에서 접속해 주세요</h1><p>이 페이지는 모바일 기기를 지원하지 않습니다.</p></body></html>`;

const MOBILE_UA = /Mobi|Android|iPhone|iPad|iPod|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile/i;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const app = new Hono();

for (const [path, { body, type }] of CACHE) {
  app.get(path, (c) => {
    let out = body;
    if (type.startsWith("text/html") && MOBILE_UA.test(c.req.header("user-agent") ?? "")) out = MOBILE_PAGE;
    c.header("Content-Type", type);
    c.header("Content-Security-Policy", CSP);
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    c.header("Vary", "User-Agent");
    if (process.env.NODE_ENV === "production") {
      c.header("Strict-Transport-Security", "max-age=31536000");
    }
    return c.body(out);
  });
}

export default app;
