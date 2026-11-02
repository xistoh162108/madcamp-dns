import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { requireAdmin } from "../lib/auth.js";
import { checkAdminRateLimit } from "../lib/rate-limit.js";
import { auditSafe, getClientIp, getUserAgent } from "../lib/audit.js";
import { hashPassword, generatePassword } from "../lib/password.js";
import { lockSubdomain, assertSubdomainAvailable } from "../lib/subdomain.js";
import { invalidRequest, notFound } from "../lib/errors.js";
import { WEB_SESSION_LABEL } from "./team.auth.js";

// Admin endpoints for web-UI teams. A "team" is just a Student whose login ID
// is its subdomain and that has a passwordHash. Existing API-key students keep
// working as before, and any of them can be given a password via
// POST /admin/teams/:team/password to use the web UI too.

const app = new Hono();

app.use("*", async (c, next) => {
  await checkAdminRateLimit(getClientIp(c));
  await requireAdmin(c);
  await next();
});

const PasswordSchema = z.string().min(10, "Password must be at least 10 characters.").max(256);

const TEAM_EMAIL_SUFFIX = "@team.invalid";

function teamView(s: {
  id: string;
  email: string;
  name: string | null;
  subdomain: string;
  recordLimit: number;
  isActive: boolean;
  passwordHash: string | null;
  createdAt: Date;
  _count?: { records: number };
}) {
  return {
    id: s.id,
    team: s.subdomain,
    name: s.name,
    // Placeholder emails of UI-created teams are hidden; real student emails are shown.
    email: s.email.endsWith(TEAM_EMAIL_SUFFIX) ? null : s.email,
    domain: `${s.subdomain}.${process.env.ROOT_DOMAIN}`,
    recordLimit: s.recordLimit,
    recordCount: s._count?.records,
    isActive: s.isActive,
    hasPassword: s.passwordHash !== null,
    createdAt: s.createdAt,
  };
}

async function findTeam(team: string) {
  const id = team.trim().toLowerCase();
  const student = await (id.includes("@") ? prisma.student.findUnique({ where: { email: id } }) : prisma.student.findUnique({ where: { subdomain: id } }));
  if (!student) throw notFound("Team");
  return student;
}

// --- GET /admin/teams --- every student, with login status
app.get("/", async (c) => {
  const students = await prisma.student.findMany({
    orderBy: { subdomain: "asc" },
    include: { _count: { select: { records: true } } },
  });
  return c.json({ teams: students.map(teamView) });
});

// --- POST /admin/teams --- create a team; password is generated if omitted
const CreateTeamSchema = z.object({
  team: z.string().min(1).max(32),
  name: z.string().max(100).optional(),
  password: PasswordSchema.optional(),
  recordLimit: z.number().int().min(1).max(100).default(10),
});

app.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreateTeamSchema.safeParse(body);
  if (!parsed.success) throw invalidRequest("Invalid request body.", parsed.error.flatten());

  const team = parsed.data.team.trim().toLowerCase();
  const password = parsed.data.password ?? generatePassword();
  const passwordHash = await hashPassword(password);

  let student;
  try {
    student = await prisma.$transaction(async (tx) => {
      await lockSubdomain(tx, team);
      await assertSubdomainAvailable(tx, team);
      return tx.student.create({
        data: {
          // Student.email is a required unique column; teams don't need a real one.
          email: `${team}${TEAM_EMAIL_SUFFIX}`,
          name: parsed.data.name?.trim() || team,
          subdomain: team,
          recordLimit: parsed.data.recordLimit,
          passwordHash,
        },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw invalidRequest("Team ID is already in use.");
    }
    throw err;
  }

  auditSafe({
    actorType: "ADMIN",
    studentId: student.id,
    action: "TEAM_CREATED",
    afterJson: { team },
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  // The plaintext password is returned only here, once.
  return c.json({ team: teamView(student), password }, 201);
});

// --- POST /admin/teams/:team/password --- set or regenerate; logs out web sessions
app.post("/:team/password", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ password: PasswordSchema.optional() }).safeParse(body ?? {});
  if (!parsed.success) throw invalidRequest("Invalid request body.", parsed.error.flatten());

  const student = await findTeam(c.req.param("team"));
  const password = parsed.data.password ?? generatePassword();

  await prisma.$transaction([
    prisma.student.update({ where: { id: student.id }, data: { passwordHash: await hashPassword(password) } }),
    prisma.apiKey.updateMany({
      where: { studentId: student.id, label: WEB_SESSION_LABEL, isActive: true },
      data: { isActive: false, revokedAt: new Date() },
    }),
  ]);

  auditSafe({
    actorType: "ADMIN",
    studentId: student.id,
    action: "TEAM_PASSWORD_SET",
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ team: student.subdomain, password });
});

// --- DELETE /admin/teams/:team/password --- disable web login (API keys untouched)
app.delete("/:team/password", async (c) => {
  const student = await findTeam(c.req.param("team"));
  await prisma.$transaction([
    prisma.student.update({ where: { id: student.id }, data: { passwordHash: null } }),
    prisma.apiKey.updateMany({
      where: { studentId: student.id, label: WEB_SESSION_LABEL, isActive: true },
      data: { isActive: false, revokedAt: new Date() },
    }),
  ]);
  return c.json({ success: true });
});

// --- PATCH /admin/teams/:team --- name / recordLimit / isActive
app.patch("/:team", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({
      name: z.string().max(100).optional(),
      recordLimit: z.number().int().min(1).max(100).optional(),
      isActive: z.boolean().optional(),
    })
    .safeParse(body);
  if (!parsed.success) throw invalidRequest("Invalid request body.", parsed.error.flatten());

  const student = await findTeam(c.req.param("team"));
  const updated = await prisma.student.update({
    where: { id: student.id },
    data: parsed.data,
    include: { _count: { select: { records: true } } },
  });

  auditSafe({
    actorType: "ADMIN",
    studentId: student.id,
    action: "STUDENT_UPDATED",
    beforeJson: { name: student.name, recordLimit: student.recordLimit, isActive: student.isActive },
    afterJson: parsed.data,
    ip: getClientIp(c),
    userAgent: getUserAgent(c),
  });

  return c.json({ team: teamView(updated) });
});

export default app;
