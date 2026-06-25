import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { requireAdmin } from "../lib/auth.js";
import { checkAdminRateLimit } from "../lib/rate-limit.js";
import { getClientIp } from "../lib/audit.js";
import { invalidRequest } from "../lib/errors.js";

const app = new Hono();

app.use("*", async (c, next) => {
  await requireAdmin(c);
  const ip = getClientIp(c);
  await checkAdminRateLimit(ip);
  await next();
});

// --- GET /admin/audit-logs ---
// Query params: studentId, action, after (ISO date), before (ISO date), page, limit
app.get("/", async (c) => {
  const page  = Math.max(1, parseInt(c.req.query("page")  ?? "1",  10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10) || 1));

  const studentId = c.req.query("studentId");
  const action    = c.req.query("action");
  const afterStr  = c.req.query("after");
  const beforeStr = c.req.query("before");

  // Parse and validate date filters
  let afterDate: Date | undefined;
  let beforeDate: Date | undefined;
  if (afterStr) {
    afterDate = new Date(afterStr);
    if (isNaN(afterDate.getTime())) throw invalidRequest("Invalid 'after' date.");
  }
  if (beforeStr) {
    beforeDate = new Date(beforeStr);
    if (isNaN(beforeDate.getTime())) throw invalidRequest("Invalid 'before' date.");
  }

  const where: Prisma.AuditLogWhereInput = {};
  if (studentId) where.studentId = studentId;
  if (action)    where.action    = action;
  if (afterDate || beforeDate) {
    where.createdAt = {
      ...(afterDate  ? { gte: afterDate  } : {}),
      ...(beforeDate ? { lte: beforeDate } : {}),
    };
  }

  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return c.json({ logs, total, page, limit });
});

export default app;
