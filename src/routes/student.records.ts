import { Hono } from "hono";
import { prisma } from "../db/prisma.js";
import { requireStudent, type StudentContext } from "../lib/auth.js";
import { checkStudentRateLimit } from "../lib/rate-limit.js";
import { createDnsRecord, patchDnsRecord, deleteDnsRecord } from "../lib/cloudflare.js";
import { auditSafe, getClientIp, getUserAgent } from "../lib/audit.js";
import { lockSubdomain } from "../lib/subdomain.js";
import {
  validateRelativeName,
  validateRecordType,
  validateRecordContent,
  validateTtl,
  buildFqdn,
  CreateRecordSchema,
  UpdateRecordSchema,
  extractSubdomainFromFqdn,
} from "../lib/validate-dns.js";
import {
  notFound,
  forbiddenRecord,
  recordLimitExceeded,
  dnsConflict,
  invalidRequest,
} from "../lib/errors.js";

const app = new Hono<{ Variables: { auth: StudentContext } }>();

// --- Middleware: auth + rate limit, once, for every handler below ---
app.use("*", async (c, next) => {
  const auth = await requireStudent(c);
  await checkStudentRateLimit(auth.apiKey.keyHash, c.req.method);
  c.set("auth", auth);
  await next();
});

function safeRecord(r: {
  id: string;
  relativeName: string;
  fqdn: string;
  type: string;
  content: string;
  ttl: number;
  proxied: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: r.id,
    name: r.relativeName,
    fqdn: r.fqdn,
    type: r.type,
    content: r.content,
    ttl: r.ttl,
    proxied: r.proxied,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function checkConflicts(
  studentId: string,
  fqdn: string,
  newType: string,
  excludeRecordId?: string
): Promise<void> {
  const existing = await prisma.dnsRecord.findMany({
    where: {
      studentId,
      fqdn,
      ...(excludeRecordId ? { NOT: { id: excludeRecordId } } : {}),
    },
  });

  for (const rec of existing) {
    if (newType === "CNAME" && (rec.type === "A" || rec.type === "AAAA")) {
      throw dnsConflict("CNAME cannot coexist with A or AAAA records on the same name.");
    }
    if ((newType === "A" || newType === "AAAA") && rec.type === "CNAME") {
      throw dnsConflict("A or AAAA cannot coexist with a CNAME record on the same name.");
    }
    if (rec.type === newType) {
      throw dnsConflict(`A ${newType} record already exists for this name.`);
    }
  }
}

// --- GET /v1/records ---
app.get("/", async (c) => {
  const auth = c.get("auth");

  const records = await prisma.dnsRecord.findMany({
    where: { studentId: auth.student.id },
    orderBy: { createdAt: "desc" },
  });

  return c.json({ records: records.map(safeRecord) });
});

// --- GET /v1/records/:id ---
app.get("/:id", async (c) => {
  const auth = c.get("auth");

  const record = await prisma.dnsRecord.findUnique({
    where: { id: c.req.param("id") },
  });
  if (!record) throw notFound("DNS record");
  if (record.studentId !== auth.student.id) throw forbiddenRecord();

  return c.json({ record: safeRecord(record) });
});

// --- POST /v1/records ---
app.post("/", async (c) => {
  const auth = c.get("auth");

  const body = await c.req.json().catch(() => null);
  const parsed = CreateRecordSchema.safeParse(body);
  if (!parsed.success) throw invalidRequest("Invalid request body.", parsed.error.flatten());

  const { name, type, content, proxied, subdomain: requestedSubdomain } = parsed.data;
  const ttl = validateTtl(parsed.data.ttl);

  // Validate fields
  validateRelativeName(name);
  const validType = validateRecordType(type);
  validateRecordContent(validType, content);

  // Normalise name consistently with validateRelativeName's clean path
  const relativeName = name.trim().toLowerCase();

  const rootDomain = process.env.ROOT_DOMAIN!;

  // Determine which subdomain to create the record under.
  // Default: student's primary subdomain. Optional: any additional subdomain they own.
  let targetSubdomain = auth.student.subdomain;
  if (requestedSubdomain) {
    const clean = requestedSubdomain.trim().toLowerCase();
    if (clean !== auth.student.subdomain) {
      const owned = await prisma.ownedSubdomain.findFirst({
        where: { studentId: auth.student.id, subdomain: clean },
        select: { id: true },
      });
      if (!owned) {
        throw invalidRequest(`You do not own the subdomain "${clean}". Claim it first via POST /v1/subdomains.`);
      }
    }
    targetSubdomain = clean;
  }

  const fqdn = buildFqdn(relativeName, targetSubdomain, rootDomain);

  // Optimistic limit check — avoid the Cloudflare round-trip for obvious limit violations.
  // recordLimit is a combined cap across DnsRecord + TunnelHostname (both are
  // "public hostnames" a student can create), so both tables count against it.
  const [dnsCount, tunnelCount] = await Promise.all([
    prisma.dnsRecord.count({ where: { studentId: auth.student.id } }),
    prisma.tunnelHostname.count({ where: { studentId: auth.student.id } }),
  ]);
  if (dnsCount + tunnelCount >= auth.student.recordLimit) {
    throw recordLimitExceeded(auth.student.recordLimit);
  }

  // Check DNS conflicts (optimistic, before CF call)
  await checkConflicts(auth.student.id, fqdn, validType);

  // A fqdn can only ever be one DnsRecord OR one TunnelHostname, never both
  // (mirrors the real DNS rule that a name with a CNAME can carry no other
  // record) — see src/routes/student.tunnels.ts for the other side of this.
  const tunnelConflict = await prisma.tunnelHostname.findUnique({ where: { fqdn } });
  if (tunnelConflict) {
    throw invalidRequest(`The name "${fqdn}" is used by a Tunnel hostname and cannot also hold a manual DNS record.`);
  }

  // Create in Cloudflare first (cannot be done inside a DB transaction)
  const cfRecord = await createDnsRecord({ name: fqdn, type: validType, content, ttl, proxied });

  // Save to DB inside a transaction with a second count check to close the TOCTOU window.
  // If the limit was hit by a concurrent request between the optimistic check above and now,
  // we compensate by deleting the just-created Cloudflare record.
  let record;
  try {
    record = await prisma.$transaction(async (tx) => {
      // Locked on the target subdomain string so a concurrent
      // DELETE /v1/subdomains/:id release can't slip in between here and the
      // insert below — see student.subdomains.ts for the other side of this
      // race and src/lib/subdomain.ts for why the lock exists.
      await lockSubdomain(tx, targetSubdomain);

      if (targetSubdomain !== auth.student.subdomain) {
        const stillOwned = await tx.ownedSubdomain.findFirst({
          where: { studentId: auth.student.id, subdomain: targetSubdomain },
          select: { id: true },
        });
        if (!stillOwned) {
          throw invalidRequest(
            `The subdomain "${targetSubdomain}" was released before this record could be created.`
          );
        }
      }

      const [freshDnsCount, freshTunnelCount] = await Promise.all([
        tx.dnsRecord.count({ where: { studentId: auth.student.id } }),
        tx.tunnelHostname.count({ where: { studentId: auth.student.id } }),
      ]);
      if (freshDnsCount + freshTunnelCount >= auth.student.recordLimit) {
        throw recordLimitExceeded(auth.student.recordLimit);
      }

      const freshTunnelConflict = await tx.tunnelHostname.findUnique({ where: { fqdn } });
      if (freshTunnelConflict) {
        throw invalidRequest(`The name "${fqdn}" is used by a Tunnel hostname and cannot also hold a manual DNS record.`);
      }

      return tx.dnsRecord.create({
        data: {
          studentId: auth.student.id,
          cloudflareRecordId: cfRecord.id,
          relativeName,
          fqdn,
          type: validType,
          content,
          ttl,
          proxied,
        },
      });
    });
  } catch (dbErr) {
    // Compensate: remove the Cloudflare record we just created
    await deleteDnsRecord(cfRecord.id).catch(() => {});
    throw dbErr;
  }

  auditSafe({
    actorType: "STUDENT",
    actorId: auth.student.id,
    studentId: auth.student.id,
    action: "DNS_RECORD_CREATED",
    recordId: record.id,
    afterJson: { fqdn, type: validType, content, ttl, proxied },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ record: safeRecord(record) }, 201);
});

// --- PATCH /v1/records/:id ---
app.patch("/:id", async (c) => {
  const auth = c.get("auth");

  const record = await prisma.dnsRecord.findUnique({ where: { id: c.req.param("id") } });
  if (!record) throw notFound("DNS record");
  if (record.studentId !== auth.student.id) throw forbiddenRecord();

  const body = await c.req.json().catch(() => null);
  const parsed = UpdateRecordSchema.safeParse(body);
  if (!parsed.success) throw invalidRequest("Invalid request body.", parsed.error.flatten());

  const update = parsed.data;
  if (Object.keys(update).length === 0) throw invalidRequest("No fields to update.");

  const rootDomain = process.env.ROOT_DOMAIN!;

  // Extract the subdomain this record lives under — may be primary OR an additional owned one.
  // fqdn = "relativeName.subdomain.rootDomain"
  const recordSubdomain = extractSubdomainFromFqdn(record.fqdn, record.relativeName, rootDomain);

  // Validate updated name if provided — normalise consistently with POST
  let newFqdn = record.fqdn;
  let newRelativeName = record.relativeName;
  if (update.name !== undefined) {
    validateRelativeName(update.name);
    newRelativeName = update.name.trim().toLowerCase();
    newFqdn = buildFqdn(newRelativeName, recordSubdomain, rootDomain);
  }

  // Validate updated content if provided
  if (update.content !== undefined) {
    validateRecordContent(record.type as "A" | "AAAA" | "CNAME" | "TXT", update.content);
  }

  // Validate TTL if provided
  let newTtl = record.ttl;
  if (update.ttl !== undefined) {
    newTtl = validateTtl(update.ttl);
  }

  // Check conflicts only if name changed — both DnsRecord-vs-DnsRecord
  // (checkConflicts) and the cross-resource-type exclusivity with
  // TunnelHostname that POST /v1/records already enforces at creation time.
  if (newFqdn !== record.fqdn) {
    await checkConflicts(auth.student.id, newFqdn, record.type, record.id);

    const tunnelConflict = await prisma.tunnelHostname.findUnique({ where: { fqdn: newFqdn } });
    if (tunnelConflict) {
      throw invalidRequest(`The name "${newFqdn}" is used by a Tunnel hostname and cannot also hold a manual DNS record.`);
    }
  }

  const cfPatch: Record<string, unknown> = {};
  if (update.name !== undefined) cfPatch.name = newFqdn;
  if (update.content !== undefined) cfPatch.content = update.content;
  if (update.ttl !== undefined) cfPatch.ttl = newTtl;
  if (update.proxied !== undefined) cfPatch.proxied = update.proxied;

  const before = {
    relativeName: record.relativeName,
    fqdn: record.fqdn,
    content: record.content,
    ttl: record.ttl,
    proxied: record.proxied,
  };

  await patchDnsRecord(record.cloudflareRecordId, cfPatch);

  let updated;
  try {
    updated = await prisma.dnsRecord.update({
      where: { id: record.id },
      data: {
        relativeName: newRelativeName,
        fqdn: newFqdn,
        content: update.content ?? record.content,
        ttl: newTtl,
        proxied: update.proxied ?? record.proxied,
      },
    });
  } catch (dbErr) {
    // Compensate: best-effort revert Cloudflare back to its pre-patch state,
    // so CF and the DB don't silently diverge when the DB write fails after
    // Cloudflare already accepted the new values.
    await patchDnsRecord(record.cloudflareRecordId, {
      name: before.fqdn,
      content: before.content,
      ttl: before.ttl,
      proxied: before.proxied,
    }).catch((revertErr) => {
      console.error(
        "[patch-compensation] Failed to revert Cloudflare after DB update failure — record now inconsistent:",
        { recordId: record.id, cloudflareRecordId: record.cloudflareRecordId, dbErr, revertErr }
      );
    });
    throw dbErr;
  }

  auditSafe({
    actorType: "STUDENT",
    actorId: auth.student.id,
    studentId: auth.student.id,
    action: "DNS_RECORD_UPDATED",
    recordId: record.id,
    beforeJson: before,
    afterJson: {
      relativeName: newRelativeName,
      fqdn: newFqdn,
      content: update.content ?? record.content,
      ttl: newTtl,
      proxied: update.proxied ?? record.proxied,
    },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ record: safeRecord(updated) });
});

// --- DELETE /v1/records/:id ---
app.delete("/:id", async (c) => {
  const auth = c.get("auth");

  const record = await prisma.dnsRecord.findUnique({ where: { id: c.req.param("id") } });
  if (!record) throw notFound("DNS record");
  if (record.studentId !== auth.student.id) throw forbiddenRecord();

  // DB is authoritative for "is this record gone" — delete it first, then
  // best-effort clean up Cloudflare. If Cloudflare cleanup fails, the DB and
  // the client's view are still accurate; the only residual issue is an
  // orphaned CF record that no longer has a DB counterpart, which is a
  // background ops concern (logged below), not a client-facing error.
  await prisma.dnsRecord.delete({ where: { id: record.id } });

  await deleteDnsRecord(record.cloudflareRecordId).catch((cfErr) => {
    console.error(
      "[delete-orphan] DB record deleted but Cloudflare cleanup failed — needs manual cleanup:",
      { recordId: record.id, cloudflareRecordId: record.cloudflareRecordId, cfErr }
    );
  });

  auditSafe({
    actorType: "STUDENT",
    actorId: auth.student.id,
    studentId: auth.student.id,
    action: "DNS_RECORD_DELETED",
    recordId: record.id,
    beforeJson: { fqdn: record.fqdn, type: record.type, content: record.content },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ success: true });
});

export default app;
