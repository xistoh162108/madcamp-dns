import { Hono } from "hono";
import { prisma } from "../db/prisma.js";
import { requireAdmin } from "../lib/auth.js";
import { deleteDnsRecord } from "../lib/cloudflare.js";
import { auditSafe, getClientIp, getUserAgent } from "../lib/audit.js";
import { checkAdminRateLimit } from "../lib/rate-limit.js";
import { notFound } from "../lib/errors.js";

const app = new Hono();

app.use("*", async (c, next) => {
  await requireAdmin(c);
  const ip = getClientIp(c);
  await checkAdminRateLimit(ip);
  await next();
});

// --- GET /admin/records ---
app.get("/", async (c) => {
  const page  = Math.max(1, parseInt(c.req.query("page")  ?? "1",  10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10) || 1));
  const studentId = c.req.query("studentId");

  const where = studentId ? { studentId } : {};

  const [total, records] = await Promise.all([
    prisma.dnsRecord.count({ where }),
    prisma.dnsRecord.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: { student: { select: { email: true, subdomain: true } } },
    }),
  ]);

  const data = records.map((r) => ({
    id: r.id,
    studentId: r.studentId,
    studentEmail: r.student.email,
    subdomain: r.student.subdomain,
    relativeName: r.relativeName,
    fqdn: r.fqdn,
    type: r.type,
    content: r.content,
    ttl: r.ttl,
    proxied: r.proxied,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    // Admin gets cloudflareRecordId for debugging
    cloudflareRecordId: r.cloudflareRecordId,
  }));

  return c.json({ records: data, total, page, limit });
});

// --- DELETE /admin/records/:id ---
app.delete("/:id", async (c) => {
  const record = await prisma.dnsRecord.findUnique({
    where: { id: c.req.param("id") },
  });
  if (!record) throw notFound("DNS record");

  await deleteDnsRecord(record.cloudflareRecordId);

  await prisma.dnsRecord.delete({ where: { id: record.id } });

  auditSafe({
    actorType: "ADMIN",
    studentId: record.studentId,
    action: "ADMIN_RECORD_DELETED",
    recordId: record.id,
    beforeJson: {
      fqdn: record.fqdn,
      type: record.type,
      content: record.content,
    },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ success: true });
});

export default app;
