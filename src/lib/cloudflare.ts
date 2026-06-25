import { cloudflareError, internalError } from "./errors.js";
import type { AllowedType } from "./validate-dns.js";

const CF_BASE = "https://api.cloudflare.com/client/v4";
const CF_TIMEOUT_MS = 10_000;

// Cloudflare error code for "Record does not exist"
const CF_NOT_FOUND_CODE = 81044;

function getConfig(): { zoneId: string; apiToken: string } {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!zoneId || !apiToken) {
    throw internalError("Cloudflare credentials are not configured.");
  }
  return { zoneId, apiToken };
}

async function cfFetch(path: string, init: RequestInit): Promise<unknown> {
  const { apiToken } = getConfig();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CF_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${CF_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw cloudflareError("Cloudflare API request timed out after 10 seconds.");
    }
    throw cloudflareError("Failed to reach Cloudflare API.", {
      cause: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }

  const body = (await res.json()) as {
    success: boolean;
    errors?: Array<{ message: string; code: number }>;
    result?: unknown;
  };

  if (!body.success) {
    const firstError = body.errors?.[0];
    // Surface the CF error code so callers can handle specific cases
    throw Object.assign(
      cloudflareError(firstError?.message ?? "Cloudflare API error", {
        errors: body.errors,
      }),
      { cfCode: firstError?.code }
    );
  }

  return body;
}

export interface CreateDnsInput {
  name: string; // FQDN
  type: AllowedType;
  content: string;
  ttl: number;
  proxied: boolean;
}

export interface CloudflareDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied: boolean;
}

export async function createDnsRecord(input: CreateDnsInput): Promise<CloudflareDnsRecord> {
  const { zoneId } = getConfig();
  const body = (await cfFetch(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify(input),
  })) as { result: CloudflareDnsRecord };
  return body.result;
}

export interface PatchDnsInput {
  name?: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
}

export async function patchDnsRecord(
  cloudflareRecordId: string,
  patch: PatchDnsInput
): Promise<CloudflareDnsRecord> {
  const { zoneId } = getConfig();
  const body = (await cfFetch(`/zones/${zoneId}/dns_records/${cloudflareRecordId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })) as { result: CloudflareDnsRecord };
  return body.result;
}

export async function deleteDnsRecord(cloudflareRecordId: string): Promise<void> {
  const { zoneId } = getConfig();
  try {
    await cfFetch(`/zones/${zoneId}/dns_records/${cloudflareRecordId}`, {
      method: "DELETE",
    });
  } catch (err: unknown) {
    // Treat "record does not exist" as success — idempotent delete
    const cfErr = err as { cfCode?: number };
    if (cfErr?.cfCode === CF_NOT_FOUND_CODE) return;
    throw err;
  }
}
