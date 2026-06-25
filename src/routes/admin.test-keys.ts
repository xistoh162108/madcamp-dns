import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { requireAdmin } from "../lib/auth.js";
import { generateTestApiKey } from "../lib/api-key.js";
import { auditSafe, getClientIp, getUserAgent } from "../lib/audit.js";
import { checkAdminRateLimit } from "../lib/rate-limit.js";
import { invalidRequest } from "../lib/errors.js";

const app = new Hono();

app.use("*", async (c, next) => {
  await requireAdmin(c);
  const ip = getClientIp(c);
  await checkAdminRateLimit(ip);
  await next();
});

const TestKeysSchema = z.object({
  count: z.number().int().min(1).max(20).default(2),
  recordLimit: z.number().int().min(1).max(100).default(10),
});

// --- POST /admin/test-keys ---
app.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = TestKeysSchema.safeParse(body);
  if (!parsed.success) throw invalidRequest("Invalid request body.", parsed.error.flatten());

  const { count, recordLimit } = parsed.data;
  const rootDomain = process.env.ROOT_DOMAIN!;

  const results = [];
  for (let i = 1; i <= count; i++) {
    const email = `test${i}@local`;
    const subdomain = `test${i}`;

    let student = await prisma.student.findUnique({ where: { email } });
    if (!student) {
      student = await prisma.student.create({
        data: { email, subdomain, recordLimit },
      });
    }

    const { raw, hash, keyPrefix } = generateTestApiKey();
    await prisma.apiKey.create({
      data: {
        studentId: student.id,
        keyHash: hash,
        keyPrefix,
        label: `test-key-${Date.now()}`,
      },
    });

    results.push({
      email: student.email,
      subdomain: `${student.subdomain}.${rootDomain}`,
      apiKey: raw,
    });
  }

  auditSafe({
    actorType: "ADMIN",
    action: "TEST_KEYS_CREATED",
    afterJson: { count },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ testStudents: results }, 201);
});

export default app;
