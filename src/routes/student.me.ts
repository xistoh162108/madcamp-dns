import { Hono } from "hono";
import { requireStudent, type StudentContext } from "../lib/auth.js";
import { checkStudentRateLimit } from "../lib/rate-limit.js";

const app = new Hono<{ Variables: { auth: StudentContext } }>();

// --- Middleware: auth + rate limit ---
app.use("*", async (c, next) => {
  const auth = await requireStudent(c);
  await checkStudentRateLimit(auth.apiKey.keyHash, c.req.method);
  c.set("auth", auth);
  await next();
});

// --- GET /v1/me ---
app.get("/", async (c) => {
  const { student } = c.get("auth");
  const rootDomain = process.env.ROOT_DOMAIN!;

  return c.json({
    student: {
      email: student.email,
      name: student.name,
      subdomain: `${student.subdomain}.${rootDomain}`,
      recordLimit: student.recordLimit,
      isActive: student.isActive,
    },
  });
});

export default app;
