-- Migration: add missing performance indexes and AuditLog.action index
-- These indexes existed in the original migration SQL but were absent from
-- schema.prisma, causing schema/migration drift. This migration is idempotent
-- (IF NOT EXISTS) so it is safe to apply even if some indexes already exist.

-- ApiKey: look up keys by student (already in 0001 but schema was missing @@index)
CREATE INDEX IF NOT EXISTS "ApiKey_studentId_idx" ON "ApiKey"("studentId");

-- DnsRecord: ordered list by student (for GET /v1/records sorted by createdAt)
CREATE INDEX IF NOT EXISTS "DnsRecord_studentId_idx" ON "DnsRecord"("studentId");
CREATE INDEX IF NOT EXISTS "DnsRecord_studentId_createdAt_idx" ON "DnsRecord"("studentId", "createdAt" DESC);

-- RateLimitLog: efficient expiry cleanup (background interval + per-request deleteMany)
CREATE INDEX IF NOT EXISTS "RateLimitLog_expiresAt_idx" ON "RateLimitLog"("expiresAt");

-- AuditLog: admin query filters (studentId, actorId, action) + pagination (createdAt DESC)
CREATE INDEX IF NOT EXISTS "AuditLog_studentId_idx" ON "AuditLog"("studentId");
CREATE INDEX IF NOT EXISTS "AuditLog_actorId_idx" ON "AuditLog"("actorId");
CREATE INDEX IF NOT EXISTS "AuditLog_action_idx" ON "AuditLog"("action");
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt" DESC);
