import { Hono } from "hono";
import { requireStudent } from "../lib/auth.js";
import { checkStudentRateLimit } from "../lib/rate-limit.js";

const app = new Hono();

// --- GET /v1/me ---
app.get("/", async (c) => {
  const auth = await requireStudent(c);
  await checkStudentRateLimit(auth.apiKey.keyHash, c.req.method);

  const { student } = auth;
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
