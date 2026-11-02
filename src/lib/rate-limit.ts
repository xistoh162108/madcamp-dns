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

// Web UI sessions load several endpoints per screen refresh, so they get a
// larger read budget. Writes stay tight. API-key limits are unchanged.
const WEB_TOTAL: RateLimitConfig = { limit: 120, windowSeconds: 60 };
const WEB_WRITE: RateLimitConfig = { limit: 30, windowSeconds: 60 };

export async function checkStudentRateLimit(keyHash: string, method: string, webSession = false): Promise<void> {
  await checkBucket(keyHash, "total", webSession ? WEB_TOTAL : STUDENT_TOTAL);
  if (WRITE_METHODS.has(method.toUpperCase())) {
    await checkBucket(keyHash, "write", webSession ? WEB_WRITE : STUDENT_WRITE);
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

// Web-UI password login: tight per-IP bucket to slow down password guessing.
// Generous enough for a room of teams behind one NAT'd IP logging in at once.
const LOGIN_TOTAL: RateLimitConfig = { limit: 20, windowSeconds: 60 };

// Per-account bucket so one account can't be brute-forced from many IPs.
const LOGIN_PER_ACCOUNT: RateLimitConfig = { limit: 10, windowSeconds: 15 * 60 };

export async function checkLoginRateLimit(ip: string): Promise<void> {
  await checkBucket(`login:${ip}`, "total", LOGIN_TOTAL);
}

// Failure lockouts. Only failures are counted, so legitimate successful use
// (a team whose members log in often) never trips them.
// Compared in SQL: expiresAt is written with NOW() by checkBucket, so it must
// be read against the DB clock, not the Node clock.
async function assertNotLocked(key: string, config: RateLimitConfig): Promise<void> {
  const rows = await prisma.$queryRaw<{ retry: number }[]>`
    SELECT CEIL(EXTRACT(EPOCH FROM ("expiresAt" - NOW())))::int AS retry
    FROM "RateLimitLog"
    WHERE "keyHash" = ${key} AND "bucket" = 'fail'
      AND "expiresAt" > NOW() AND "count" >= ${config.limit}
  `;
  if (rows.length) {
    throw rateLimited(config.limit, config.windowSeconds, Math.max(1, rows[0].retry));
  }
}

async function recordFailure(key: string, config: RateLimitConfig): Promise<void> {
  await checkBucket(key, "fail", { ...config, limit: Number.MAX_SAFE_INTEGER });
}

export const assertAccountNotLocked = (account: string) => assertNotLocked(`login-acct:${account}`, LOGIN_PER_ACCOUNT);
export const recordFailedLogin = (account: string) => recordFailure(`login-acct:${account}`, LOGIN_PER_ACCOUNT);

// Wrong admin keys: 10 per IP per 15 minutes, then that IP is locked out of
// /admin/* until the window ends (the normal 120/min admin limit still applies).
const ADMIN_FAILURES: RateLimitConfig = { limit: 10, windowSeconds: 15 * 60 };
export const assertAdminNotLocked = (ip: string) => assertNotLocked(`admin-fail:${ip}`, ADMIN_FAILURES);
export const recordAdminFailure = (ip: string) => recordFailure(`admin-fail:${ip}`, ADMIN_FAILURES);
