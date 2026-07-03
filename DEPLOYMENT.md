# Deployment Guide

---

## Option 1: Docker Compose (Recommended for single-server)

Runs the API and PostgreSQL in containers on one machine.

### Prerequisites

- Docker Engine 24+ and Docker Compose plugin
- A domain with Cloudflare DNS
- A reverse proxy for TLS (nginx, Caddy, or Cloudflare Tunnel)

### Steps

```bash
# 1. Clone and enter the project
cd dns-api

# 2. Create your env file
cp .env.example .env
# Edit .env — fill in all required values:
#   POSTGRES_PASSWORD, ROOT_DOMAIN, CLOUDFLARE_ZONE_ID,
#   CLOUDFLARE_API_TOKEN, ADMIN_API_KEY

# 3. Build and start
docker compose up -d

# 4. Follow logs
docker compose logs -f api

# 5. Verify
curl http://localhost:3000/health
```

### Applying schema migrations

Migrations run automatically on every container start via
`prisma migrate deploy` in the CMD. To run them manually:

```bash
docker compose exec api node_modules/.bin/prisma migrate deploy
```

### Updating

```bash
git pull
docker compose build api
docker compose up -d api   # rolling restart
```

---

## Option 2: Bare Metal / VM (Node.js directly)

### Prerequisites

- Node.js 20+
- PostgreSQL 14+ running and accessible
- A process manager (PM2 or systemd)

### Steps

```bash
# Install dependencies
npm ci

# Generate Prisma client
npx prisma generate

# Apply migrations (DATABASE_URL must be set)
npx prisma migrate deploy

# Build
npm run build

# Start
NODE_ENV=production node dist/index.js
```

### PM2 example

```bash
npm install -g pm2

pm2 start dist/index.js \
  --name dns-api \
  --env production \
  -- --max-old-space-size=256

pm2 save
pm2 startup   # generate systemd/init.d startup script
```

`ecosystem.config.cjs` example:

```js
module.exports = {
  apps: [{
    name: 'dns-api',
    script: 'dist/index.js',
    instances: 1,       // keep at 1 unless you add a Redis-backed rate limiter
    exec_mode: 'fork',
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
  }],
};
```

> **Note:** Running multiple instances with `exec_mode: cluster` requires moving
> rate limiting to Redis, because each instance has its own `setInterval` cleanup
> and the PG upsert counter is shared (which is fine), but the cleanup timer
> would fire on every instance simultaneously.

### systemd unit file

```ini
[Unit]
Description=DNS Self-Service API
After=network.target postgresql.service

[Service]
Type=simple
User=nodejs
WorkingDirectory=/opt/dns-api
EnvironmentFile=/opt/dns-api/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dns-api

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable dns-api
sudo systemctl start dns-api
sudo journalctl -u dns-api -f
```

---

## Option 3: Cloud Container Platforms

### Railway

1. Connect your GitHub repo.
2. Add a PostgreSQL service — Railway gives you a `DATABASE_URL`.
3. Set all env vars in the Railway dashboard.
4. Railway auto-builds the Dockerfile and runs migrations on start.
5. Assign a custom domain and enable "Generate Certificate" for TLS.

### Fly.io

```bash
fly launch --dockerfile Dockerfile --no-deploy
# Set secrets:
fly secrets set \
  DATABASE_URL="..." \
  ROOT_DOMAIN="example.com" \
  CLOUDFLARE_ZONE_ID="..." \
  CLOUDFLARE_API_TOKEN="..." \
  ADMIN_API_KEY="$(openssl rand -hex 32)"

fly postgres create --name dns-api-db
fly postgres attach dns-api-db

fly deploy
fly status
```

`fly.toml` example:

```toml
app = "dns-api"
primary_region = "nrt"   # Tokyo — change to suit

[build]
dockerfile = "Dockerfile"

[http_service]
internal_port = 3000
force_https = true
auto_stop_machines = false

[[vm]]
memory = "512mb"
cpu_kind = "shared"
cpus = 1
```

### AWS ECS / Fargate

1. Push image to ECR:
   ```bash
   aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
   docker build -t dns-api .
   docker tag dns-api:latest <account>.dkr.ecr.<region>.amazonaws.com/dns-api:latest
   docker push <account>.dkr.ecr.<region>.amazonaws.com/dns-api:latest
   ```
2. Use RDS PostgreSQL as the database (set `DATABASE_URL` in ECS task env).
3. Store secrets in AWS Secrets Manager and inject into the task definition.
4. Put an ALB (Application Load Balancer) in front with an ACM certificate for TLS.

### Google Cloud Run

