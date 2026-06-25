# DNS Self-Service API

A production-ready DNS management API that lets an administrator issue API keys to students, and lets each student create, list, update, and delete only their own DNS records — proxied through Cloudflare. Students never receive or use Cloudflare API tokens.

**→ [Security Reference](SECURITY.md)** | **→ [Deployment Guide](DEPLOYMENT.md)**

## Stack

- **TypeScript** + **Hono** (server)
- **Prisma** + **PostgreSQL** (database)
- **Zod** (validation)
- **Docker** (deployment)

---

## Environment Setup

```bash
cp .env.example .env
# Edit .env with your actual values
```

Required variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `ROOT_DOMAIN` | Root domain (e.g. `example.com`) |
| `PUBLIC_BASE_URL` | Public URL of this API |
| `CLOUDFLARE_ZONE_ID` | Cloudflare Zone ID |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token (see below) |
| `ADMIN_API_KEY` | Secret admin bearer token |

---

## Cloudflare Token Permissions

Create a Cloudflare API Token with **least-privilege** permissions:

1. Go to Cloudflare Dashboard → My Profile → API Tokens → Create Token
2. Use **Edit zone DNS** template
3. Set **Zone Resources** → Include → Specific zone → your zone
4. Required permissions:
   - `Zone → DNS → Edit`
5. Do **not** grant account-level or firewall permissions

---

## Install and Run (local)

```bash
npm install
npx prisma generate

# Apply migrations
npx prisma migrate deploy

# Development (hot reload)
npm run dev

# Production build
npm run build
npm start
```

---

## Docker Build and Run

```bash
# Build image
docker build -t dns-api .

# Run with compose (starts PostgreSQL + API)
cp .env.example .env   # fill in ALL required values including POSTGRES_PASSWORD
docker compose up -d

# View logs
docker compose logs -f api

# Stop
docker compose down
```

