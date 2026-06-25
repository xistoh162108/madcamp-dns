# Security Reference

This document describes the threat model, security controls in place, known
limitations, and operational hardening guidance for the DNS Self-Service API.

---

## Threat Model

### Actors

| Actor | Trust Level | Authentication |
|---|---|---|
| Administrator | Full trust | `ADMIN_API_KEY` (env, never stored in DB) |
| Student | Limited trust | Per-student `sk_dns_*` key (SHA-256 hash stored in DB) |
| Unauthenticated | Zero trust | Rejected at middleware |
| Cloudflare (outbound) | Trusted destination | `CLOUDFLARE_API_TOKEN` (env only) |

### What students CAN do

- Create, read, update, and delete DNS records **only under their own subdomain**.
- View their own account info and record list.

### What students CANNOT do

- Access any other student's records (enforced by `studentId` ownership check on every request).
- Create records on the root domain or any path outside their subdomain.
- Discover or use the Cloudflare API token — it never appears in any API response.
- See `cloudflareRecordId` — the internal Cloudflare identifier is stripped from all student responses.
- Create wildcard (`*`) or `_acme-challenge` records.
- Create MX, NS, CAA, SRV, DNSKEY, DS, HTTPS, SVCB records.
- Change a record's type (they must delete and recreate).

---

## Security Controls

### Authentication

**Admin key**
- Stored only in `ADMIN_API_KEY` environment variable.
- Never written to database, logs, or error responses.
- Compared using `crypto.timingSafeEqual` after SHA-256 hashing both sides, so timing
  differences from string-length variation do not leak information.
- Wrong key returns `401 UNAUTHORIZED`, not `403`, to avoid distinguishing "authenticated
  but forbidden" from "not authenticated".

**Student keys**
- Generated with `crypto.randomBytes(32)` — 256 bits of entropy.
- Format: `sk_dns_<64 hex chars>`.
- Only a SHA-256 hash of the raw key is stored in the `ApiKey` table.
- Raw key is shown **exactly once**: at creation or rotation.
- Lookup is by hash, not by prefix — the `keyPrefix` field is display-only.
- Revoked keys (`isActive = false`) are rejected immediately; DB row is kept for audit trail.
- `lastUsedAt` is updated on each use (fire-and-forget, does not block the response).

### DNS Isolation

Every FQDN the API constructs includes the student's assigned subdomain:

```
<relative_name>.<student_subdomain>.<ROOT_DOMAIN>
```

A student with subdomain `alice` submitting name `api` creates `api.alice.example.com`.
They cannot submit names that escape this namespace because:

1. **Blocked character set**: `.` characters between labels are allowed but the
   resulting FQDN is always prefixed with `<relativeName>.<subdomain>.`, so escaping
   upward is structurally impossible.
2. **Blocked names list**: `admin`, `root`, `mail`, `smtp`, `imap`, `ns1`, `ns2`, etc.
   are rejected at the `validateRelativeName` layer before any FQDN is constructed.
3. **Wildcard block**: `*` anywhere in the name is rejected.
4. **`_acme-challenge` block**: Prevents hijacking certificate validation.
5. **Leading underscore block**: Prevents `_dmarc`, `_domainkey`, and similar abuse.

### Content Validation

| Type | Validation |
|---|---|
| A | `net.isIPv4()` — rejects anything that isn't a valid dotted-decimal IPv4 |
| AAAA | `net.isIPv6()` with added `%` check — Node's built-in accepts zone IDs (`::1%eth0`), so we explicitly reject any content containing `%` before calling it |
| CNAME | Must be a valid ASCII hostname; IP addresses explicitly rejected |
| TXT | Max 255 characters; ASCII control characters (0x00-0x08, 0x0B-0x1F, 0x7F) are rejected |
| All | ASCII control characters (null bytes, CR, VT, FF, DEL, etc.) are rejected at the top of `validateRecordContent` before type-specific checks |

### Rate Limiting

Backed by PostgreSQL (`RateLimitLog` table) — no Redis required.

| Scope | Limit |
|---|---|
| Student — all requests | 30 / minute / key |
| Student — write requests (POST, PATCH, DELETE) | 10 / minute / key |
| Admin — all requests | 120 / minute / IP |

`429` responses include `Retry-After` header (RFC 6585) and `retryAfterSeconds` in body.

The rate limit window uses a fixed-window algorithm starting from the first request.
The `RateLimitLog.expiresAt` index enables efficient cleanup.

### Audit Logging

Every write operation (admin and student) records:

- `actorType` — ADMIN or STUDENT
- `actorId` — student ID (for student actions)
- `studentId` — the affected student
- `action` — one of 11 typed actions
- `recordId` — for DNS record changes
- `beforeJson` / `afterJson` — state diff for updates
- `ip` — from `cf-connecting-ip`, `x-forwarded-for`, or `x-real-ip` (in that priority)
- `userAgent`
- `createdAt`

Audit writes are **fire-and-forget** (`auditSafe`). This means a DB failure when writing
the audit row does not cause the primary operation to return an error. Audit failures are
logged to stderr with `[audit]` prefix. Monitor these in production.

### Cloudflare Integration

- The `CLOUDFLARE_API_TOKEN` is read from env, never returned in any response.
- All Cloudflare API calls have a **10-second timeout** — a slow/unresponsive Cloudflare
  API will not hang the Node.js event loop indefinitely.
