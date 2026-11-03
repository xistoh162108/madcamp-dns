import { Hono } from "hono";
import { prisma } from "../db/prisma.js";
import { requireStudent, isWebSession, WEB_SESSION_LABEL, type StudentContext } from "../lib/auth.js";
import { checkStudentRateLimit } from "../lib/rate-limit.js";
import { generateApiKey } from "../lib/api-key.js";
import { auditSafe, getClientIp, getUserAgent } from "../lib/audit.js";
import { forbidden } from "../lib/errors.js";

const app = new Hono<{ Variables: { auth: StudentContext } }>();

// --- Middleware: auth + rate limit ---
app.use("*", async (c, next) => {
  const auth = await requireStudent(c);
  await checkStudentRateLimit(auth.apiKey.keyHash, c.req.method, isWebSession(auth.apiKey));
  c.set("auth", auth);
  await next();
});

// --- GET /v1/me ---
app.get("/", async (c) => {
  const { student } = c.get("auth");
  const rootDomain = process.env.ROOT_DOMAIN!;

  return c.json({
    student: {
      email: student.email,
      name: student.name,
      subdomain: `${student.subdomain}.${rootDomain}`,
      recordLimit: student.recordLimit,
      isActive: student.isActive,
    },
  });
});

// --- GET /v1/me/api-keys ---
// The account's long-lived API keys (web-login sessions are left out).
// Only metadata: keys are stored hashed, so the full value is never shown again.
app.get("/api-keys", async (c) => {
  const { student } = c.get("auth");
  const keys = await prisma.apiKey.findMany({
    where: { studentId: student.id, NOT: { label: WEB_SESSION_LABEL } },
    orderBy: { createdAt: "desc" },
    select: { id: true, keyPrefix: true, label: true, isActive: true, lastUsedAt: true, createdAt: true, revokedAt: true },
  });
  return c.json({ apiKeys: keys });
});

// --- POST /v1/me/api-keys/rotate ---
// Self-service reissue from the web UI: revokes every active API key of this
// account and returns ONE new key, shown only in this response. Web sessions
// stay logged in. Refused for API-key callers, so a leaked key cannot be used
// to lock the team out by rotating itself.
app.post("/api-keys/rotate", async (c) => {
  const auth = c.get("auth");
  if (!isWebSession(auth.apiKey)) throw forbidden("Reissue the API key from the web UI.");

  const { raw, hash, keyPrefix } = generateApiKey();
  const now = new Date();
  const [revoked, created] = await prisma.$transaction([
    prisma.apiKey.updateMany({
      where: { studentId: auth.student.id, isActive: true, NOT: { label: WEB_SESSION_LABEL } },
      data: { isActive: false, revokedAt: now },
    }),
    prisma.apiKey.create({
      data: { studentId: auth.student.id, keyHash: hash, keyPrefix, label: "self-reissued" },
      select: { id: true, keyPrefix: true, label: true, createdAt: true },
    }),
  ]);

  auditSafe({
    actorType: "STUDENT",
    actorId: auth.student.id,
    studentId: auth.student.id,
    action: "API_KEY_ROTATED",
    afterJson: { by: "self", revoked: revoked.count, keyPrefix },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ apiKey: raw, key: created, revokedCount: revoked.count }, 201);
});

export default app;
