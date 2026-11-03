import { Hono } from "hono";
import { readFileSync, readdirSync } from "fs";

// Static web UI: "/" for students/teams, "/console" for admins, "/guide" for
// the participant guide. The two app pages are desktop only: mobile user
// agents get a short notice instead (the pages themselves also refuse to run
// on touch-only devices). The guide is plain reading material and stays
// readable on phones.
const PUBLIC_DIR = new URL("../../public/", import.meta.url);

type StaticFile = { file: string; type: string; mobile?: boolean; maxAge?: number };

const FILES: Record<string, StaticFile> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/console": { file: "console.html", type: "text/html; charset=utf-8" },
  "/ui/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/ui/common.js": { file: "common.js", type: "text/javascript; charset=utf-8" },
  "/ui/team.js": { file: "team.js", type: "text/javascript; charset=utf-8" },
  "/ui/console.js": { file: "console.js", type: "text/javascript; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
  "/favicon-32.png": { file: "favicon-32.png", type: "image/png" },
  "/favicon.ico": { file: "favicon-32.png", type: "image/png" },
  "/apple-touch-icon.png": { file: "apple-touch-icon.png", type: "image/png" },
  "/guide": { file: "guide.html", type: "text/html; charset=utf-8", mobile: true },
  "/ui/guide.css": { file: "guide.css", type: "text/css; charset=utf-8" },
  "/ui/guide.js": { file: "guide.js", type: "text/javascript; charset=utf-8" },
};

// Guide screenshots: public/guide/*.png, served under /ui/guide/. They only
// change with a redeploy, so browsers may keep them for a day.
for (const name of readdirSync(new URL("guide/", PUBLIC_DIR))) {
  if (/^[a-z0-9-]+\.png$/.test(name)) {
    FILES[`/ui/guide/${name}`] = { file: `guide/${name}`, type: "image/png", maxAge: 86400 };
  }
}

const CACHE = new Map(
  Object.entries(FILES).map(([path, f]) => {
    const raw = readFileSync(new URL(f.file, PUBLIC_DIR));
    const body = f.type.startsWith("image/png") ? new Uint8Array(raw) : raw.toString("utf8");
    return [path, { body, type: f.type, mobile: !!f.mobile, maxAge: f.maxAge }];
  })
);

const MOBILE_PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>PC에서 접속해 주세요</title>
<link rel="stylesheet" href="/ui/style.css"><link rel="icon" href="/favicon.svg" type="image/svg+xml"></head>
<body><h1>PC에서 접속해 주세요</h1><p>이 페이지는 모바일 기기를 지원하지 않습니다.</p>
<p><a href="/guide">사용 가이드</a>는 휴대폰에서도 볼 수 있습니다.</p></body></html>`;

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
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join("; ");

const app = new Hono();

for (const [path, { body, type, mobile, maxAge }] of CACHE) {
  app.get(path, (c) => {
    let out = body;
    if (typeof out === "string" && !mobile && type.startsWith("text/html") && MOBILE_UA.test(c.req.header("user-agent") ?? "")) out = MOBILE_PAGE;
    c.header("Content-Type", type);
    c.header("Content-Security-Policy", CSP);
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    c.header("Vary", "User-Agent");
    if (maxAge) c.header("Cache-Control", `public, max-age=${maxAge}`);
    if (process.env.NODE_ENV === "production") {
      c.header("Strict-Transport-Security", "max-age=31536000");
    }
    return c.body(out);
  });
}

app.get("/guide/", (c) => c.redirect("/guide", 301));

export default app;
