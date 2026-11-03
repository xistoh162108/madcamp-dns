import { Hono } from "hono";
import { prisma } from "../db/prisma.js";
import { requireAdmin } from "../lib/auth.js";
import { deleteDnsRecord } from "../lib/cloudflare.js";
import { deleteTunnel, withTunnelLock, deleteTunnelHostnameEverywhere } from "../lib/cloudflare-tunnel.js";
import { auditSafe, getClientIp, getUserAgent } from "../lib/audit.js";
import { checkAdminRateLimit } from "../lib/rate-limit.js";
import { notFound, cloudflareError } from "../lib/errors.js";

const app = new Hono();

app.use("*", async (c, next) => {
  const ip = getClientIp(c);
  await checkAdminRateLimit(ip);
  await requireAdmin(c);
  await next();
});

// --- GET /admin/tunnels ---
// Supports ?studentActive=false to find tunnels belonging to deactivated
// students at camp-end, without a fully automated teardown job.
app.get("/", async (c) => {
  const page  = Math.max(1, parseInt(c.req.query("page")  ?? "1",  10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10) || 1));
  const studentActiveParam = c.req.query("studentActive");

  const where =
    studentActiveParam !== undefined
      ? { student: { isActive: studentActiveParam === "true" } }
      : {};

  const [total, tunnels] = await Promise.all([
    prisma.tunnel.count({ where }),
    prisma.tunnel.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        student: { select: { email: true, subdomain: true, isActive: true } },
        hostnames: { orderBy: { createdAt: "asc" } },
      },
    }),
  ]);

  const data = tunnels.map((t) => ({
    id: t.id,
    studentId: t.studentId,
    studentEmail: t.student.email,
    studentIsActive: t.student.isActive,
    name: t.name,
    cloudflareTunnelId: t.cloudflareTunnelId,
    hostnames: t.hostnames.map((h) => ({
      id: h.id,
      name: h.relativeName,
      fqdn: h.fqdn,
      localPort: h.localPort,
      protocol: h.protocol,
      cloudflareRecordId: h.cloudflareRecordId,
      createdAt: h.createdAt,
    })),
    createdAt: t.createdAt,
  }));

  return c.json({ tunnels: data, total, page, limit });
});

// --- DELETE /admin/tunnels/:id ---
// Force-delete a whole tunnel: capture CF ids first, DB-delete everything,
// then best-effort clean up Cloudflare, reporting outcome in the response.
app.delete("/:id", async (c) => {
  const tunnel = await prisma.tunnel.findUnique({
    where: { id: c.req.param("id") },
    include: { hostnames: true },
  });
  if (!tunnel) throw notFound("Tunnel");

  const hostnameSnapshot = tunnel.hostnames.map((h) => ({ id: h.id, cloudflareRecordId: h.cloudflareRecordId, fqdn: h.fqdn }));

  // Cloudflare first, then the DB. Every CNAME must be gone and the tunnel
  // deleted before the rows go; otherwise the DB would forget a tunnel that
  // still exists in Cloudflare, and the student's next "create tunnel" would
  // collide with the leftover tunnel name. Each step is idempotent, so on a
  // failure the admin just retries.
  await withTunnelLock(tunnel.id, async () => {
    const results = await Promise.allSettled(hostnameSnapshot.map((h) => deleteDnsRecord(h.cloudflareRecordId)));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) {
      throw cloudflareError(`Could not delete ${failed} of ${results.length} tunnel CNAME record(s) in Cloudflare. Nothing was removed from the database; try again.`);
    }
    await deleteTunnel(tunnel.cloudflareTunnelId);
    await prisma.$transaction([
      prisma.tunnelHostname.deleteMany({ where: { tunnelId: tunnel.id } }),
      prisma.tunnel.delete({ where: { id: tunnel.id } }),
    ]);
  });
  const dnsRecordsDeleted = hostnameSnapshot.length;
  const dnsRecordsFailed = 0;
  const tunnelDeleted = true;

  auditSafe({
    actorType: "ADMIN",
    studentId: tunnel.studentId,
    action: "TUNNEL_DELETED",
    recordId: tunnel.id,
    beforeJson: { name: tunnel.name, hostnameCount: hostnameSnapshot.length },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({
    success: true,
    cloudflareCleanup: { tunnelDeleted, dnsRecordsDeleted, dnsRecordsFailed },
  });
});

// --- DELETE /admin/tunnels/hostnames/:id ---
// Force-delete one hostname without touching the rest of the tunnel.
app.delete("/hostnames/:id", async (c) => {
  const hostname = await prisma.tunnelHostname.findUnique({ where: { id: c.req.param("id") } });
  if (!hostname) throw notFound("Tunnel hostname");

  // Cloudflare first, then the DB; see deleteTunnelHostnameEverywhere.
  await deleteTunnelHostnameEverywhere(prisma, hostname, deleteDnsRecord);
  const ingressUpdated = true;
  const dnsRecordDeleted = true;

  auditSafe({
    actorType: "ADMIN",
    studentId: hostname.studentId,
    action: "ADMIN_TUNNEL_HOSTNAME_DELETED",
    recordId: hostname.id,
    beforeJson: { fqdn: hostname.fqdn, localPort: hostname.localPort },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ success: true, cloudflareCleanup: { ingressUpdated, dnsRecordDeleted } });
});

export default app;
