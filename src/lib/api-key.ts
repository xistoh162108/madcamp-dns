import { createHash, randomBytes } from "crypto";

export function generateApiKey(prefix = "sk_dns"): { raw: string; hash: string; keyPrefix: string } {
  const rand = randomBytes(32).toString("hex");
  const raw = `${prefix}_${rand}`;
  const hash = hashApiKey(raw);
  const keyPrefix = raw.slice(0, prefix.length + 9); // prefix + "_" + first 8 chars
  return { raw, hash, keyPrefix };
}

export function generateTestApiKey(): { raw: string; hash: string; keyPrefix: string } {
  return generateApiKey("sk_dns_test");
}

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

