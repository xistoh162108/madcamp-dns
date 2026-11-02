-- Web UI login: optional password per Student, expiring session keys on ApiKey.
-- Additive and nullable, so existing rows and API-key users are unaffected.
ALTER TABLE "Student" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