- Cloudflare `404` on delete is treated as success (idempotent delete).
- If Cloudflare rejects a create, the DB is never written.
- If the DB write fails after a successful Cloudflare create, the Cloudflare record is
  rolled back with a compensating `DELETE` call.

### Request Body Size Limit

All incoming requests are checked against a **64 KB** `Content-Length` limit before any
body parsing occurs. Requests with `Content-Length > 65536` receive an immediate `413`
response without reading the body. This prevents memory exhaustion from malicious large
body attacks.

For defence-in-depth, also configure `client_max_body_size 64k` in nginx (or equivalent
in your reverse proxy) to block oversized requests before they reach Node.js.

### Request IDs

Every response carries `x-request-id`. If the client sends a valid UUID in the request
header, it is echoed back. Non-UUID values are replaced with a server-generated UUID.
This prevents header injection.

### Bearer Token Handling

The `Authorization` header scheme name is compared case-insensitively (RFC 6750 §2.1).
`Bearer`, `bearer`, and `BEARER` are all accepted. The token value itself is used as-is
(tokens are hashed before DB lookup, so case matters for the token).

### Process-Level Safety Nets

`uncaughtException` and `unhandledRejection` handlers log a `[fatal]` line to stderr and
call `process.exit(1)`. This ensures Docker/systemd restarts the container instead of leaving
the process alive in an unknown state.

### Record Limit Enforcement (TOCTOU-safe)

`POST /v1/records` does an optimistic count check before the Cloudflare call, then re-checks
the count inside a `prisma.$transaction()` before the DB insert. This closes the race window
where two concurrent POSTs could both pass the optimistic check and both create records,
exceeding the student's `recordLimit`.

### Error Responses

- Stack traces are never returned to clients.
- Cloudflare error details (from `body.errors`) are included in `502` responses — these
  are Cloudflare's own user-facing messages and do not contain credentials.
- `INTERNAL_ERROR` (500) responses return only a generic message.
- Prisma `P2002` unique constraint violations (e.g. from concurrent student creation)
  are caught and returned as `400 INVALID_REQUEST`, not `500`.

---

## Known Limitations and Trade-offs

### PostgreSQL-backed rate limiting

Using the DB for rate limiting means a burst of concurrent requests will hit Postgres.
Under very high load, the `upsert` approach (atomic `INSERT ... ON CONFLICT DO UPDATE`)
is safe but adds DB round-trips per request. For high-traffic deployments, migrate to
Redis with `INCR` + `EXPIRE`.

### No PATCH revert on Cloudflare-then-DB inconsistency

`PATCH /v1/records/:id` calls Cloudflare first, then updates the DB. If the DB update
fails (extremely unlikely — disk full, connection lost mid-transaction), the record in
Cloudflare and the DB are momentarily inconsistent. The mismatch is self-healing on the
next admin force-delete + recreate. For full consistency, implement a saga or use
optimistic concurrency with a version field.

### test-keys are real accounts

Students created via `POST /admin/test-keys` behave identically to real students. Their
keys expire when revoked and they can create live DNS records. Clean them up after testing.

### Admin key is a single shared secret

There is one admin key for the entire system. For multi-admin setups, rotate the key and
distribute it securely. There is no per-admin audit trail — all admin actions show
`actorType: "ADMIN"` without further attribution.

### Audit log failures are silent to clients

A client that gets a `201 Created` for a new DNS record may not have a corresponding audit
entry if the audit DB write failed. Monitor `[audit]` log lines in stderr.

---

## Operational Hardening Checklist

### Deployment

- [ ] Set `POSTGRES_PASSWORD` to a strong random password (not the example default).
- [ ] Never commit `.env` — only `.env.example` belongs in version control.
- [ ] Remove the `ports: - "127.0.0.1:5432:5432"` line from docker-compose in production.
- [ ] Place a TLS-terminating reverse proxy (nginx, Caddy, Cloudflare Tunnel) in front
      of the API — the server itself runs plain HTTP.
- [ ] Restrict inbound traffic to port 3000 by firewall rule (only allow the reverse proxy).
- [ ] Set `ADMIN_API_KEY` to at least 32 random bytes (e.g. `openssl rand -hex 32`).
- [ ] Use a Cloudflare API token scoped to a single zone with only `Zone → DNS → Edit`.

### Monitoring

- [ ] Monitor `[audit]` lines in stderr — unexpected frequency may indicate DB issues.
- [ ] Monitor `[rate-limit cleanup]` errors.
- [ ] Watch for `[unhandled error]` lines — these are bugs.
- [ ] Set up alerting on HTTP 502 rate — sustained 502s mean Cloudflare API is unreachable.
- [ ] Monitor `/health` endpoint from an external probe.

### Rotation

- [ ] Rotate `ADMIN_API_KEY` by setting a new value and restarting the API. No DB changes needed.
- [ ] Rotate a student key via `POST /admin/students/:id/rotate-key`.
- [ ] Rotate `CLOUDFLARE_API_TOKEN` by creating a new token in Cloudflare, updating env, restarting.

### Cloudflare Token Permissions (Minimum Required)

Create the token at: Cloudflare Dashboard → My Profile → API Tokens → Create Token

Use the **"Edit zone DNS"** template, then restrict to:
- **Permissions**: `Zone → DNS → Edit`
- **Zone Resources**: Include → Specific zone → (your zone only)
- **IP Filtering** (optional): Restrict to your server's egress IP

Do **not** grant:
- Account-level permissions
- Zone Settings Edit
- Firewall / WAF
- Workers / Pages
