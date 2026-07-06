import { Hono } from "hono";
import { prisma } from "../db/prisma.js";
import { requireAdmin } from "../lib/auth.js";
import { deleteDnsRecord } from "../lib/cloudflare.js";
import { deleteTunnel, syncTunnelIngress } from "../lib/cloudflare-tunnel.js";
import { auditSafe, getClientIp, getUserAgent } from "../lib/audit.js";
import { checkAdminRateLimit } from "../lib/rate-limit.js";
import { notFound } from "../lib/errors.js";

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

  await prisma.$transaction([
    prisma.tunnelHostname.deleteMany({ where: { tunnelId: tunnel.id } }),
    prisma.tunnel.delete({ where: { id: tunnel.id } }),
  ]);

  // Independent Cloudflare calls (different CNAME records) — run concurrently
  // rather than serializing N round-trips.
  const cleanupResults = await Promise.all(
    hostnameSnapshot.map((h) =>
      deleteDnsRecord(h.cloudflareRecordId)
        .then(() => true)
        .catch((cfErr) => {
          console.error("[delete-orphan] Tunnel hostname CNAME cleanup failed:", { hostnameId: h.id, fqdn: h.fqdn, cfErr });
          return false;
        })
    )
  );
  const dnsRecordsDeleted = cleanupResults.filter(Boolean).length;
  const dnsRecordsFailed = cleanupResults.length - dnsRecordsDeleted;

  let tunnelDeleted = true;
  await deleteTunnel(tunnel.cloudflareTunnelId).catch((cfErr) => {
    tunnelDeleted = false;
    console.error("[delete-orphan] Cloudflare tunnel cleanup failed:", { tunnelId: tunnel.id, cloudflareTunnelId: tunnel.cloudflareTunnelId, cfErr });
  });

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

  await prisma.tunnelHostname.delete({ where: { id: hostname.id } });

  let ingressUpdated = true;
  try {
    const tunnel = await prisma.tunnel.findUniqueOrThrow({ where: { id: hostname.tunnelId } });
    await syncTunnelIngress(prisma, tunnel.id, tunnel.cloudflareTunnelId);
  } catch (err) {
    ingressUpdated = false;
    console.error("[delete-orphan] Tunnel hostname deleted from DB but ingress config update failed:", {
      hostnameId: hostname.id, tunnelId: hostname.tunnelId, err,
    });
  }

  let dnsRecordDeleted = true;
  await deleteDnsRecord(hostname.cloudflareRecordId).catch((cfErr) => {
    dnsRecordDeleted = false;
    console.error("[delete-orphan] Tunnel hostname deleted from DB but Cloudflare CNAME cleanup failed:", {
      hostnameId: hostname.id, cloudflareRecordId: hostname.cloudflareRecordId, cfErr,
    });
  });

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
