import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import type { Server as HttpServer } from "http";
import { AppError, toErrorResponse, internalError } from "./lib/errors.js";
import { cleanupExpiredRateLimits, checkPreAuthRateLimit } from "./lib/rate-limit.js";
import { getClientIp } from "./lib/audit.js";
import { prisma } from "./db/prisma.js";

// Routes
import adminStudentsRouter from "./routes/admin.students.js";
import adminTestKeysRouter from "./routes/admin.test-keys.js";
import adminRecordsRouter from "./routes/admin.records.js";
import adminAuditRouter from "./routes/admin.audit.js";
import studentMeRouter from "./routes/student.me.js";
import studentRecordsRouter from "./routes/student.records.js";
import studentSubdomainsRouter from "./routes/student.subdomains.js";

// ── Startup: validate required env vars ──────────────────────────────────────
const REQUIRED_ENV = [
  "DATABASE_URL",
  "ROOT_DOMAIN",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_API_TOKEN",
  "ADMIN_API_KEY",
] as const;

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[fatal] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const port = parseInt(process.env.PORT ?? "3000", 10);
if (isNaN(port) || port < 1 || port > 65535) {
  console.error(`[fatal] PORT must be a valid port number 1-65535, got: ${process.env.PORT}`);
  process.exit(1);
}

// ── Process-level safety nets ────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] Unhandled rejection:", reason);
  process.exit(1);
});

// ── App ──────────────────────────────────────────────────────────────────────
const app = new Hono();

// Max body size: 64 KB is more than enough for any valid API request.
// Content-Length check is a fast gate — chunked TE attacks still reach Node but
// Hono will fail to parse an enormous body before route logic runs.
// The primary defence against body-size DoS is nginx client_max_body_size.
const MAX_BODY_BYTES = 64 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.use("*", async (c, next) => {
  // 1. Reject oversized bodies early (Content-Length check)
  const cl = c.req.header("content-length");
  if (cl !== undefined && cl !== null) {
    const bytes = parseInt(cl, 10);
    if (!isNaN(bytes) && bytes > MAX_BODY_BYTES) {
      return c.json(
        { error: { code: "INVALID_REQUEST", message: "Request body too large (max 64 KB)." } },
        413
      );
    }
  }

  // 2. Attach request ID
  const incoming = c.req.header("x-request-id");
  const requestId = incoming && UUID_RE.test(incoming) ? incoming : randomUUID();
  c.header("x-request-id", requestId);

  const t0 = Date.now();
  await next();
  const ms = Date.now() - t0;

  // Log every request. SLOW indicates >2s (usually a CF or DB timeout worth investigating).
  const level = ms > 2000 ? "SLOW" : "req ";
  console.log(`[${level}] ${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms rid=${requestId}`);

  // 3. Security + cache headers on all responses
  //    Applied after next() so they're set regardless of which handler ran.
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  // Authenticated API responses must never be cached by proxies or browsers
  c.header("Cache-Control", "no-store");
});

// ── Error handler ────────────────────────────────────────────────────────────
app.onError((err, c) => {
  if (err instanceof AppError) {
    if (err.code === "RATE_LIMITED" && typeof err.details?.retryAfterSeconds === "number") {
      c.header("Retry-After", String(err.details.retryAfterSeconds));
    }
    return c.json(
      toErrorResponse(err),
      err.statusCode as 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503
    );
  }
  console.error("[unhandled error]", err);
  return c.json(toErrorResponse(internalError()), 500);
});

// ── 404 ──────────────────────────────────────────────────────────────────────
app.notFound((c) =>
  c.json(
    { error: { code: "NOT_FOUND", message: "The requested endpoint does not exist." } },
    404
  )
);

// ── Health ───────────────────────────────────────────────────────────────────
// Simple in-memory health cache: check DB at most once per 5 seconds.
// Prevents health endpoint from generating a DB query storm under monitoring load.
let healthCache: { ok: boolean; checkedAt: number } | null = null;
const HEALTH_CACHE_TTL_MS = 5_000;

app.get("/health", async (c) => {
  const now = Date.now();
  if (healthCache && now - healthCache.checkedAt < HEALTH_CACHE_TTL_MS) {
    return healthCache.ok
      ? c.json({ status: "ok", timestamp: new Date().toISOString(), cached: true })
      : c.json({ status: "error", message: "Database unavailable.", cached: true }, 503);
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    healthCache = { ok: true, checkedAt: now };
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch {
    healthCache = { ok: false, checkedAt: now };
    return c.json({ status: "error", message: "Database unavailable." }, 503);
  }
});

// ── Admin routes ─────────────────────────────────────────────────────────────
app.route("/admin/students", adminStudentsRouter);
app.route("/admin/test-keys", adminTestKeysRouter);
app.route("/admin/records", adminRecordsRouter);
app.route("/admin/audit-logs", adminAuditRouter);

// ── Student routes ───────────────────────────────────────────────────────────
// Coarse IP-keyed rate limit BEFORE any credential is checked — requireStudent()
// does a DB lookup per request, so this is what actually caps DB-hammering from
// invalid-token spam (per-key limits in checkStudentRateLimit only kick in once
// a *valid* key is resolved). See checkPreAuthRateLimit's doc comment.
app.use("/v1/*", async (c, next) => {
  await checkPreAuthRateLimit(getClientIp(c));
  await next();
});

app.route("/v1/me", studentMeRouter);
app.route("/v1/records", studentRecordsRouter);
app.route("/v1/subdomains", studentSubdomainsRouter);

// ── Background: prune expired rate-limit rows every 5 minutes ────────────────
setInterval(() => {
  cleanupExpiredRateLimits().catch((e) => console.error("[rate-limit cleanup]", e));
}, 5 * 60 * 1000);

// ── Server ───────────────────────────────────────────────────────────────────
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[dns-api] Listening on http://0.0.0.0:${info.port}`);
  console.log(`[dns-api] ROOT_DOMAIN=${process.env.ROOT_DOMAIN}`);
  console.log(`[dns-api] NODE_ENV=${process.env.NODE_ENV ?? "development"}`);
}) as unknown as HttpServer;

// Slow-loris and hung-connection protection:
//   headersTimeout — max time to receive complete request headers (default: 60s in Node 18+)
//   requestTimeout — max time from request start to response completion
//   keepAliveTimeout — time an idle keep-alive connection stays open
// Node.js requires: headersTimeout > keepAliveTimeout
server.headersTimeout  = 15_000;  // 15s to send headers
server.requestTimeout  = 60_000;  // 60s max per request (Cloudflare calls ~50-200ms normally)
server.keepAliveTimeout = 5_000;  // 5s idle keep-alive

// ── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  console.log(`[dns-api] ${signal} received, shutting down...`);
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
