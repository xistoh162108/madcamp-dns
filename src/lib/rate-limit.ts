import { prisma } from "../db/prisma.js";
import { rateLimited } from "./errors.js";

interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
}

const STUDENT_TOTAL: RateLimitConfig = { limit: 30, windowSeconds: 60 };
const STUDENT_WRITE: RateLimitConfig = { limit: 10, windowSeconds: 60 };
const ADMIN_TOTAL: RateLimitConfig = { limit: 120, windowSeconds: 60 };
// Coarse, IP-keyed circuit-breaker applied to /v1/* BEFORE credentials are
// checked. requireStudent() does a DB findUnique for every request — without
// this, an attacker sending garbage bearer tokens (no valid key needed) can
// hammer the DB with unlimited lookups, since per-key rate limiting only
// starts once a *valid* key hash is known. Deliberately generous: a whole
// class sharing one NAT'd campus IP doing light polling must never be
// clipped by this. It is a backstop in front of the DB, not a replacement
// for the STUDENT_TOTAL/STUDENT_WRITE buckets above, which still apply
// per-key after auth succeeds.
const PRE_AUTH_TOTAL: RateLimitConfig = { limit: 300, windowSeconds: 60 };

const WRITE_METHODS = new Set(["POST", "PATCH", "DELETE"]);

/**
 * Single-round-trip rate limit check.
 *
 * Uses a raw INSERT ... ON CONFLICT DO UPDATE that atomically handles both
 * window expiry (resets count to 1) and increment in one DB statement — down
 * from the previous two-statement pattern (deleteMany + upsert = 2 RT).
 *
 * Logic:
 *   - If no row exists:        INSERT count=1, expiresAt=now+window
 *   - If row exists and FRESH: increment count, keep expiresAt
 *   - If row exists and STALE: reset count=1, reset expiresAt=now+window
 */
async function checkBucket(keyHash: string, bucket: string, config: RateLimitConfig): Promise<void> {
  const windowMs = config.windowSeconds * 1000;

  type Row = { count: number; expires_at: Date };
  const rows = await prisma.$queryRaw<Row[]>`
    INSERT INTO "RateLimitLog" ("id", "keyHash", "bucket", "count", "expiresAt")
    VALUES (
      gen_random_uuid()::text,
      ${keyHash},
      ${bucket},
      1,
      NOW() + (${windowMs} * INTERVAL '1 millisecond')
    )
    ON CONFLICT ("keyHash", "bucket") DO UPDATE
      SET
        "count"     = CASE
                        WHEN "RateLimitLog"."expiresAt" <= NOW() THEN 1
                        ELSE "RateLimitLog"."count" + 1
                      END,
        "expiresAt" = CASE
                        WHEN "RateLimitLog"."expiresAt" <= NOW()
                          THEN NOW() + (${windowMs} * INTERVAL '1 millisecond')
                        ELSE "RateLimitLog"."expiresAt"
                      END
    RETURNING "count", "expiresAt" AS expires_at
  `;

  const row = rows[0];
  if (!row) throw new Error("Rate limit check returned no row");

  if (row.count > config.limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 1000)
    );
    throw rateLimited(config.limit, config.windowSeconds, retryAfterSeconds);
  }
}

export async function checkStudentRateLimit(keyHash: string, method: string): Promise<void> {
  await checkBucket(keyHash, "total", STUDENT_TOTAL);
  if (WRITE_METHODS.has(method.toUpperCase())) {
    await checkBucket(keyHash, "write", STUDENT_WRITE);
  }
}

export async function checkAdminRateLimit(ip: string): Promise<void> {
  // "admin:" prefix can never collide with a SHA-256 hex hash (which uses only 0-9a-f)
  const keyHash = `admin:${ip}`;
  await checkBucket(keyHash, "total", ADMIN_TOTAL);
}

export async function checkPreAuthRateLimit(ip: string): Promise<void> {
  // "preauth:" prefix can't collide with a SHA-256 hex hash or the "admin:" prefix.
  const keyHash = `preauth:${ip}`;
  await checkBucket(keyHash, "total", PRE_AUTH_TOTAL);
}

export async function cleanupExpiredRateLimits(): Promise<void> {
  await prisma.rateLimitLog.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
}
