import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { requireStudent, type StudentContext } from "../lib/auth.js";
import { checkStudentRateLimit } from "../lib/rate-limit.js";
import { auditSafe, getClientIp, getUserAgent } from "../lib/audit.js";
import { lockSubdomain } from "../lib/subdomain.js";
import {
  createTunnel,
  deleteTunnel,
  getConnectorToken,
  syncTunnelIngress,
} from "../lib/cloudflare-tunnel.js";
import { createDnsRecord, deleteDnsRecord } from "../lib/cloudflare.js";
import { validateRelativeName, buildFqdn } from "../lib/validate-dns.js";
import { validateLocalPort } from "../lib/validate-tunnel.js";
import { notFound, forbidden, recordLimitExceeded, invalidRequest } from "../lib/errors.js";

const app = new Hono<{ Variables: { auth: StudentContext } }>();

// --- Middleware: auth + rate limit, once, for every handler below ---
app.use("*", async (c, next) => {
  const auth = await requireStudent(c);
  await checkStudentRateLimit(auth.apiKey.keyHash, c.req.method);
  c.set("auth", auth);
  await next();
});

function safeHostname(h: {
  id: string;
  relativeName: string;
  fqdn: string;
  localPort: number;
  protocol: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: h.id,
    name: h.relativeName,
    fqdn: h.fqdn,
    localPort: h.localPort,
    protocol: h.protocol,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

// Get-or-create the student's single Cloudflare Tunnel. Tunnel.studentId is
// @unique, so Postgres itself serializes a concurrent double-create attempt —
// no advisory lock needed, just a P2002-catch-and-refetch.
async function ensureTunnel(studentId: string, name: string, ip: string, userAgent: string) {
  const existing = await prisma.tunnel.findUnique({ where: { studentId } });
  if (existing) return existing;

  const cf = await createTunnel(name);
  try {
    const created = await prisma.tunnel.create({
      data: { studentId, cloudflareTunnelId: cf.id, name },
    });
    auditSafe({
      actorType: "STUDENT",
      actorId: studentId,
      studentId,
      action: "TUNNEL_CREATED",
      afterJson: { name },
      ip,
      userAgent,
    });
    return created;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Lost the race — a concurrent request already created this student's
      // tunnel. Clean up the orphaned Cloudflare tunnel we just created.
      await deleteTunnel(cf.id).catch(() => {});
      return prisma.tunnel.findUniqueOrThrow({ where: { studentId } });
    }
    await deleteTunnel(cf.id).catch(() => {});
    throw err;
  }
}

// --- GET /v1/tunnels ---
// Tunnel existence/metadata + hostname list only — no connector token here,
// so a plain read-only-looking GET never exposes a live install credential.
app.get("/", async (c) => {
  const auth = c.get("auth");

  const tunnel = await prisma.tunnel.findUnique({
    where: { studentId: auth.student.id },
    include: { hostnames: { orderBy: { createdAt: "asc" } } },
  });

  if (!tunnel) {
    return c.json({ tunnel: { exists: false } });
  }

  return c.json({
    tunnel: {
      exists: true,
      id: tunnel.id,
      name: tunnel.name,
      hostnames: tunnel.hostnames.map(safeHostname),
    },
  });
});

// --- POST /v1/tunnels ---
// Explicit provisioning call. Returns the install command exactly once, from
// this explicit request — not on every GET — to keep the connector token's
// exposure surface narrow.
app.post("/", async (c) => {
  const auth = c.get("auth");

  const tunnel = await ensureTunnel(
    auth.student.id,
    `${auth.student.subdomain}-tunnel`,
    getClientIp(c),
    getUserAgent(c)
  );
  const token = await getConnectorToken(tunnel.cloudflareTunnelId);

  return c.json({
    tunnel: { id: tunnel.id, name: tunnel.name },
    installCommand: `sudo cloudflared service install ${token}`,
  });
});

// --- GET /v1/tunnels/token ---
// Re-fetch the connector token on demand (e.g. reinstalling on a rebuilt VM).
app.get("/token", async (c) => {
  const auth = c.get("auth");

  const tunnel = await prisma.tunnel.findUnique({ where: { studentId: auth.student.id } });
  if (!tunnel) throw notFound("Tunnel — create one first via POST /v1/tunnels");

  const token = await getConnectorToken(tunnel.cloudflareTunnelId);
  return c.json({ installCommand: `sudo cloudflared service install ${token}` });
});

// --- POST /v1/tunnels/hostnames ---
const CreateHostnameSchema = z.object({
  subdomain: z.string().min(1).max(32),
  name: z.string().min(1).max(128).default("@"),
  localPort: z.union([z.number(), z.string()]),
});

app.post("/hostnames", async (c) => {
  const auth = c.get("auth");

  const body = await c.req.json().catch(() => null);
  const parsed = CreateHostnameSchema.safeParse(body);
  if (!parsed.success) throw invalidRequest("Invalid request body.", parsed.error.flatten());

  const { name, localPort: rawLocalPort } = parsed.data;
  const requestedSubdomain = parsed.data.subdomain.trim().toLowerCase();

  // Resolve/validate subdomain ownership — same pattern as student.records.ts.
  let targetSubdomain = auth.student.subdomain;
  if (requestedSubdomain !== auth.student.subdomain) {
    const owned = await prisma.ownedSubdomain.findFirst({
      where: { studentId: auth.student.id, subdomain: requestedSubdomain },
      select: { id: true },
    });
    if (!owned) {
      throw invalidRequest(`You do not own the subdomain "${requestedSubdomain}". Claim it first via POST /v1/subdomains.`);
    }
    targetSubdomain = requestedSubdomain;
  }

  validateRelativeName(name);
  const relativeName = name.trim().toLowerCase();
  const localPort = validateLocalPort(rawLocalPort);

  const rootDomain = process.env.ROOT_DOMAIN!;
  const fqdn = buildFqdn(relativeName, targetSubdomain, rootDomain);

  // Optimistic pre-flight checks (unlocked) — combined quota across
  // DnsRecord + TunnelHostname, and fqdn exclusivity in both directions.
  const [dnsCount, tunnelCount] = await Promise.all([
    prisma.dnsRecord.count({ where: { studentId: auth.student.id } }),
    prisma.tunnelHostname.count({ where: { studentId: auth.student.id } }),
  ]);
  if (dnsCount + tunnelCount >= auth.student.recordLimit) {
    throw recordLimitExceeded(auth.student.recordLimit);
  }
  const [dnsConflict, tunnelConflict] = await Promise.all([
    prisma.dnsRecord.findFirst({ where: { fqdn }, select: { id: true } }),
    prisma.tunnelHostname.findUnique({ where: { fqdn } }),
  ]);
  if (dnsConflict) {
    throw invalidRequest(`The name "${fqdn}" already has a manual DNS record and cannot also be tunneled.`);
  }
  if (tunnelConflict) {
    throw invalidRequest(`The name "${fqdn}" is already tunneled.`);
  }

  const tunnel = await ensureTunnel(
    auth.student.id,
    `${auth.student.subdomain}-tunnel`,
    getClientIp(c),
    getUserAgent(c)
  );

  // Create the CNAME via the EXISTING DNS wrapper/token (zone-scoped DNS
  // Edit) — the tunnel-scoped token is never used for DNS record management.
  // proxied and the CNAME target are hardcoded, never derived from student input.
  const cfRecord = await createDnsRecord({
    name: fqdn,
    type: "CNAME",
    content: `${tunnel.cloudflareTunnelId}.cfargotunnel.com`,
    ttl: 1,
    proxied: true,
  });

  // Recompute the tunnel's full active-hostname list (existing + candidate)
  // and PUT it complete — syncTunnelIngress serializes this against any other
  // concurrent create/delete on the SAME tunnel via an in-memory lock, since
  // the Configuration API replaces the whole ingress array every call (not
  // incrementally) and two unsynchronized recomputes would otherwise race.
  try {
    await syncTunnelIngress(prisma, tunnel.id, tunnel.cloudflareTunnelId, { fqdn, localPort });
  } catch (ingressErr) {
    await deleteDnsRecord(cfRecord.id).catch(() => {});
    throw ingressErr;
  }

  // Final locked transaction — DB-only, no network calls inside. Whichever
  // of this transaction or a concurrent DELETE /v1/subdomains/:id release
  // commits first wins; the other re-reads fresh state. See
  // src/routes/student.subdomains.ts for the other side of this race.
  let hostname;
  try {
    hostname = await prisma.$transaction(async (tx) => {
      await lockSubdomain(tx, targetSubdomain);

      if (targetSubdomain !== auth.student.subdomain) {
        const stillOwned = await tx.ownedSubdomain.findFirst({
          where: { studentId: auth.student.id, subdomain: targetSubdomain },
          select: { id: true },
        });
        if (!stillOwned) {
          throw invalidRequest(`The subdomain "${targetSubdomain}" was released before this hostname could be created.`);
        }
      }

      const [freshDnsCount, freshTunnelCount] = await Promise.all([
        tx.dnsRecord.count({ where: { studentId: auth.student.id } }),
        tx.tunnelHostname.count({ where: { studentId: auth.student.id } }),
      ]);
      if (freshDnsCount + freshTunnelCount >= auth.student.recordLimit) {
        throw recordLimitExceeded(auth.student.recordLimit);
      }

      const freshDnsConflict = await tx.dnsRecord.findFirst({ where: { fqdn }, select: { id: true } });
      if (freshDnsConflict) {
        throw invalidRequest(`The name "${fqdn}" already has a manual DNS record and cannot also be tunneled.`);
      }

      // Re-check the TunnelHostname side too (mirrors the DnsRecord recheck
      // above) — without this, two concurrent requests for the identical
      // fqdn would both pass the earlier optimistic check, and the loser's
      // create() below would hit the fqdn @unique constraint as a raw,
      // unhandled Prisma error instead of a clean 400.
      const freshTunnelConflict = await tx.tunnelHostname.findUnique({ where: { fqdn } });
      if (freshTunnelConflict) {
        throw invalidRequest(`The name "${fqdn}" is already tunneled.`);
      }

      return tx.tunnelHostname.create({
        data: {
          tunnelId: tunnel.id,
          studentId: auth.student.id,
          subdomain: targetSubdomain,
          relativeName,
          fqdn,
          cloudflareRecordId: cfRecord.id,
          localPort,
        },
      });
    });
  } catch (dbErr) {
    // Belt-and-suspenders: the recheck above should make a raw fqdn P2002
    // unreachable in normal operation, but translate it to a clean 400 if it
    // ever slips through (e.g. a manual DB insert outside the app).
    const err =
      dbErr instanceof Prisma.PrismaClientKnownRequestError && dbErr.code === "P2002"
        ? invalidRequest(`The name "${fqdn}" is already in use.`)
        : dbErr;

    // Compensate: revert the ingress config to exclude the candidate, and
    // remove the CNAME we just created — both best-effort, both logged if
    // the compensation itself fails.
    await syncTunnelIngress(prisma, tunnel.id, tunnel.cloudflareTunnelId).catch((revertErr) => {
      console.error(
        "[tunnel-hostname-compensation] Failed to revert ingress config after DB failure:",
        { tunnelId: tunnel.id, fqdn, dbErr, revertErr }
      );
    });
    await deleteDnsRecord(cfRecord.id).catch((revertErr) => {
      console.error(
        "[tunnel-hostname-compensation] Failed to delete orphaned CNAME after DB failure:",
        { cloudflareRecordId: cfRecord.id, fqdn, dbErr, revertErr }
      );
    });
    throw err;
  }

  auditSafe({
    actorType: "STUDENT",
    actorId: auth.student.id,
    studentId: auth.student.id,
    action: "TUNNEL_HOSTNAME_CREATED",
    recordId: hostname.id,
    afterJson: { fqdn, localPort },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ hostname: safeHostname(hostname) }, 201);
});

// --- DELETE /v1/tunnels/hostnames/:id ---
app.delete("/hostnames/:id", async (c) => {
  const auth = c.get("auth");

  const hostname = await prisma.tunnelHostname.findUnique({ where: { id: c.req.param("id") } });
  if (!hostname) throw notFound("Tunnel hostname");
  if (hostname.studentId !== auth.student.id) {
    throw forbidden("You can only access your own Tunnel hostnames.");
  }

  // DB is authoritative — delete first, then best-effort clean up Cloudflare
  // (mirrors the established DELETE /v1/records/:id semantics: consistent
  // across both resource types on purpose, so tunnel deletes don't surprise
  // anyone who already knows how DNS record deletes behave). Two independent
  // CF-side steps here, so report cleanup outcome in the response body
  // rather than only logging it — more visibility than a plain record delete
  // needs, since there's more that can partially fail.
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
    actorType: "STUDENT",
    actorId: auth.student.id,
    studentId: auth.student.id,
    action: "TUNNEL_HOSTNAME_DELETED",
    recordId: hostname.id,
    beforeJson: { fqdn: hostname.fqdn, localPort: hostname.localPort },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ success: true, cloudflareCleanup: { ingressUpdated, dnsRecordDeleted } });
});

export default app;
