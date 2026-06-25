import { timingSafeEqual, createHash } from "crypto";
import type { Context } from "hono";
import { prisma } from "../db/prisma.js";
import { hashApiKey } from "./api-key.js";
import {
  unauthorized,
  apiKeyRevoked,
  studentDisabled,
} from "./errors.js";
import type { Student, ApiKey } from "@prisma/client";

export interface AdminContext {
  type: "admin";
}

export interface StudentContext {
  type: "student";
  student: Student;
  apiKey: ApiKey;
}

export type AuthContext = AdminContext | StudentContext;

export function extractBearerToken(c: Context): string | null {
  const auth = c.req.header("Authorization");
  if (!auth) return null;
  // RFC 6750: scheme name is case-insensitive ("Bearer", "bearer", "BEARER" all valid)
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice(7).trim() || null;
}

export async function requireAdmin(c: Context): Promise<AdminContext> {
  const token = extractBearerToken(c);
  if (!token) throw unauthorized();

  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) throw unauthorized("Admin API key not configured.");

  // Hash both sides first so lengths are always 32 bytes — no padding needed.
  const tokenHash = createHash("sha256").update(token).digest();
  const adminHash = createHash("sha256").update(adminKey).digest();
  if (!timingSafeEqual(tokenHash, adminHash)) throw unauthorized("Missing or invalid API key.");

  return { type: "admin" };
}

export async function requireStudent(c: Context): Promise<StudentContext> {
  const token = extractBearerToken(c);
  if (!token) throw unauthorized();

  const hash = hashApiKey(token);

  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash: hash },
    include: { student: true },
  });

  if (!apiKey) throw unauthorized();
  if (!apiKey.isActive) throw apiKeyRevoked();
  if (!apiKey.student.isActive) throw studentDisabled();

  // Update lastUsedAt without blocking the response
  prisma.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { type: "student", student: apiKey.student, apiKey };
}
