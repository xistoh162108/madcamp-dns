-- OwnedSubdomain: additional subdomains that students can claim via /v1/subdomains.
-- subdomain is UNIQUE across this table AND across Student.subdomain (enforced at app level).
CREATE TABLE IF NOT EXISTS "OwnedSubdomain" (
  "id"        TEXT         NOT NULL PRIMARY KEY,
  "studentId" TEXT         NOT NULL REFERENCES "Student"("id"),
  "subdomain" TEXT         NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OwnedSubdomain_subdomain_key" UNIQUE ("subdomain")
);

CREATE INDEX IF NOT EXISTS "OwnedSubdomain_studentId_idx"
  ON "OwnedSubdomain"("studentId");
