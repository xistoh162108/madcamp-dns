import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { requireStudent } from "../lib/auth.js";
import { checkStudentRateLimit } from "../lib/rate-limit.js";
import { auditSafe, getClientIp, getUserAgent } from "../lib/audit.js";
import { validateSubdomainName } from "../lib/validate-dns.js";
import { notFound, forbidden, invalidRequest } from "../lib/errors.js";

const app = new Hono();

// Students may hold at most this many *additional* subdomains beyond their primary.
const MAX_ADDITIONAL_SUBDOMAINS = 5;

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
  const auth = await requireStudent(c);
  await checkStudentRateLimit(auth.apiKey.keyHash, c.req.method);

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
  const auth = await requireStudent(c);
  await checkStudentRateLimit(auth.apiKey.keyHash, c.req.method);

  const body = await c.req.json().catch(() => null);
  const parsed = ClaimSchema.safeParse(body);
  if (!parsed.success) throw invalidRequest("Invalid request body.", parsed.error.flatten());

  const subdomain = parsed.data.subdomain.trim().toLowerCase();
  validateSubdomainName(subdomain);

  // Can't re-claim your own primary subdomain as an additional one
  if (subdomain === auth.student.subdomain) {
    throw invalidRequest("This is already your primary subdomain.");
  }

  // Enforce per-student additional subdomain limit
  const currentCount = await prisma.ownedSubdomain.count({
    where: { studentId: auth.student.id },
  });
  if (currentCount >= MAX_ADDITIONAL_SUBDOMAINS) {
    throw invalidRequest(
      `You can claim at most ${MAX_ADDITIONAL_SUBDOMAINS} additional subdomains. Release one first.`,
      { limit: MAX_ADDITIONAL_SUBDOMAINS, current: currentCount }
    );
  }

  // Optimistic availability check across both Student and OwnedSubdomain tables
  const [takenByStudent, takenByOwned] = await Promise.all([
    prisma.student.findFirst({ where: { subdomain }, select: { id: true } }),
    prisma.ownedSubdomain.findFirst({ where: { subdomain }, select: { id: true } }),
  ]);
  if (takenByStudent || takenByOwned) {
    throw invalidRequest(`The subdomain "${subdomain}" is already in use.`);
  }

  let owned;
  try {
    owned = await prisma.ownedSubdomain.create({
      data: { studentId: auth.student.id, subdomain },
    });
  } catch (err) {
    // Concurrent request claimed the same subdomain between our check and insert
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
  const auth = await requireStudent(c);
  await checkStudentRateLimit(auth.apiKey.keyHash, c.req.method);

  const owned = await prisma.ownedSubdomain.findUnique({
    where: { id: c.req.param("id") },
  });
  if (!owned) throw notFound("Subdomain");
  if (owned.studentId !== auth.student.id) {
    throw forbidden("You can only release your own additional subdomains.");
  }

  const rootDomain = process.env.ROOT_DOMAIN!;
  const fqdnSuffix = `.${owned.subdomain}.${rootDomain}`;

  // Prevent release while DNS records still exist (avoids orphaned CF records)
  const recordCount = await prisma.dnsRecord.count({
    where: { studentId: auth.student.id, fqdn: { endsWith: fqdnSuffix } },
  });
  if (recordCount > 0) {
    throw invalidRequest(
      `Cannot release: ${recordCount} DNS record(s) still exist under ${owned.subdomain}.${rootDomain}. Delete them first.`,
      { recordCount }
    );
  }

  await prisma.ownedSubdomain.delete({ where: { id: owned.id } });

  auditSafe({
    actorType: "STUDENT",
    actorId: auth.student.id,
    studentId: auth.student.id,
    action: "SUBDOMAIN_RELEASED",
    beforeJson: { subdomain: owned.subdomain, fqdn: `${owned.subdomain}.${rootDomain}` },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ success: true });
});

export default app;
