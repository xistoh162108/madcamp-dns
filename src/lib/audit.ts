import { prisma } from "../db/prisma.js";
import { Prisma } from "@prisma/client";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

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
  | "SUBDOMAIN_RELEASED"
  | "TUNNEL_CREATED"
  | "TUNNEL_HOSTNAME_CREATED"
  | "TUNNEL_HOSTNAME_DELETED"
  | "ADMIN_TUNNEL_HOSTNAME_DELETED"
  | "TUNNEL_DELETED";

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

// Trust order (safest first):
//   1. CF-Connecting-IP — only when TRUST_CF_CONNECTING_IP=true, i.e. once
//      confirmed the zone is actually orange-cloud-proxied through Cloudflare.
//      Otherwise this header is entirely client-settable and would let an
//      attacker bypass admin rate limiting and forge audit log IPs.
//   2. X-Real-IP — safe default. nginx's documented vhost (see DEPLOYMENT.md)
//      sets this unconditionally to $remote_addr, so a client can never
//      override it past nginx.
//   3. Raw TCP socket peer address (via Hono's Node conninfo helper) — never
//      attacker-controlled, used when running with no reverse proxy at all
//      (e.g. local dev) or if X-Real-IP is unexpectedly absent.
// X-Forwarded-For is deliberately NOT trusted: nginx's $proxy_add_x_forwarded_for
// *appends* to any client-supplied value rather than replacing it, so its
// first entry is attacker-controlled.
export function getClientIp(c: Context): string {
  if (process.env.TRUST_CF_CONNECTING_IP === "true") {
    const cfIp = c.req.header("cf-connecting-ip");
    if (cfIp) return cfIp;
  }

  const realIp = c.req.header("x-real-ip");
  if (realIp) return realIp;

  try {
    const socketAddress = getConnInfo(c).remote.address;
    if (socketAddress) return socketAddress;
  } catch {
    // getConnInfo can throw outside a real Node request context (e.g. unit tests).
  }

  return "unknown";
}

export function getUserAgent(c: Context): string {
  return c.req.header("user-agent") ?? "unknown";
}
