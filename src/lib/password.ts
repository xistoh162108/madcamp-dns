import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const KEY_LEN = 64;

// Format: scrypt$<salt hex>$<hash hex>
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltHex, hashHex] = stored.split("$");
  if (algo !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Dummy hash so failed lookups (unknown team) cost the same as a wrong password.
let dummyHash: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

const PW_ALPHABET = "abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generatePassword(length = 12): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += PW_ALPHABET[b % PW_ALPHABET.length];
  return out;
}

export const PASSWORD_MIN = 10;

// Rejects passwords built from the account's own identifiers.
export function passwordProblem(password: string, account: { subdomain: string; email: string }): string | null {
  if (password.length < PASSWORD_MIN) return `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`;
  const pw = password.toLowerCase();
  const local = account.email.split("@")[0].toLowerCase();
  for (const id of [account.subdomain.toLowerCase(), local]) {
    if (id.length >= 3 && pw.includes(id)) return "비밀번호에 ID나 이메일을 넣을 수 없습니다.";
  }
  if (/^(.)\1+$/.test(password)) return "같은 문자만 반복된 비밀번호는 쓸 수 없습니다.";
  return null;
}

export function generatePasswordFor(account: { subdomain: string; email: string }): string {
  for (;;) {
    const pw = generatePassword();
    if (!passwordProblem(pw, account)) return pw;
  }
}
