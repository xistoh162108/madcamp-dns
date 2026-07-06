-- Tunnel + TunnelHostname: Cloudflare Tunnel support for outbound-only VMs.
-- Purely additive — no ALTER TABLE on any existing table. FKs are inline in
-- CREATE TABLE, matching the style of 0003_add_owned_subdomains.

-- Tunnel: one Cloudflare Tunnel per student.
CREATE TABLE IF NOT EXISTS "Tunnel" (
  "id"                 TEXT         NOT NULL PRIMARY KEY,
  "studentId"          TEXT         NOT NULL REFERENCES "Student"("id"),
  "cloudflareTunnelId" TEXT         NOT NULL,
  "name"               TEXT         NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Tunnel_studentId_key" UNIQUE ("studentId"),
  CONSTRAINT "Tunnel_cloudflareTunnelId_key" UNIQUE ("cloudflareTunnelId"),
  CONSTRAINT "Tunnel_name_key" UNIQUE ("name")
);

-- TunnelHostname: public hostname -> local port routes within a student's tunnel.
-- fqdn is globally unique (same granularity as DnsRecord) — a subdomain can hold
-- multiple hostnames (different relativeName values), but a given fqdn can only
-- ever be one DnsRecord OR one TunnelHostname, enforced at the app level.
CREATE TABLE IF NOT EXISTS "TunnelHostname" (
  "id"                 TEXT         NOT NULL PRIMARY KEY,
  "tunnelId"           TEXT         NOT NULL REFERENCES "Tunnel"("id"),
  "studentId"          TEXT         NOT NULL REFERENCES "Student"("id"),
  "subdomain"          TEXT         NOT NULL,
  "relativeName"       TEXT         NOT NULL,
  "fqdn"               TEXT         NOT NULL,
  "cloudflareRecordId" TEXT         NOT NULL,
  "localPort"          INTEGER      NOT NULL,
  "protocol"           TEXT         NOT NULL DEFAULT 'http',
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TunnelHostname_fqdn_key" UNIQUE ("fqdn"),
  CONSTRAINT "TunnelHostname_cloudflareRecordId_key" UNIQUE ("cloudflareRecordId")
);

CREATE INDEX IF NOT EXISTS "TunnelHostname_tunnelId_idx" ON "TunnelHostname"("tunnelId");
CREATE INDEX IF NOT EXISTS "TunnelHostname_studentId_idx" ON "TunnelHostname"("studentId");
CREATE INDEX IF NOT EXISTS "TunnelHostname_subdomain_idx" ON "TunnelHostname"("subdomain");
