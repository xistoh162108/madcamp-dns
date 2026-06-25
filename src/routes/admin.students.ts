import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { requireAdmin } from "../lib/auth.js";
import { generateApiKey } from "../lib/api-key.js";
import { auditSafe, getClientIp, getUserAgent } from "../lib/audit.js";
import { checkAdminRateLimit } from "../lib/rate-limit.js";
import { invalidRequest, notFound } from "../lib/errors.js";
import { Prisma } from "@prisma/client";

const app = new Hono();

// --- Middleware ---
app.use("*", async (c, next) => {
  await requireAdmin(c);
  const ip = getClientIp(c);
  await checkAdminRateLimit(ip);
  await next();
});

// Helper: format subdomain response as FQDN
function fmtSubdomain(sub: string) {
  return `${sub}.${process.env.ROOT_DOMAIN}`;
}

function safeStudentView(s: {
  id: string;
  email: string;
  name: string | null;
  subdomain: string;
  recordLimit: number;
  isActive: boolean;
  createdAt: Date;
}) {
  return {
    id: s.id,
    email: s.email,
    name: s.name,
    subdomain: fmtSubdomain(s.subdomain),
    recordLimit: s.recordLimit,
    isActive: s.isActive,
    createdAt: s.createdAt,
  };
}

// --- POST /admin/students ---
const CreateStudentSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  subdomain: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$/, "Subdomain must be lowercase alphanumeric with hyphens"),
  recordLimit: z.number().int().min(1).max(100).default(10),
});

app.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreateStudentSchema.safeParse(body);
  if (!parsed.success) throw invalidRequest("Invalid request body.", parsed.error.flatten());

  const { email, name, subdomain, recordLimit } = parsed.data;

  const [existing, ownedConflict] = await Promise.all([
    prisma.student.findFirst({ where: { OR: [{ email }, { subdomain }] } }),
    prisma.ownedSubdomain.findFirst({ where: { subdomain }, select: { id: true } }),
  ]);
  if (ownedConflict) {
    throw invalidRequest("Subdomain is already claimed by a student as an additional subdomain.");
  }
  if (existing) {
    throw invalidRequest(
      existing.email === email ? "Email already in use." : "Subdomain already taken."
    );
  }

  const { raw, hash, keyPrefix } = generateApiKey();

  let student;
  try {
    student = await prisma.student.create({
      data: {
        email,
        name,
        subdomain,
        recordLimit,
        apiKeys: {
          create: { keyHash: hash, keyPrefix, label: "default" },
        },
      },
    });
  } catch (err) {
    // Concurrent request may have claimed the email or subdomain between check and insert
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw invalidRequest("Email or subdomain is already in use.");
    }
    throw err;
  }

  auditSafe({
    actorType: "ADMIN",
    studentId: student.id,
    action: "STUDENT_CREATED",
    afterJson: { email, subdomain },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  auditSafe({
    actorType: "ADMIN",
    studentId: student.id,
    action: "API_KEY_CREATED",
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ student: safeStudentView(student), apiKey: raw }, 201);
});

// --- POST /admin/students/bulk ---
const BulkCreateSchema = z.object({
  students: z
    .array(
      z.object({
        email: z.string().email(),
        name: z.string().optional(),
        subdomain: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$/, "Invalid subdomain"),
      })
    )
    .min(1)
    .max(100),
  recordLimit: z.number().int().min(1).max(100).default(10),
});

app.post("/bulk", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = BulkCreateSchema.safeParse(body);
  if (!parsed.success) throw invalidRequest("Invalid request body.", parsed.error.flatten());

  const { students, recordLimit } = parsed.data;

  // Check uniqueness within request
  const emails = students.map((s) => s.email);
  const subdomains = students.map((s) => s.subdomain);
  if (new Set(emails).size !== emails.length)
    throw invalidRequest("Duplicate emails in request.");
  if (new Set(subdomains).size !== subdomains.length)
    throw invalidRequest("Duplicate subdomains in request.");

  // Check against DB — both Student table and OwnedSubdomain (students can claim subdomains)
  const [conflicts, ownedConflicts] = await Promise.all([
    prisma.student.findMany({
      where: { OR: [{ email: { in: emails } }, { subdomain: { in: subdomains } }] },
      select: { email: true, subdomain: true },
    }),
    prisma.ownedSubdomain.findMany({
      where: { subdomain: { in: subdomains } },
      select: { subdomain: true },
    }),
  ]);
  if (conflicts.length > 0) {
    throw invalidRequest("Some emails or subdomains are already in use.", {
      conflicts: conflicts.map((c) => ({ email: c.email, subdomain: c.subdomain })),
    });
  }
  if (ownedConflicts.length > 0) {
    throw invalidRequest("Some subdomains are already claimed by students as additional subdomains.", {
      conflicts: ownedConflicts.map((c) => ({ subdomain: c.subdomain })),
    });
  }

  // Generate all keys before the transaction so crypto work is outside the DB lock
  const prepared = students.map((s) => {
    const { raw, hash, keyPrefix } = generateApiKey();
    return { student: s, raw, hash, keyPrefix };
  });

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const rows = [];
      for (const { student: s, hash, keyPrefix } of prepared) {
        const row = await tx.student.create({
          data: {
            email: s.email,
            name: s.name,
            subdomain: s.subdomain,
            recordLimit,
            apiKeys: { create: { keyHash: hash, keyPrefix, label: "default" } },
          },
        });
        rows.push(row);
      }
      return rows;
    });
  } catch (err) {
    // A concurrent request may have taken an email/subdomain between our check and the transaction
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw invalidRequest("One or more emails or subdomains are already in use (concurrent conflict).");
    }
    throw err;
  }

  const results = created.map((row, i) => ({
    email: row.email,
    subdomain: fmtSubdomain(row.subdomain),
    apiKey: prepared[i].raw,
  }));

  auditSafe({
    actorType: "ADMIN",
    action: "STUDENTS_BULK_CREATED",
    afterJson: { count: students.length },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ students: results }, 201);
});

