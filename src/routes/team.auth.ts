import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { requireStudent } from "../lib/auth.js";
import { generateApiKey } from "../lib/api-key.js";
import { hashPassword, verifyPassword, getDummyHash } from "../lib/password.js";
import { checkLoginRateLimit, assertAccountNotLocked, recordFailedLogin, checkStudentRateLimit } from "../lib/rate-limit.js";
import { auditSafe, getClientIp, getUserAgent } from "../lib/audit.js";
import { invalidRequest, unauthorized, studentDisabled, forbidden } from "../lib/errors.js";

// Web UI login for any Student (team or individual). Login ID is the
// subdomain or the email. A successful login mints a short-lived ApiKey
// (label "web-session") that the browser uses against the normal /v1/*
// routes, so ownership checks, quotas and per-key rate limits stay in one
// place and plain API-key users are unaffected.

export const WEB_SESSION_LABEL = "web-session";
const SESSION_HOURS = 12;

const app = new Hono();

const LoginSchema = z.object({
  id: z.string().min(1).max(254),
  password: z.string().min(1).max(256),
});

app.post("/login", async (c) => {
  const ip = getClientIp(c);
  await checkLoginRateLimit(ip);

  const body = await c.req.json().catch(() => null);
  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) throw invalidRequest("ID and password are required.");

  const id = parsed.data.id.trim().toLowerCase();
  await assertAccountNotLocked(id);

  const student = await (id.includes("@") ? prisma.student.findUnique({ where: { email: id } }) : prisma.student.findUnique({ where: { subdomain: id } }));

  // Always run one scrypt so unknown IDs and wrong passwords take the same time.
  const ok = await verifyPassword(parsed.data.password, student?.passwordHash ?? (await getDummyHash()));
  if (!student || !student.passwordHash || !ok) {
    await recordFailedLogin(id);
    auditSafe({
      actorType: "TEAM",
      studentId: student?.id,
      action: "TEAM_LOGIN_FAILED",
      afterJson: { id },
      ip,
      userAgent: getUserAgent(c),
    });
    throw unauthorized("ID 또는 비밀번호가 올바르지 않습니다.");
  }
  if (!student.isActive) throw studentDisabled();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3600_000);
  const { raw, hash, keyPrefix } = generateApiKey("sk_web");

  await prisma.$transaction([
    prisma.apiKey.deleteMany({
      where: { studentId: student.id, label: WEB_SESSION_LABEL, expiresAt: { lte: now } },
    }),
    prisma.apiKey.create({
      data: { studentId: student.id, keyHash: hash, keyPrefix, label: WEB_SESSION_LABEL, expiresAt },
    }),
  ]);

  auditSafe({ actorType: "TEAM", actorId: student.id, studentId: student.id, action: "TEAM_LOGIN", ip, userAgent: getUserAgent(c) });

  return c.json({ token: raw, expiresAt });
});

app.post("/logout", async (c) => {
  const auth = await requireStudent(c);
  // Only end web sessions here, never a long-lived API key.
  if (auth.apiKey.label === WEB_SESSION_LABEL) {
    await prisma.apiKey.update({
      where: { id: auth.apiKey.id },
      data: { isActive: false, revokedAt: new Date() },
    });
  }
  return c.json({ success: true });
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(10, "New password must be at least 10 characters.").max(256),
});

// Change own password. Requires a web session and the current password;
// signs out every other web session of this account.
app.post("/password", async (c) => {
  const auth = await requireStudent(c);
  if (auth.apiKey.label !== WEB_SESSION_LABEL) throw forbidden("Use the web UI to change the password.");
  await checkStudentRateLimit(auth.apiKey.keyHash, "POST");

  const body = await c.req.json().catch(() => null);
  const parsed = ChangePasswordSchema.safeParse(body);
  if (!parsed.success) throw invalidRequest("Invalid request body.", parsed.error.flatten());

  const { currentPassword, newPassword } = parsed.data;
  if (!auth.student.passwordHash || !(await verifyPassword(currentPassword, auth.student.passwordHash))) {
    throw invalidRequest("현재 비밀번호가 맞지 않습니다.");
  }
  if (newPassword === currentPassword) throw invalidRequest("새 비밀번호가 기존과 같습니다.");

  await prisma.$transaction([
    prisma.student.update({ where: { id: auth.student.id }, data: { passwordHash: await hashPassword(newPassword) } }),
    prisma.apiKey.updateMany({
      where: { studentId: auth.student.id, label: WEB_SESSION_LABEL, isActive: true, NOT: { id: auth.apiKey.id } },
      data: { isActive: false, revokedAt: new Date() },
    }),
  ]);

  auditSafe({
    actorType: "TEAM",
    actorId: auth.student.id,
    studentId: auth.student.id,
    action: "TEAM_PASSWORD_CHANGED",
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ success: true });
});

export default app;
