import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { requireStudent, type StudentContext } from "../lib/auth.js";
import { checkStudentRateLimit } from "../lib/rate-limit.js";
import { auditSafe, getClientIp, getUserAgent } from "../lib/audit.js";
import { lockSubdomain, assertSubdomainAvailable } from "../lib/subdomain.js";
import { notFound, forbidden, invalidRequest } from "../lib/errors.js";

const app = new Hono<{ Variables: { auth: StudentContext } }>();

// Students may hold at most this many *additional* subdomains beyond their primary.
const MAX_ADDITIONAL_SUBDOMAINS = 5;

// --- Middleware: auth + rate limit, once, for every handler below ---
app.use("*", async (c, next) => {
  const auth = await requireStudent(c);
  await checkStudentRateLimit(auth.apiKey.keyHash, c.req.method);
  c.set("auth", auth);
  await next();
});

function fmtOwned(s: { id: string; subdomain: string; createdAt: Date }, rootDomain: string) {
  return {
    id: s.id,
    subdomain: s.subdomain,
    fqdn: `${s.subdomain}.${rootDomain}`,
    createdAt: s.createdAt,
  };
}

// --- GET /v1/subdomains ---
// List primary subdomain and all additional owned subdomains.
app.get("/", async (c) => {
  const auth = c.get("auth");

  const rootDomain = process.env.ROOT_DOMAIN!;

  const additional = await prisma.ownedSubdomain.findMany({
    where: { studentId: auth.student.id },
    orderBy: { createdAt: "asc" },
  });

  return c.json({
    primary: {
      subdomain: auth.student.subdomain,
      fqdn: `${auth.student.subdomain}.${rootDomain}`,
    },
    additional: additional.map((s) => fmtOwned(s, rootDomain)),
    additionalUsed: additional.length,
    additionalLimit: MAX_ADDITIONAL_SUBDOMAINS,
  });
});

// --- POST /v1/subdomains ---
// Claim an additional subdomain. Fails if blocked, already taken, or limit reached.
const ClaimSchema = z.object({
  subdomain: z.string().min(1).max(32),
});

app.post("/", async (c) => {
  const auth = c.get("auth");

  const body = await c.req.json().catch(() => null);
  const parsed = ClaimSchema.safeParse(body);
  if (!parsed.success) throw invalidRequest("Invalid request body.", parsed.error.flatten());

  const subdomain = parsed.data.subdomain.trim().toLowerCase();

  // Can't re-claim your own primary subdomain as an additional one — check
  // this specific case up front for a clearer error message.
  if (subdomain === auth.student.subdomain) {
    throw invalidRequest("This is already your primary subdomain.");
  }

  let owned;
  try {
    owned = await prisma.$transaction(async (tx) => {
      // Locked so this claim can't race a concurrent admin student-create /
      // bulk-create / test-keys call (or another student) claiming the exact
      // same subdomain string — see src/lib/subdomain.ts.
      await lockSubdomain(tx, subdomain);
      await assertSubdomainAvailable(tx, subdomain);

      // Enforce per-student additional subdomain limit inside the same lock,
      // so two concurrent claims for two different available subdomains
      // can't both slip past the limit check and push the student over it.
      const currentCount = await tx.ownedSubdomain.count({
        where: { studentId: auth.student.id },
      });
      if (currentCount >= MAX_ADDITIONAL_SUBDOMAINS) {
        throw invalidRequest(
          `You can claim at most ${MAX_ADDITIONAL_SUBDOMAINS} additional subdomains. Release one first.`,
          { limit: MAX_ADDITIONAL_SUBDOMAINS, current: currentCount }
        );
      }

      return tx.ownedSubdomain.create({
        data: { studentId: auth.student.id, subdomain },
      });
    });
  } catch (err) {
    // Belt-and-suspenders: the advisory lock above should make this
    // unreachable in normal operation.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw invalidRequest(`The subdomain "${subdomain}" is already in use.`);
    }
    throw err;
  }

  const rootDomain = process.env.ROOT_DOMAIN!;

  auditSafe({
    actorType: "STUDENT",
    actorId: auth.student.id,
    studentId: auth.student.id,
    action: "SUBDOMAIN_CLAIMED",
    afterJson: { subdomain, fqdn: `${subdomain}.${rootDomain}` },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ subdomain: fmtOwned(owned, rootDomain) }, 201);
});

// --- DELETE /v1/subdomains/:id ---
// Release an additional subdomain. Blocked if DNS records still exist under it.
app.delete("/:id", async (c) => {
  const auth = c.get("auth");
  const ownedId = c.req.param("id");
  const rootDomain = process.env.ROOT_DOMAIN!;

  const released = await prisma.$transaction(async (tx) => {
    const owned = await tx.ownedSubdomain.findUnique({ where: { id: ownedId } });
    if (!owned) throw notFound("Subdomain");
    if (owned.studentId !== auth.student.id) {
      throw forbidden("You can only release your own additional subdomains.");
    }

    // Lock this subdomain string BEFORE the record-count check. A concurrent
    // POST /v1/records targeting this subdomain acquires the same lock in
    // its own final transaction (see student.records.ts) — whichever
    // transaction commits first wins, and the other re-reads fresh state
    // instead of racing past a stale count. Without this, a record could be
    // created in the gap between the count check below and the delete,
    // orphaning a live Cloudflare record under a subdomain someone else may
    // later reclaim.
    await lockSubdomain(tx, owned.subdomain);

    const apexFqdn = `${owned.subdomain}.${rootDomain}`;
    const fqdnSuffix = `.${owned.subdomain}.${rootDomain}`;

    // Must check both sub-records (endsWith) AND the apex "@" record (exact match).
    const recordCount = await tx.dnsRecord.count({
      where: {
        studentId: auth.student.id,
        OR: [{ fqdn: { endsWith: fqdnSuffix } }, { fqdn: apexFqdn }],
      },
    });
    if (recordCount > 0) {
      throw invalidRequest(
        `Cannot release: ${recordCount} DNS record(s) still exist under ${owned.subdomain}.${rootDomain}. Delete them first.`,
        { recordCount }
      );
    }

    // Symmetric check for Tunnel hostnames — see src/routes/student.tunnels.ts.
    // subdomain is an indexed column on TunnelHostname, so this is a cheap
    // equality lookup rather than string matching.
    const tunnelHostnameCount = await tx.tunnelHostname.count({
      where: { studentId: auth.student.id, subdomain: owned.subdomain },
    });
    if (tunnelHostnameCount > 0) {
      throw invalidRequest(
        `Cannot release: ${tunnelHostnameCount} Tunnel hostname(s) still exist under ${owned.subdomain}.${rootDomain}. Delete them first.`,
        { tunnelHostnameCount }
      );
    }

    await tx.ownedSubdomain.delete({ where: { id: owned.id } });
    return owned;
  });

  auditSafe({
    actorType: "STUDENT",
    actorId: auth.student.id,
    studentId: auth.student.id,
    action: "SUBDOMAIN_RELEASED",
    beforeJson: { subdomain: released.subdomain, fqdn: `${released.subdomain}.${rootDomain}` },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ success: true });
});

export default app;
