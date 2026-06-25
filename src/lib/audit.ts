import { prisma } from "../db/prisma.js";
import { Prisma } from "@prisma/client";
import type { Context } from "hono";

export type AuditAction =
  | "STUDENT_CREATED"
  | "STUDENTS_BULK_CREATED"
  | "TEST_KEYS_CREATED"
  | "API_KEY_CREATED"
  | "API_KEY_ROTATED"
  | "API_KEY_REVOKED"
  | "STUDENT_UPDATED"
  | "ADMIN_RECORD_DELETED"
  | "DNS_RECORD_CREATED"
  | "DNS_RECORD_UPDATED"
  | "DNS_RECORD_DELETED"
  | "SUBDOMAIN_CLAIMED"
  | "SUBDOMAIN_RELEASED";

export interface AuditParams {
  actorType: "ADMIN" | "STUDENT";
  actorId?: string;
  studentId?: string;
  action: AuditAction;
  recordId?: string;
  beforeJson?: Record<string, unknown>;
  afterJson?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

export async function audit(params: AuditParams): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorType: params.actorType,
      actorId: params.actorId ?? null,
      studentId: params.studentId ?? null,
      action: params.action,
      recordId: params.recordId ?? null,
      beforeJson: (params.beforeJson ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      afterJson: (params.afterJson ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
    },
  });
}

/**
 * Fire-and-forget audit. Use this after the primary operation has already
 * committed so that an audit DB failure doesn't roll back a successful write
 * or return a 500 to the client. Failures are logged to stderr.
 */
export function auditSafe(params: AuditParams): void {
  audit(params).catch((err) => {
    console.error("[audit] Failed to write audit log:", {
      action: params.action,
      actorType: params.actorType,
      studentId: params.studentId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export function getClientIp(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown"
  );
}

export function getUserAgent(c: Context): string {
  return c.req.header("user-agent") ?? "unknown";
}