```bash
gcloud builds submit --tag gcr.io/$PROJECT/dns-api
gcloud run deploy dns-api \
  --image gcr.io/$PROJECT/dns-api \
  --platform managed \
  --region asia-northeast1 \
  --set-env-vars ROOT_DOMAIN=example.com \
  --set-secrets CLOUDFLARE_API_TOKEN=cloudflare-token:latest,ADMIN_API_KEY=admin-key:latest
```

Use Cloud SQL (PostgreSQL) and the Cloud SQL Auth Proxy sidecar for the DB connection.

---

## TLS / Reverse Proxy

The API itself runs plain HTTP on port 3000. Always put a TLS-terminating proxy
in front before exposing it to the internet.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name dns-api.example.com;

    ssl_certificate     /etc/letsencrypt/live/dns-api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dns-api.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}

server {
    listen 80;
    server_name dns-api.example.com;
    return 301 https://$host$request_uri;
}
```

### Caddy (auto TLS)

```
dns-api.example.com {
    reverse_proxy localhost:3000
}
```

### Cloudflare Tunnel (zero-port-forward option)

```bash
cloudflared tunnel create dns-api
cloudflared tunnel route dns dns-api.example.com --tunnel dns-api
# config.yml:
#   tunnel: <tunnel-id>
#   credentials-file: ~/.cloudflared/<tunnel-id>.json
#   ingress:
#     - hostname: dns-api.example.com
#       service: http://localhost:3000
#     - service: http_status:404
cloudflared tunnel run dns-api
```

---

## Database Maintenance

### Backup (PostgreSQL)

```bash
# Docker Compose
docker compose exec db pg_dump -U dnsapi dnsapi | gzip > backup-$(date +%Y%m%d).sql.gz

# Restore
gunzip < backup-20240101.sql.gz | docker compose exec -T db psql -U dnsapi dnsapi
```

### Pruning old audit logs

Audit logs accumulate indefinitely. Prune old entries with a scheduled query:

```sql
-- Keep 90 days
DELETE FROM "AuditLog" WHERE "createdAt" < NOW() - INTERVAL '90 days';
```

Run this as a weekly cron or add a Prisma script at `prisma/prune.ts`.

### Index maintenance

PostgreSQL autovacuum handles routine maintenance. For large deployments:

```sql
-- Check table sizes
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | No | `production` (default: `development`) |
| `PORT` | No | Listen port (default: `3000`) |
| `DATABASE_URL` | **Yes** | Full PostgreSQL connection string |
| `POSTGRES_USER` | Yes* | DB username for docker-compose |
| `POSTGRES_PASSWORD` | Yes* | DB password for docker-compose |
| `POSTGRES_DB` | Yes* | DB name for docker-compose |
| `ROOT_DOMAIN` | **Yes** | Root domain (e.g. `example.com`) |
| `PUBLIC_BASE_URL` | No | Public URL (for documentation only) |
| `CLOUDFLARE_ZONE_ID` | **Yes** | Cloudflare Zone ID |
| `CLOUDFLARE_API_TOKEN` | **Yes** | Cloudflare API Token (DNS Edit scope) |
| `ADMIN_API_KEY` | **Yes** | Admin bearer token |
| `TRUST_CF_CONNECTING_IP` | No | `true`/unset (default `false`). Only set `true` if this hostname is confirmed orange-cloud-proxied through Cloudflare — see below. |

### Client IP resolution (`TRUST_CF_CONNECTING_IP`)

Rate limiting and audit logs need the real client IP. By default (`TRUST_CF_CONNECTING_IP` unset) the server trusts the `X-Real-IP` header, which the documented nginx vhost below sets unconditionally to the actual TCP peer — nginx overwrites it regardless of what a client sends, so it can't be spoofed past nginx.

Only set `TRUST_CF_CONNECTING_IP=true` if you've **confirmed** the API's own hostname (not just individual DNS records) is actually proxied through Cloudflare's orange cloud — in that topology `CF-Connecting-IP` is more accurate than `X-Real-IP` (which would otherwise just show Cloudflare's edge IP). Enabling this when the hostname is DNS-only (grey cloud) or sits directly behind plain nginx lets any client forge their own `CF-Connecting-IP` header and bypass the 120 req/min admin rate limit, and pollutes `AuditLog.ip` with attacker-controlled values.

To check after deploying: `curl -H "Authorization: Bearer $ADMIN_KEY" "$BASE_URL/admin/audit-logs?limit=1"` and confirm the `ip` field looks like a real, plausible client IP.

*Required only when using docker-compose. Not needed if `DATABASE_URL` points to an external DB.

---

## Generating a Secure ADMIN_API_KEY

```bash
echo "admin_dns_$(openssl rand -hex 32)"
```

Minimum recommended length: 32 bytes of entropy (64 hex chars).