// --- GET /admin/students ---
app.get("/", async (c) => {
  const page  = Math.max(1, parseInt(c.req.query("page")  ?? "1",  10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10) || 1));

  const [total, students] = await Promise.all([
    prisma.student.count(),
    prisma.student.findMany({
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return c.json({ students: students.map(safeStudentView), total, page, limit });
});

// --- GET /admin/students/:id ---
app.get("/:id", async (c) => {
  const student = await prisma.student.findUnique({ where: { id: c.req.param("id") } });
  if (!student) throw notFound("Student");
  return c.json({ student: safeStudentView(student) });
});

// --- PATCH /admin/students/:id ---
const UpdateStudentSchema = z.object({
  name: z.string().optional(),
  isActive: z.boolean().optional(),
  recordLimit: z.number().int().min(1).max(100).optional(),
});

app.patch("/:id", async (c) => {
  const student = await prisma.student.findUnique({ where: { id: c.req.param("id") } });
  if (!student) throw notFound("Student");

  const body = await c.req.json().catch(() => null);
  const parsed = UpdateStudentSchema.safeParse(body);
  if (!parsed.success) throw invalidRequest("Invalid request body.", parsed.error.flatten());

  if (Object.keys(parsed.data).length === 0) {
    throw invalidRequest("No fields to update.");
  }

  const before = { name: student.name, isActive: student.isActive, recordLimit: student.recordLimit };

  const updated = await prisma.student.update({
    where: { id: student.id },
    data: parsed.data,
  });

  auditSafe({
    actorType: "ADMIN",
    studentId: student.id,
    action: "STUDENT_UPDATED",
    beforeJson: before,
    afterJson: parsed.data,
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ student: safeStudentView(updated) });
});

// --- GET /admin/students/:id/api-keys ---
app.get("/:id/api-keys", async (c) => {
  const student = await prisma.student.findUnique({ where: { id: c.req.param("id") } });
  if (!student) throw notFound("Student");

  const keys = await prisma.apiKey.findMany({
    where: { studentId: student.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      keyPrefix: true,
      label: true,
      isActive: true,
      lastUsedAt: true,
      createdAt: true,
      revokedAt: true,
    },
  });

  return c.json({ apiKeys: keys });
});

// --- POST /admin/students/:id/api-keys ---
const CreateKeySchema = z.object({
  label: z.string().max(64).optional(),
});

app.post("/:id/api-keys", async (c) => {
  const student = await prisma.student.findUnique({ where: { id: c.req.param("id") } });
  if (!student) throw notFound("Student");

  const body = await c.req.json().catch(() => ({}));
  const parsed = CreateKeySchema.safeParse(body);
  if (!parsed.success) throw invalidRequest("Invalid request body.");

  const { raw, hash, keyPrefix } = generateApiKey();
  await prisma.apiKey.create({
    data: {
      studentId: student.id,
      keyHash: hash,
      keyPrefix,
      label: parsed.data.label ?? null,
    },
  });

  auditSafe({
    actorType: "ADMIN",
    studentId: student.id,
    action: "API_KEY_CREATED",
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ apiKey: raw }, 201);
});

// --- POST /admin/students/:id/rotate-key ---
app.post("/:id/rotate-key", async (c) => {
  const student = await prisma.student.findUnique({ where: { id: c.req.param("id") } });
  if (!student) throw notFound("Student");

  const now = new Date();
  await prisma.apiKey.updateMany({
    where: { studentId: student.id, isActive: true },
    data: { isActive: false, revokedAt: now },
  });

  const { raw, hash, keyPrefix } = generateApiKey();
  await prisma.apiKey.create({
    data: { studentId: student.id, keyHash: hash, keyPrefix, label: "rotated" },
  });

  auditSafe({
    actorType: "ADMIN",
    studentId: student.id,
    action: "API_KEY_ROTATED",
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ apiKey: raw });
});

// --- DELETE /admin/students/:id/api-keys/:keyId ---
app.delete("/:id/api-keys/:keyId", async (c) => {
  const { id, keyId } = c.req.param();

  const key = await prisma.apiKey.findFirst({
    where: { id: keyId, studentId: id },
  });
  if (!key) throw notFound("API key");

  const now = new Date();
  await prisma.apiKey.update({
    where: { id: keyId },
    data: { isActive: false, revokedAt: now },
  });

  auditSafe({
    actorType: "ADMIN",
    actorId: key.studentId,
    studentId: id,
    action: "API_KEY_REVOKED",
    recordId: keyId,
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ success: true });
});

export default app;
