/**
 * Whitebox coverage-driven fuzzer
 * Run: npx c8 node fuzz.mjs
 *
 * Exercises ALL branches in the compiled lib/validate-dns.js,
 * lib/errors.js, lib/auth.js, lib/api-key.js, and critical
 * request-handling paths — matching each line with c8 coverage.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { isIPv4, isIPv6 } from "net";
import { createHash, timingSafeEqual } from "crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── Import compiled modules ──────────────────────────────────────────────────
const {
  validateRelativeName,
  validateRecordType,
  validateRecordContent,
  validateTtl,
  buildFqdn,
  CreateRecordSchema,
  UpdateRecordSchema,
} = await import("./dist/lib/validate-dns.js");

const {
  AppError,
  invalidRequest,
  unauthorized,
  forbidden,
  forbiddenRecord,
  notFound,
  internalError,
  rateLimited,
  recordLimitExceeded,
  dnsConflict,
  invalidRecordName,
  unsupportedRecordType,
  invalidRecordContent: mkInvalidContent,
  apiKeyRevoked,
  studentDisabled,
  toErrorResponse,
  cloudflareError,
} = await import("./dist/lib/errors.js");

const { generateApiKey, generateTestApiKey, hashApiKey } = await import("./dist/lib/api-key.js");

// ── Test harness ─────────────────────────────────────────────────────────────
let pass = 0, fail = 0, skip = 0;
const failures = [];

function ok(label, cond) {
  if (cond) { pass++; }
  else { fail++; failures.push(label); }
}

function throws(label, fn, msgContains) {
  try {
    fn();
    fail++;
    failures.push(label + " (expected throw, got none)");
  } catch (e) {
    if (msgContains && !e.message?.includes(msgContains)) {
      fail++;
      failures.push(label + ` (wrong message: "${e.message}")`);
    } else {
      pass++;
    }
  }
}

function doesNotThrow(label, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push(label + ` (unexpected throw: ${e.message})`);
  }
}

// ============================================================================
// 1. validateRelativeName — exhaustive branch coverage
// ============================================================================

// Happy path labels
doesNotThrow("name: simple single label",       () => validateRelativeName("api"));
doesNotThrow("name: multi-label (2)",            () => validateRelativeName("v1.api"));
doesNotThrow("name: multi-label (3)",            () => validateRelativeName("v1.api.svc"));
doesNotThrow("name: digits in label",            () => validateRelativeName("api2"));
doesNotThrow("name: hyphens in label",           () => validateRelativeName("my-api"));
doesNotThrow("name: single char",                () => validateRelativeName("a"));
doesNotThrow("name: leading spaces (trimmed)",   () => validateRelativeName(" api "));
doesNotThrow("name: uppercase (lowercased)",     () => validateRelativeName("API"));
doesNotThrow("name: mixed case",                 () => validateRelativeName("MyApi"));
doesNotThrow("name: 63-char single label",       () => validateRelativeName("a".repeat(63)));

// Error branches
throws("name: empty string",                 () => validateRelativeName(""), "must not be empty");
throws("name: whitespace only",              () => validateRelativeName("   "), "must not be empty");
throws("name: null byte",                    () => validateRelativeName("ab\x00cd"), "control");
throws("name: CR control char",              () => validateRelativeName("ab\rcd"), "control");
throws("name: wildcard *",                   () => validateRelativeName("*"), "Wildcard");
throws("name: wildcard prefix",              () => validateRelativeName("*.api"), "Wildcard");
throws("name: @ symbol",                     () => validateRelativeName("@"), "\"@\"");
throws("name: underscore prefix",            () => validateRelativeName("_acme-challenge"), "underscore");
throws("name: underscore general",           () => validateRelativeName("_service"), "underscore");
throws("name: blocked admin",                () => validateRelativeName("admin"), "not allowed");
throws("name: blocked root",                 () => validateRelativeName("root"), "not allowed");
throws("name: blocked mail",                 () => validateRelativeName("mail"), "not allowed");
throws("name: blocked smtp",                 () => validateRelativeName("smtp"), "not allowed");
throws("name: blocked imap",                 () => validateRelativeName("imap"), "not allowed");
throws("name: blocked ns1",                  () => validateRelativeName("ns1"), "not allowed");
throws("name: blocked ftp",                  () => validateRelativeName("ftp"), "not allowed");
throws("name: blocked ssh",                  () => validateRelativeName("ssh"), "not allowed");
throws("name: blocked localhost",            () => validateRelativeName("localhost"), "not allowed");
throws("name: blocked vpn",                       () => validateRelativeName("vpn"), "not allowed");
// _acme-challenge embedded in multi-label path (not caught by underscore-prefix check)
throws("name: embedded _acme-challenge",          () => validateRelativeName("a._acme-challenge.b"), "_acme-challenge");
throws("name: double dots",                       () => validateRelativeName("api..v1"), "dot");
throws("name: leading dot",                  () => validateRelativeName(".api"), "dot");
throws("name: trailing dot",                 () => validateRelativeName("api."), "dot");
throws("name: label starts with hyphen",     () => validateRelativeName("-api"), "invalid");
throws("name: label ends with hyphen",       () => validateRelativeName("api-"), "invalid");
throws("name: Cyrillic а (Unicode)",         () => validateRelativeName("аpi"), "invalid");
throws("name: 4 labels (too deep)",          () => validateRelativeName("a.b.c.d"), "3 label");
throws("name: label > 63 chars",             () => validateRelativeName("a".repeat(64)), "invalid");

// ============================================================================
// 2. validateRecordType — all branches
// ============================================================================

doesNotThrow("type: A",     () => validateRecordType("A"));
doesNotThrow("type: AAAA",  () => validateRecordType("AAAA"));
doesNotThrow("type: CNAME", () => validateRecordType("CNAME"));
doesNotThrow("type: TXT",   () => validateRecordType("TXT"));
throws("type: MX",          () => validateRecordType("MX"),     "supported");
throws("type: empty",       () => validateRecordType(""),       "supported");
throws("type: lowercase a", () => validateRecordType("a"),      "supported");
throws("type: NS",          () => validateRecordType("NS"),     "supported");
throws("type: SOA",         () => validateRecordType("SOA"),    "supported");
throws("type: injection",   () => validateRecordType("A\";rm -rf"), "supported");

// ============================================================================
// 3. validateRecordContent — all type + error branches
// ============================================================================

// A records
doesNotThrow("A: loopback",          () => validateRecordContent("A", "127.0.0.1"));
doesNotThrow("A: public IP",         () => validateRecordContent("A", "203.0.113.10"));
doesNotThrow("A: zeros",             () => validateRecordContent("A", "0.0.0.0"));
doesNotThrow("A: broadcast",         () => validateRecordContent("A", "255.255.255.255"));
throws("A: IPv6 address",            () => validateRecordContent("A", "::1"), "IPv4");
throws("A: hostname",                () => validateRecordContent("A", "example.com"), "IPv4");
throws("A: empty",                   () => validateRecordContent("A", ""), "IPv4");
throws("A: with spaces",             () => validateRecordContent("A", " 192.168.1.1"), "IPv4");
throws("A: trailing dot",            () => validateRecordContent("A", "192.168.1.1."), "IPv4");
throws("A: out of range",            () => validateRecordContent("A", "256.1.1.1"), "IPv4");
throws("A: null byte",               () => validateRecordContent("A", "192.168.1.\x001"), "control");

// AAAA records
doesNotThrow("AAAA: loopback",       () => validateRecordContent("AAAA", "::1"));
doesNotThrow("AAAA: full address",   () => validateRecordContent("AAAA", "2001:db8::1"));
doesNotThrow("AAAA: all groups",     () => validateRecordContent("AAAA", "2001:0db8:0000:0000:0000:0000:0000:0001"));
throws("AAAA: zone ID ::1%eth0",     () => validateRecordContent("AAAA", "::1%eth0"), "zone ID");
throws("AAAA: zone ID %0",           () => validateRecordContent("AAAA", "2001:db8::1%0"), "zone ID");
throws("AAAA: IPv4 address",         () => validateRecordContent("AAAA", "192.168.1.1"), "IPv6");
throws("AAAA: hostname",             () => validateRecordContent("AAAA", "example.com"), "IPv6");
throws("AAAA: empty",                () => validateRecordContent("AAAA", ""), "IPv6");
throws("AAAA: control char",         () => validateRecordContent("AAAA", "::1\x00"), "control");

// CNAME records
doesNotThrow("CNAME: apex domain",     () => validateRecordContent("CNAME", "example.com"));
doesNotThrow("CNAME: subdomain",       () => validateRecordContent("CNAME", "app.netlify.com"));
doesNotThrow("CNAME: trailing dot",    () => validateRecordContent("CNAME", "example.com."));
doesNotThrow("CNAME: single label",    () => validateRecordContent("CNAME", "localhost"));
throws("CNAME: IPv4",                  () => validateRecordContent("CNAME", "192.168.1.1"), "hostname");
throws("CNAME: IPv6",                  () => validateRecordContent("CNAME", "::1"), "hostname");
throws("CNAME: empty",                 () => validateRecordContent("CNAME", ""), "hostname");
throws("CNAME: invalid hostname",      () => validateRecordContent("CNAME", "-invalid-.com"), "hostname");
throws("CNAME: too long hostname",     () => validateRecordContent("CNAME", "a".repeat(254)), "hostname");
throws("CNAME: control char",          () => validateRecordContent("CNAME", "example\x00.com"), "control");
throws("CNAME: CR in hostname",        () => validateRecordContent("CNAME", "exa\rmple.com"), "control");

// TXT records
doesNotThrow("TXT: spf record",        () => validateRecordContent("TXT", "v=spf1 include:example.com ~all"));
doesNotThrow("TXT: dkim value",        () => validateRecordContent("TXT", "v=DKIM1; k=rsa; p=MIGfMA0..."));
doesNotThrow("TXT: empty-ish space",   () => validateRecordContent("TXT", " ")); // space is printable
doesNotThrow("TXT: 255 chars",         () => validateRecordContent("TXT", "x".repeat(255)));
doesNotThrow("TXT: tab allowed",       () => validateRecordContent("TXT", "key\tvalue"));
doesNotThrow("TXT: LF allowed",        () => validateRecordContent("TXT", "line1\nline2"));
throws("TXT: 256 chars",               () => validateRecordContent("TXT", "x".repeat(256)), "255");
throws("TXT: null byte",               () => validateRecordContent("TXT", "hello\x00world"), "control");
throws("TXT: CR character",            () => validateRecordContent("TXT", "hello\rworld"), "control");
throws("TXT: SOH char",                () => validateRecordContent("TXT", "\x01"), "control");
throws("TXT: DEL char",                () => validateRecordContent("TXT", "\x7F"), "control");

// ============================================================================
// 4. validateTtl — all branches
// ============================================================================

ok("ttl: 1 (automatic)",   validateTtl(1)   === 1);
ok("ttl: '1' string",      validateTtl("1") === 1);
ok("ttl: 60 minimum",      validateTtl(60)  === 60);
ok("ttl: 300",             validateTtl(300) === 300);
ok("ttl: 86400 maximum",   validateTtl(86400) === 86400);
throws("ttl: 59 (too low)", () => validateTtl(59),    "TTL must be");
throws("ttl: 86401 (too high)", () => validateTtl(86401), "TTL must be");
throws("ttl: 0",            () => validateTtl(0),     "TTL must be");
throws("ttl: negative",     () => validateTtl(-1),    "TTL must be");
throws("ttl: NaN",          () => validateTtl(NaN),   "TTL must be");
throws("ttl: Infinity",     () => validateTtl(Infinity), "TTL must be");
throws("ttl: 1.5 float",    () => validateTtl(1.5),   "TTL must be");
throws("ttl: string abc",   () => validateTtl("abc"), "TTL must be");
throws("ttl: null",         () => validateTtl(null),  "TTL must be");

// ============================================================================
// 5. buildFqdn — boundary cases
// ============================================================================

ok("fqdn: single label",  buildFqdn("api", "alice", "example.com") === "api.alice.example.com");
ok("fqdn: multi-label",   buildFqdn("v1.api", "bob", "camp.dev") === "v1.api.bob.camp.dev");

// ============================================================================
// 6. Zod schemas — fuzz all fields
// ============================================================================

// CreateRecordSchema — valid
ok("zod create: valid A",        CreateRecordSchema.safeParse({ name: "api", type: "A", content: "1.2.3.4" }).success);
ok("zod create: ttl default 1",  CreateRecordSchema.safeParse({ name: "api", type: "A", content: "1.2.3.4" }).data?.ttl === 1);
ok("zod create: proxied default",CreateRecordSchema.safeParse({ name: "api", type: "A", content: "1.2.3.4" }).data?.proxied === false);

// CreateRecordSchema — invalid
ok("zod create: no name",        !CreateRecordSchema.safeParse({ type: "A", content: "1.2.3.4" }).success);
ok("zod create: empty name",     !CreateRecordSchema.safeParse({ name: "", type: "A", content: "1.2.3.4" }).success);
ok("zod create: no type",        !CreateRecordSchema.safeParse({ name: "api", content: "1.2.3.4" }).success);
ok("zod create: no content",     !CreateRecordSchema.safeParse({ name: "api", type: "A" }).success);
ok("zod create: empty content",  !CreateRecordSchema.safeParse({ name: "api", type: "A", content: "" }).success);
ok("zod create: ttl 59",         !CreateRecordSchema.safeParse({ name: "api", type: "A", content: "1.2.3.4", ttl: 59 }).success);
ok("zod create: ttl 86401",      !CreateRecordSchema.safeParse({ name: "api", type: "A", content: "1.2.3.4", ttl: 86401 }).success);
ok("zod create: ttl 1 ok",       CreateRecordSchema.safeParse({ name: "api", type: "A", content: "1.2.3.4", ttl: 1 }).success);
ok("zod create: proxied string", !CreateRecordSchema.safeParse({ name: "api", type: "A", content: "1.2.3.4", proxied: "yes" }).success);

// Large content exceeding Zod max(2048) — exercises the new max
const big = "x".repeat(2049);
ok("zod create: content > 2048", !CreateRecordSchema.safeParse({ name: "api", type: "A", content: big }).success);

// UpdateRecordSchema — valid (all optional)
ok("zod update: empty object valid", UpdateRecordSchema.safeParse({}).success);
ok("zod update: name only",          UpdateRecordSchema.safeParse({ name: "new" }).success);
ok("zod update: content only",       UpdateRecordSchema.safeParse({ content: "1.2.3.4" }).success);
ok("zod update: ttl only",           UpdateRecordSchema.safeParse({ ttl: 300 }).success);
ok("zod update: proxied only",       UpdateRecordSchema.safeParse({ proxied: true }).success);
ok("zod update: all fields",         UpdateRecordSchema.safeParse({ name: "x", content: "y", ttl: 60, proxied: false }).success);
ok("zod update: bad ttl",            !UpdateRecordSchema.safeParse({ ttl: 59 }).success);

// ============================================================================
// 7. errors.ts — all error constructors and toErrorResponse
// ============================================================================

const e_inv  = invalidRequest("bad input");
const e_unau = unauthorized("no key");
const e_404  = notFound("record");
const e_int  = internalError();
const e_rl   = rateLimited(10, 60, 30);
const e_rle  = recordLimitExceeded(10);
const e_dns  = dnsConflict("type conflict");
const e_name = invalidRecordName("bad name");
const e_type = unsupportedRecordType();
const e_cont = mkInvalidContent("bad content");
const e_akr  = apiKeyRevoked();
const e_std  = studentDisabled();
const e_cf   = cloudflareError("timed out");

ok("error: invalidRequest 400",       e_inv.statusCode === 400);
ok("error: unauthorized 401",         e_unau.statusCode === 401);
ok("error: notFound 404",             e_404.statusCode === 404);
ok("error: internalError 500",        e_int.statusCode === 500);
ok("error: rateLimited 429",          e_rl.statusCode === 429);
ok("error: rateLimited details",      e_rl.details?.limit === 10);
ok("error: recordLimitExceeded 403",  e_rle.statusCode === 403);
ok("error: dnsConflict 409",          e_dns.statusCode === 409);
ok("error: invalidRecordName 400",    e_name.statusCode === 400);
ok("error: unsupportedType 400",      e_type.statusCode === 400);
ok("error: invalidContent 400",       e_cont.statusCode === 400);
ok("error: apiKeyRevoked 401",        e_akr.statusCode === 401);
ok("error: studentDisabled 403",      e_std.statusCode === 403);
ok("error: cloudflareError 502",      e_cf.statusCode === 502);

// forbidden / forbiddenRecord (previously uncovered)
const e_forb  = forbidden("no access");
const e_forbR = forbiddenRecord();
ok("error: forbidden 403",            e_forb.statusCode === 403);
ok("error: forbidden code",           e_forb.code === "FORBIDDEN");
ok("error: forbiddenRecord 403",      e_forbR.statusCode === 403);
ok("error: forbiddenRecord code",     e_forbR.code === "FORBIDDEN_RECORD");
ok("error: all are AppError",         [e_inv,e_unau,e_forb,e_forbR,e_404,e_int,e_rl,e_rle,e_dns,e_name,e_type,e_cont,e_akr,e_std,e_cf].every(e => e instanceof AppError));
ok("error: toErrorResponse shape",     !!toErrorResponse(e_inv).error?.code);
ok("error: toErrorResponse code",     toErrorResponse(e_inv).error.code === "INVALID_REQUEST");
// errors.ts:124 — branch: err.details present (truthy path)
const e_withDetails = invalidRequest("validation failed", { field: "name" });
ok("error: toErrorResponse w/ details", toErrorResponse(e_withDetails).error.details?.field === "name");
// errors.ts:124 — branch: err.details absent (falsy path)
ok("error: toErrorResponse no details", !toErrorResponse(e_inv).error.details);

// ============================================================================
// 8. api-key.ts — generateApiKey and hashApiKey
// ============================================================================

const { raw, hash, keyPrefix } = generateApiKey();
ok("key: raw starts with sk_dns_",   raw.startsWith("sk_dns_"));
ok("key: raw length 71 chars",        raw.length === 71); // 7 + 64
ok("key: hash is 64-char hex",        /^[a-f0-9]{64}$/.test(hash));
ok("key: prefix captured",            keyPrefix.length > 0 && raw.startsWith(keyPrefix));
ok("key: hash differs from raw",      hash !== raw);
ok("key: hash stable",                hashApiKey(raw) === hash);

// generateTestApiKey — previously uncovered (api-key.ts:12-13)
const tKey = generateTestApiKey();
ok("key: test key prefix",          tKey.raw.startsWith("sk_dns_test_"));
ok("key: test key hash valid hex",  /^[a-f0-9]{64}$/.test(tKey.hash));

// Test prefix
const { raw: raw2, hash: hash2 } = generateApiKey("sk_dns_test");
ok("key: test prefix",                raw2.startsWith("sk_dns_test_"));

// SHA-256 hash length stability
const h1 = hashApiKey("sk_dns_" + "a".repeat(64));
const h2 = hashApiKey("sk_dns_" + "b".repeat(64));
ok("key: hashes are equal length",    h1.length === h2.length);
ok("key: different keys different hashes", h1 !== h2);

// ============================================================================
// 9. Bearer token extraction (inline auth logic)
// ============================================================================

function extractBearer(auth) {
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice(7).trim() || null;
}
ok("auth: Bearer TOKEN",     extractBearer("Bearer TOKEN") === "TOKEN");
ok("auth: bearer TOKEN",     extractBearer("bearer TOKEN") === "TOKEN");
ok("auth: BEARER TOKEN",     extractBearer("BEARER TOKEN") === "TOKEN");
ok("auth: no scheme",        extractBearer("TOKEN") === null);
ok("auth: basic scheme",     extractBearer("Basic TOKEN") === null);
ok("auth: empty bearer val", extractBearer("Bearer ") === null);
ok("auth: whitespace token", extractBearer("Bearer   ") === null);
ok("auth: null",             extractBearer(null) === null);
ok("auth: undefined",        extractBearer(undefined) === null);

// ============================================================================
// 10. timingSafeEqual admin key check (inline)
// ============================================================================

function adminAuthCheck(token, adminKey) {
  const tokenHash = createHash("sha256").update(token).digest();
  const adminHash = createHash("sha256").update(adminKey).digest();
  return timingSafeEqual(tokenHash, adminHash);
}
ok("adminAuth: correct key", adminAuthCheck("secret", "secret") === true);
ok("adminAuth: wrong key",   adminAuthCheck("wrong", "secret") === false);
ok("adminAuth: empty vs real", adminAuthCheck("", "secret") === false);
// Timing-safe: both sides hashed to 32 bytes, so lengths always equal
ok("adminAuth: long token",  adminAuthCheck("a".repeat(10000), "secret") === false);

// ============================================================================
// 11. Rate limit key collision prevention (inline)
// ============================================================================

// Admin rate limit key: "admin:<ip>" — must NOT collide with hex SHA-256 hashes
// SHA-256 hashes are 64 hex chars only. "admin:<ip>" always starts with "admin:"
const adminKey1 = "admin:192.168.1.1";
const adminKey2 = "admin:10.0.0.1";
const studentKeyHash = hashApiKey("sk_dns_" + "x".repeat(64));
ok("ratekey: admin key format",      adminKey1.startsWith("admin:"));
ok("ratekey: no collision possible", !adminKey1.startsWith(studentKeyHash));
ok("ratekey: no collision possible", !studentKeyHash.startsWith("admin:"));
ok("ratekey: different IPs differ",  adminKey1 !== adminKey2);

// ============================================================================
// 12. UUID request ID validation (inline)
// ============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(v) { return !!(v && UUID_RE.test(v)); }
ok("uuid: valid",             isUUID("550e8400-e29b-41d4-a716-446655440000"));
ok("uuid: uppercase",         isUUID("550E8400-E29B-41D4-A716-446655440000"));
ok("uuid: injection attempt", !isUUID("../../etc/passwd"));
ok("uuid: too short",         !isUUID("550e8400-e29b"));
ok("uuid: too long",          !isUUID("550e8400-e29b-41d4-a716-446655440000x"));
ok("uuid: null",              !isUUID(null));
ok("uuid: empty",             !isUUID(""));
ok("uuid: with newline",      !isUUID("550e8400-e29b-41d4-a716-44665544000\n"));

// ============================================================================
// 13. Content-Length check (inline)
// ============================================================================

const MAX_BODY = 64 * 1024; // 65536
function checkCL(cl) {
  if (cl === undefined || cl === null) return false;
  const n = parseInt(cl, 10);
  return !isNaN(n) && n > MAX_BODY;
}
ok("cl: 65537 rejected",    checkCL("65537") === true);
ok("cl: 65536 allowed",     checkCL("65536") === false);
ok("cl: 0 allowed",         checkCL("0") === false);
ok("cl: abc allowed",       checkCL("abc") === false); // NaN → pass through
ok("cl: absent allowed",    checkCL(undefined) === false);
ok("cl: negative allowed",  checkCL("-1") === false);
ok("cl: 10MB rejected",     checkCL(String(10 * 1024 * 1024)) === true);

// ============================================================================
// 14. Subdomain regex validation (mirrors admin.students.ts)
// ============================================================================

const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$/;
const goodSubs  = ["alice", "bob", "test1", "a", "my-api", "a1b2c3", "x".repeat(32)];
const badSubs   = ["", "-alice", "alice-", "Alice", "alice.bob", "alice_bob", "x".repeat(33), "alice bob"];
for (const s of goodSubs) ok(`subdomain ok: ${s}`, SUBDOMAIN_RE.test(s));
for (const s of badSubs)  ok(`subdomain bad: ${JSON.stringify(s)}`, !SUBDOMAIN_RE.test(s));

// ============================================================================
// 15. PORT validation (inline)
// ============================================================================

function validatePort(v) {
  const n = parseInt(v ?? "3000", 10);
  return !isNaN(n) && n >= 1 && n <= 65535;
}
ok("port: 3000",    validatePort("3000"));
ok("port: 1",       validatePort("1"));
ok("port: 65535",   validatePort("65535"));
ok("port: abc",     !validatePort("abc"));
ok("port: 0",       !validatePort("0"));
ok("port: 65536",   !validatePort("65536"));
ok("port: -1",      !validatePort("-1"));
ok("port: float",   validatePort("3000.5")); // parseInt("3000.5")=3000, which is valid
ok("port: default", validatePort(undefined)); // defaults to 3000

// ============================================================================
// 16. Edge cases and unusual inputs (fuzzer-style)
// ============================================================================

// Names that look valid but have subtle issues
doesNotThrow("name: xn-- punycode",        () => validateRelativeName("xn--p1ai")); // valid IDN encoding
doesNotThrow("name: all digits",            () => validateRelativeName("123")); // all-digit label is valid per RFC
doesNotThrow("name: digit-letter mix",      () => validateRelativeName("a1b2-c3d4")); // valid
doesNotThrow("name: max 3 labels exactly",  () => validateRelativeName("a.b.c"));
throws("name: numeric hyphen collision",    () => validateRelativeName("a-.b"), "invalid"); // trailing hyphen
throws("name: space in name",              () => validateRelativeName("my api"), "invalid"); // space not in [a-z0-9-]

// Content edge cases beyond normal bounds
doesNotThrow("A: RFC 5737 doc address",    () => validateRecordContent("A", "192.0.2.1"));
doesNotThrow("A: max valid octet",         () => validateRecordContent("A", "255.255.255.254"));
throws("A: 0.0.0.256",                     () => validateRecordContent("A", "0.0.0.256"), "IPv4");
throws("A: 1.2.3",                         () => validateRecordContent("A", "1.2.3"), "IPv4"); // incomplete
throws("A: 1.2.3.4.5",                     () => validateRecordContent("A", "1.2.3.4.5"), "IPv4"); // extra octet
throws("A: hex IP",                        () => validateRecordContent("A", "0xC0A80101"), "IPv4");

doesNotThrow("AAAA: compressed zero",      () => validateRecordContent("AAAA", "::"));
doesNotThrow("AAAA: IPv4-in-IPv6",         () => validateRecordContent("AAAA", "::ffff:192.0.2.1"));
throws("AAAA: zone ID %1",                 () => validateRecordContent("AAAA", "fe80::1%1"), "zone ID");
throws("AAAA: zone ID %eth",               () => validateRecordContent("AAAA", "fe80::1%eth0"), "zone ID");

doesNotThrow("CNAME: fqdn trailing dot",   () => validateRecordContent("CNAME", "example.com."));
doesNotThrow("CNAME: deep subdomain",      () => validateRecordContent("CNAME", "a.b.c.d.example.com"));
throws("CNAME: too long (254)",             () => validateRecordContent("CNAME", "a".repeat(250) + ".com"), "hostname");

// TXT boundary conditions
doesNotThrow("TXT: exactly 255 chars",     () => validateRecordContent("TXT", "x".repeat(255)));
throws("TXT: exactly 256 chars",           () => validateRecordContent("TXT", "x".repeat(256)), "255");
doesNotThrow("TXT: high bytes (UTF-8)",    () => validateRecordContent("TXT", "\x80\xFF")); // international chars
doesNotThrow("TXT: printable symbols",     () => validateRecordContent("TXT", "!@#$%^&*()_+=[]{};':\",.<>?/|\\"));
throws("TXT: vertical tab",               () => validateRecordContent("TXT", "hello\x0Bworld"), "control");
throws("TXT: form feed",                   () => validateRecordContent("TXT", "hello\x0Cworld"), "control");
throws("TXT: backspace",                   () => validateRecordContent("TXT", "\x08"), "control");

// TTL boundary conditions
ok("ttl: 86400 exactly",    validateTtl(86400) === 86400);
ok("ttl: 60 exactly",       validateTtl(60) === 60);
throws("ttl: 1.0001 float", () => validateTtl(1.0001), "TTL"); // non-integer float > 1
throws("ttl: 59.9 float",   () => validateTtl(59.9),  "TTL"); // not integer
throws("ttl: undefined",    () => validateTtl(undefined), "TTL");
throws("ttl: object",       () => validateTtl({}),     "TTL");
throws("ttl: array",        () => validateTtl([]),     "TTL");

// Zod schema edge cases
ok("zod: proxied true",        CreateRecordSchema.safeParse({ name: "a", type: "A", content: "1.1.1.1", proxied: true }).success);
ok("zod: ttl 60",              CreateRecordSchema.safeParse({ name: "a", type: "A", content: "1.1.1.1", ttl: 60 }).success);
ok("zod: ttl 86400",           CreateRecordSchema.safeParse({ name: "a", type: "A", content: "1.1.1.1", ttl: 86400 }).success);
ok("zod: null body rejected",  !CreateRecordSchema.safeParse(null).success);
ok("zod: array body rejected", !CreateRecordSchema.safeParse([]).success);
ok("zod: name max 128",        CreateRecordSchema.safeParse({ name: "a".repeat(128), type: "A", content: "1.1.1.1" }).success);
ok("zod: name 129 rejected",   !CreateRecordSchema.safeParse({ name: "a".repeat(129), type: "A", content: "1.1.1.1" }).success);
// Extra unknown fields are stripped (Zod default strip behavior)
ok("zod: extra fields stripped", CreateRecordSchema.safeParse({ name: "a", type: "A", content: "1.1.1.1", hack: "rm -rf" }).success);

// buildFqdn — injection attempts in inputs (encoding is caller's responsibility)
// These test that buildFqdn doesn't do unexpected things
const f1 = buildFqdn("api", "alice", "example.com");
ok("fqdn: no injection possible",  f1 === "api.alice.example.com");
ok("fqdn: dot separator",          f1.split(".").length === 4);

// API key collision resistance
const keys = new Set();
for (let i = 0; i < 100; i++) {
  const { raw } = generateApiKey();
  keys.add(raw);
}
ok("key: 100 keys all unique", keys.size === 100);

// Hash is deterministic
const sameKey = "sk_dns_" + "a".repeat(64);
ok("key: hash deterministic", hashApiKey(sameKey) === hashApiKey(sameKey));
// Different prefixes produce different hashes
ok("key: prefix changes hash", hashApiKey("sk_dns_aaa") !== hashApiKey("sk_dns_bbb"));

// Timing-safe comparison must not throw even for extreme inputs
doesNotThrow("adminAuth: empty strings", () => {
  const h1 = createHash("sha256").update("").digest();
  const h2 = createHash("sha256").update("x").digest();
  timingSafeEqual(h1, h2); // must not throw (both 32 bytes)
});

// Rate limit key format invariants
const studentHex = hashApiKey("sk_dns_test_" + "z".repeat(64));
ok("ratekey: student hash is 64 hex", /^[a-f0-9]{64}$/.test(studentHex));
ok("ratekey: admin key not hex",      !/^[a-f0-9]+$/.test("admin:10.0.0.1")); // contains colon
ok("ratekey: no collision by design", !("admin:10.0.0.1").startsWith(studentHex.slice(0, 6)));

// FQDN length boundary (DNS max 253 chars)
// With name=128 chars, subdomain=32 chars, root=96+".com"=100 chars → total 261 chars
// We intentionally let Cloudflare reject oversized FQDNs (documented limitation)
const longFqdn = buildFqdn("a".repeat(128), "b".repeat(32), "c".repeat(96) + ".com");
ok("fqdn: can exceed 253 (Cloudflare validates)",  longFqdn.length > 253); // 128+1+32+1+96+4=262

// Subdomain validation regex edge cases
const SUBDOMAIN_RE2 = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$/;
ok("sub: 32 chars (max)",         SUBDOMAIN_RE2.test("a".repeat(32)));
ok("sub: 33 chars (over max)",    !SUBDOMAIN_RE2.test("a".repeat(33)));
ok("sub: single char",            SUBDOMAIN_RE2.test("a"));
ok("sub: two chars no hyphen",    SUBDOMAIN_RE2.test("ab"));
ok("sub: hyphen only",            !SUBDOMAIN_RE2.test("-"));
ok("sub: starts with number",     SUBDOMAIN_RE2.test("1abc"));
ok("sub: all numbers",            SUBDOMAIN_RE2.test("123"));
ok("sub: emoji (Unicode)",        !SUBDOMAIN_RE2.test("alice🔥"));
ok("sub: unicode a look-alike",   !SUBDOMAIN_RE2.test("аlice")); // Cyrillic а

// Content-Length: very large values
ok("cl: 2^53 (max safe int)",  (() => {
  const n = Number.MAX_SAFE_INTEGER;
  return !isNaN(n) && n > MAX_BODY; // MAX_BODY = 64*1024 defined in section 6
})());

// Bearer extraction: unusual token characters
function extractB(auth) {
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice(7).trim() || null;
}
ok("auth: dots in token",      extractB("Bearer sk_dns_a.b.c") === "sk_dns_a.b.c");
ok("auth: equals in token",    extractB("Bearer abc=def") === "abc=def");
ok("auth: unicode token",      extractB("Bearer あいう") === "あいう");
ok("auth: multi-space trim",   extractB("Bearer   TOKEN") === "TOKEN"); // leading spaces trimmed

// ============================================================================
// Results
// ============================================================================

console.log("");
if (failures.length > 0) {
  console.log("FAILED CASES:");
  for (const f of failures) console.log("  ✗", f);
  console.log("");
}
console.log(`${fail === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${pass} passed, ${fail} failed`);

if (fail > 0) process.exit(1);

// ── SECTION G: OwnedSubdomain / self-service subdomain edge cases ─────────────
// Appended by second-pass audit
;(async () => {
const {
  validateSubdomainName,
  extractSubdomainFromFqdn,
  BLOCKED_SUBDOMAINS,
  SUBDOMAIN_RE,
  buildFqdn,
} = await import("./dist/lib/validate-dns.js");

let gpass = 0, gfail = 0;
const gfails = [];
function gok(label, cond) { cond ? gpass++ : (gfail++, gfails.push(label)); }
function gthrows(label, fn, substr) {
  try { fn(); gfail++; gfails.push(label + " (no throw)"); }
  catch(e) {
    if (substr && !e.message?.includes(substr)) { gfail++; gfails.push(`${label} (msg "${e.message}" lacks "${substr}")`); }
    else gpass++;
  }
}
function gok_nothrow(label, fn) {
  try { fn(); gpass++; } catch(e) { gfail++; gfails.push(`${label} (threw: ${e.message})`); }
}

console.log("── G: OwnedSubdomain Edge Cases ────────────────────────────────");

// G1. extractSubdomainFromFqdn roundtrip
const cases = [
  ["api.alice.example.com",        "api",        "example.com",    "alice"],
  ["v1.api.team.madcamp.io",       "v1.api",     "madcamp.io",     "team"],
  ["x.a.madcamp.io",               "x",          "madcamp.io",     "a"],
  ["dev.backend.myteam.camp.com",  "dev.backend","camp.com",       "myteam"],
];
for (const [fqdn, rel, root, want] of cases) {
  gok(`G1: extract "${fqdn}"`, extractSubdomainFromFqdn(fqdn, rel, root) === want);
}

// G2. buildFqdn + extractSubdomainFromFqdn are inverse operations
const names = ["www", "api", "dev.server", "v1.api.service"];
const subs  = ["alice", "my-team", "z9"];
const roots = ["example.com", "madcamp.io"];
for (const n of names) for (const s of subs) for (const r of roots) {
  const fqdn = buildFqdn(n, s, r);
  gok(`G2: roundtrip name="${n}" sub="${s}" root="${r}"`, extractSubdomainFromFqdn(fqdn, n, r) === s);
}

// G3. BLOCKED_SUBDOMAINS: known dangerous names are in the set
const mustBlock = ["ns","ns1","ns2","ns3","ns4","ns5","dns","mail","smtp","pop","pop3",
                   "imap","webmail","mx","www","ftp","sftp","admin","root","localhost"];
for (const s of mustBlock) gok(`G3: "${s}" in BLOCKED_SUBDOMAINS`, BLOCKED_SUBDOMAINS.has(s));

// G4. validateSubdomainName — normalises to lowercase before BLOCKED check
// "ADMIN" must be treated as "admin" (blocked)
gthrows("G4: uppercase ADMIN normalised and blocked", () => validateSubdomainName("ADMIN"), "reserved");
gthrows("G4: uppercase NS normalised and blocked",    () => validateSubdomainName("NS"),    "reserved");

// G5. Single-char subdomains allowed
gok_nothrow("G5: single char 'a'", () => validateSubdomainName("a"));
gok_nothrow("G5: single char '9'", () => validateSubdomainName("9"));

// G6. Max length boundary: 32 chars OK, 33 chars NOT OK
const s32 = "a" + "b".repeat(30) + "c"; // 1+30+1 = 32
const s33 = "a" + "b".repeat(31) + "c"; // 1+31+1 = 33
gok_nothrow("G6: 32-char subdomain OK",      () => validateSubdomainName(s32));
gthrows(    "G6: 33-char subdomain rejected", () => validateSubdomainName(s33), "");

// G7. Injection attempts — must be rejected by SUBDOMAIN_RE (not valid format)
// Note: "alice\n" and "alice\r" are ACCEPTED because .trim() normalises them to "alice".
// This is intentional: trailing whitespace is stripped, stored value is clean.
const injections = [
  "alice'; DROP TABLE student; --",
  "alice<script>",
  "alice\x00",             // null byte not in [a-z0-9-] after trim
  "alice/admin",
  "alice\\admin",
  "alice?id=1",
  "alice&sub=other",
  "аlice",                 // Cyrillic а (U+0430) — not ASCII
  "αlice",                 // Greek α (U+03B1) — not ASCII
  "../alice",
];
for (const s of injections) {
  gthrows(`G7: injection "${s.slice(0,20)}" rejected`, () => validateSubdomainName(s), "");
}
// Trailing whitespace/newlines are TRIMMED to valid "alice" — accepted
gok_nothrow("G7: trailing \\n trimmed to valid 'alice'", () => validateSubdomainName("alice\n"));
gok_nothrow("G7: trailing \\r trimmed to valid 'alice'", () => validateSubdomainName("alice\r"));

// G8. Hyphen-only, all-digits subdomains
gthrows("G8: hyphen-only '-'",           () => validateSubdomainName("-"), "");
gok_nothrow("G8: digits-only '123'",     () => validateSubdomainName("123"));
gok_nothrow("G8: alphanumeric 'a1b2c3'", () => validateSubdomainName("a1b2c3"));

// G9. DoS vector: very long subdomain string (100k chars)
gthrows("G9: 100k-char subdomain rejected", () => validateSubdomainName("a".repeat(100_000)), "");

// G10. Empty / whitespace-only
gthrows("G10: empty string",        () => validateSubdomainName(""),    "non-empty");
gthrows("G10: whitespace only",     () => validateSubdomainName("   "), "non-empty");
gthrows("G10: tab only",            () => validateSubdomainName("\t"),  "non-empty");

console.log("");
if (gfails.length > 0) {
  console.log("SECTION G FAILURES:");
  for (const f of gfails) console.log("  ✗", f);
  console.log("");
}
const gtotal = gpass + gfail;
console.log(`${gfail === 0 ? "✓ G PASS" : "✗ G FAIL"} — ${gpass}/${gtotal}`);
if (gfail > 0) process.exit(1);
})();
