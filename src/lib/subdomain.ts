import type { Prisma } from "@prisma/client";
import { validateSubdomainName } from "./validate-dns.js";
import { invalidRequest } from "./errors.js";

type Tx = Prisma.TransactionClient;

// Arbitrary fixed int32 "class ID" for subdomain-claim advisory locks.
// Namespaces these locks away from any other advisory-lock usage, present or
// future, so a collision with an unrelated lock elsewhere is impossible.
const LOCK_NAMESPACE = 84_213_001;

/**
 * Acquire a transaction-scoped Postgres advisory lock keyed by the subdomain
 * string. Blocks until acquired (bounded by DATABASE_URL's statement_timeout
 * for the enclosing transaction) and auto-releases at commit/rollback — no
 * schema change required, and it only serializes claims on the *same*
 * subdomain string.
 *
 * Two different creation paths (admin create/bulk/test-keys, student claim,
 * student release + record create) all lock on this same key so whichever
 * transaction commits first wins and the loser re-reads fresh state instead
 * of racing past a stale check. Must be called inside the same transaction
 * that performs the subsequent check-then-write.
 */
export async function lockSubdomain(tx: Tx, subdomain: string): Promise<void> {
  // Explicit ::int casts: Prisma sends untyped numeric params as bigint by
  // default, but Postgres's two-arg pg_advisory_xact_lock overload takes
  // (int, int) — without the cast, Postgres can't resolve an overload and
  // throws "function pg_advisory_xact_lock(bigint, integer) does not exist".
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int, hashtext(${subdomain})::int)`;
}

/**
 * Lock multiple subdomains for one transaction. Callers MUST pass a
 * deterministically sorted array so two concurrent multi-subdomain
 * transactions with overlapping sets always acquire locks in the same
 * order, avoiding a lock-ordering deadlock.
 */
export async function lockSubdomains(tx: Tx, subdomains: string[]): Promise<void> {
  for (const s of [...subdomains].sort()) {
    await lockSubdomain(tx, s);
  }
}

/**
 * Format + blocklist + cross-table availability check for a subdomain
 * string. `Student.subdomain` and `OwnedSubdomain.subdomain` are two
 * independently-unique columns in two different tables with no DB-level
 * constraint spanning both, so this check (plus the caller holding
 * lockSubdomain for the same string within the same transaction) is what
 * actually prevents two different students from ending up owning the same
 * subdomain string.
 */
export async function assertSubdomainAvailable(tx: Tx, subdomain: string): Promise<void> {
  validateSubdomainName(subdomain);

  const [takenByStudent, takenByOwned] = await Promise.all([
    tx.student.findFirst({ where: { subdomain }, select: { id: true } }),
    tx.ownedSubdomain.findFirst({ where: { subdomain }, select: { id: true } }),
  ]);
  if (takenByStudent) {
    throw invalidRequest(`The subdomain "${subdomain}" is already taken.`);
  }
  if (takenByOwned) {
    throw invalidRequest(`The subdomain "${subdomain}" is already claimed by a student as an additional subdomain.`);
  }
}
