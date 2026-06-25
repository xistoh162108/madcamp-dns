import { PrismaClient } from "@prisma/client";

// Prisma connection pool size is controlled via DATABASE_URL parameter:
//   ?connection_limit=10
// Statement timeout is best set via the DB connection parameter in DATABASE_URL:
//   ?options=-c%20statement_timeout%3D5000
//
// For Docker Compose the full URL is set in docker-compose.yml.
// Prisma does not support per-query timeouts natively — use pgbouncer or
// the DB-level statement_timeout for long-query protection.

function createPrismaClient() {
  return new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });
}

// Module-level singleton — one connection pool per process.
// The globalThis pattern is NOT used here because this server is single-process
// (no hot-reload in production, no Next.js edge cases).
export const prisma = createPrismaClient();