For cloud deployments (Railway, Fly.io, AWS ECS, GCP Cloud Run) see [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Prisma Migration Commands

```bash
# Create a new migration (dev only)
npm run db:migrate:dev -- --name <migration_name>

# Apply pending migrations (production)
npm run db:migrate

# Open Prisma Studio (GUI browser)
npm run db:studio
```

---

## Admin API

All admin endpoints require:

```
Authorization: Bearer <ADMIN_API_KEY>
```

### Create one student

```bash
curl -s -X POST http://localhost:3000/admin/students \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice@example.com",
    "name": "Alice",
    "subdomain": "alice",
    "recordLimit": 10
  }' | jq .
```

Response — the raw API key is shown **only once**:

```json
{
  "student": {
    "id": "...",
    "email": "alice@example.com",
    "name": "Alice",
    "subdomain": "alice.example.com",
    "recordLimit": 10,
    "isActive": true,
    "createdAt": "..."
  },
  "apiKey": "sk_dns_..."
}
```

---

### Bulk-create students

```bash
curl -s -X POST http://localhost:3000/admin/students/bulk \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "students": [
      { "email": "alice@example.com", "name": "Alice", "subdomain": "alice" },
      { "email": "bob@example.com",   "name": "Bob",   "subdomain": "bob"   }
    ],
    "recordLimit": 10
  }' | jq .
```

---

### Create test students and keys

```bash
curl -s -X POST http://localhost:3000/admin/test-keys \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "count": 2, "recordLimit": 10 }' | jq .
```

---

### List all students

```bash
curl -s http://localhost:3000/admin/students \
  -H "Authorization: Bearer $ADMIN_KEY" | jq .

# With pagination
curl -s "http://localhost:3000/admin/students?page=1&limit=20" \
  -H "Authorization: Bearer $ADMIN_KEY" | jq .
```

---

### Get one student

```bash
curl -s http://localhost:3000/admin/students/<student_id> \
  -H "Authorization: Bearer $ADMIN_KEY" | jq .
```

---

### Update student (change recordLimit, activate/deactivate)

```bash
curl -s -X PATCH http://localhost:3000/admin/students/<student_id> \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "recordLimit": 20, "isActive": true }' | jq .
```

---

### List API keys for a student

```bash
curl -s http://localhost:3000/admin/students/<student_id>/api-keys \
  -H "Authorization: Bearer $ADMIN_KEY" | jq .
```

---

### Issue an additional API key for a student

```bash
curl -s -X POST http://localhost:3000/admin/students/<student_id>/api-keys \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "label": "lab-machine" }' | jq .
```

---

### Rotate a student's key (revokes all active keys, issues one new key)

```bash
curl -s -X POST http://localhost:3000/admin/students/<student_id>/rotate-key \
  -H "Authorization: Bearer $ADMIN_KEY" | jq .
```

---

### Revoke a specific API key

```bash
curl -s -X DELETE \
  http://localhost:3000/admin/students/<student_id>/api-keys/<key_id> \
  -H "Authorization: Bearer $ADMIN_KEY" | jq .
```

---

### List all DNS records (admin view, includes cloudflareRecordId)

```bash
curl -s http://localhost:3000/admin/records \
  -H "Authorization: Bearer $ADMIN_KEY" | jq .

# Filter by student
curl -s "http://localhost:3000/admin/records?studentId=<student_id>" \
  -H "Authorization: Bearer $ADMIN_KEY" | jq .
```

---

### Force-delete a DNS record

```bash
curl -s -X DELETE http://localhost:3000/admin/records/<record_id> \
  -H "Authorization: Bearer $ADMIN_KEY" | jq .
```

---

### View audit logs

```bash
curl -s http://localhost:3000/admin/audit-logs \
  -H "Authorization: Bearer $ADMIN_KEY" | jq .

# Filter by student or action
curl -s "http://localhost:3000/admin/audit-logs?studentId=<id>&action=DNS_RECORD_CREATED" \
  -H "Authorization: Bearer $ADMIN_KEY" | jq .
```

---

## Student API

All student endpoints require the per-student key issued by the admin:

```
Authorization: Bearer sk_dns_...
```

### View my account

```bash
curl -s http://localhost:3000/v1/me \
  -H "Authorization: Bearer $STUDENT_KEY" | jq .
```

---

### List my DNS records

```bash
curl -s http://localhost:3000/v1/records \
  -H "Authorization: Bearer $STUDENT_KEY" | jq .
```

---

### Create an A record

```bash
curl -s -X POST http://localhost:3000/v1/records \
  -H "Authorization: Bearer $STUDENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "api",
    "type": "A",
    "content": "203.0.113.10",
    "proxied": true,
    "ttl": 1
  }' | jq .
```

The server constructs the FQDN: `api.alice.example.com`

---

### Create a CNAME record

```bash
curl -s -X POST http://localhost:3000/v1/records \
  -H "Authorization: Bearer $STUDENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "www",
    "type": "CNAME",
    "content": "myapp.netlify.app",
    "proxied": false,
    "ttl": 300
  }' | jq .
```

---

### Create a TXT record

```bash
curl -s -X POST http://localhost:3000/v1/records \
  -H "Authorization: Bearer $STUDENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "verify",
    "type": "TXT",
    "content": "v=spf1 include:example.com ~all",
    "proxied": false,
    "ttl": 300
  }' | jq .
```

---

### Update a record (name, content, ttl, proxied only — type is immutable)

```bash
curl -s -X PATCH http://localhost:3000/v1/records/<record_id> \
  -H "Authorization: Bearer $STUDENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "203.0.113.20",
    "proxied": false
  }' | jq .
```

---

### Delete a record

```bash
curl -s -X DELETE http://localhost:3000/v1/records/<record_id> \
  -H "Authorization: Bearer $STUDENT_KEY" | jq .
```

---

## Health Check

```bash
curl -s http://localhost:3000/health | jq .
```

---

## Domain Policy

- Each student owns exactly one subdomain (e.g. `alice.example.com`).
- Students submit only the **relative** record name (e.g. `api`, `www`, `v1.api`).
- The server constructs the full FQDN: `<name>.<subdomain>.<ROOT_DOMAIN>`.
- Students can never create records outside their own subdomain.

### Allowed record types

`A`, `AAAA`, `CNAME`, `TXT`

### Blocked names

`*`, `@`, `_acme-challenge`, `admin`, `root`, `mail`, `smtp`, `imap`, `ns1`, `ns2`, and others.

---

## Rate Limits

| Actor | Limit |
|---|---|
| Student — total | 30 req/min per key |
| Student — writes (POST/PATCH/DELETE) | 10 req/min per key |
| Admin | 120 req/min per IP |

Rate-limited responses return HTTP 429:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Try again later.",
    "details": {
      "limit": 10,
      "windowSeconds": 60,
      "retryAfterSeconds": 60
    }
  }
}
```

---

## Security Notes

- **Cloudflare token never leaves the server.** Students cannot discover it through any API response.
- **Cloudflare record IDs are hidden from students.** Only admins see them.
- **Student API keys are hashed (SHA-256) before storage.** Raw keys are shown only once, at creation or rotation.
- **Admin key is never stored in the database.** It is compared in constant time from the environment.
- **All inputs are validated with Zod** before reaching business logic.
- **Wildcard and `_acme-challenge` names are blocked** to prevent certificate hijacking.
- **CNAME / A / AAAA coexistence is rejected** to prevent DNS ambiguity.
- **Audit logs** capture all writes with before/after state, actor, IP, and user-agent.
- **Record type is immutable** after creation. Delete and recreate to change type.
- **Each student's record limit** is enforced before any Cloudflare call.
- **Request IDs** (`x-request-id`) are attached to every response for tracing.

---

## Error Codes

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_REQUEST` | 400 | Malformed or missing fields |
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `API_KEY_REVOKED` | 401 | Key was revoked |
| `STUDENT_DISABLED` | 403 | Student account disabled |
| `FORBIDDEN` | 403 | Action not permitted |
| `FORBIDDEN_RECORD` | 403 | Record belongs to another student |
| `NOT_FOUND` | 404 | Resource not found |
| `INVALID_RECORD_NAME` | 400 | Blocked or malformed record name |
| `UNSUPPORTED_RECORD_TYPE` | 400 | Type not in A/AAAA/CNAME/TXT |
| `INVALID_RECORD_CONTENT` | 400 | Content fails type-specific validation |
| `DNS_RECORD_CONFLICT` | 409 | CNAME+A/AAAA conflict or duplicate |
| `RECORD_LIMIT_EXCEEDED` | 403 | Student has hit their record quota |
| `RATE_LIMITED` | 429 | Too many requests |
| `CLOUDFLARE_ERROR` | 502 | Cloudflare rejected the change |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
