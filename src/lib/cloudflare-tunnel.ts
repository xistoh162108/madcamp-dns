import { cloudflareError, internalError } from "./errors.js";

// Separate base path AND separate credential from src/lib/cloudflare.ts —
// Cloudflare Tunnel management is account-scoped (/accounts/{account_id}/...),
// not zone-scoped (/zones/{zone_id}/...) like the existing DNS-record wrapper.
// Kept as its own file/token on purpose: a bug here has zero blast radius on
// the already-hardened, already-in-production DNS wrapper.
const CF_BASE = "https://api.cloudflare.com/client/v4";
const CF_TIMEOUT_MS = 10_000;

function getTunnelConfig(): { accountId: string; apiToken: string } {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_TUNNEL_API_TOKEN;
  if (!accountId || !apiToken) {
    throw internalError("Cloudflare Tunnel credentials are not configured.");
  }
  return { accountId, apiToken };
}

async function cfTunnelFetch(path: string, init: RequestInit): Promise<unknown> {
  const { apiToken } = getTunnelConfig();

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
      throw cloudflareError("Cloudflare Tunnel API request timed out after 10 seconds.");
    }
    throw cloudflareError("Failed to reach Cloudflare Tunnel API.", {
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
    throw Object.assign(
      cloudflareError(firstError?.message ?? "Cloudflare Tunnel API error", {
        errors: body.errors,
      }),
      { cfCode: firstError?.code, httpStatus: res.status }
    );
  }

  return body;
}

export interface CloudflareTunnel {
  id: string;
  name: string;
}

export async function createTunnel(name: string): Promise<CloudflareTunnel> {
  const { accountId } = getTunnelConfig();
  const body = (await cfTunnelFetch(`/accounts/${accountId}/cfd_tunnel`, {
    method: "POST",
    // config_src: "cloudflare" — ingress is managed remotely via the
    // Configuration API (putIngressConfig below), never via a config.yml
    // file on the student's own VM.
    body: JSON.stringify({ name, config_src: "cloudflare" }),
  })) as { result: CloudflareTunnel };
  return body.result;
}

export async function deleteTunnel(cloudflareTunnelId: string): Promise<void> {
  const { accountId } = getTunnelConfig();
  // Force-close any live cloudflared connections first — Cloudflare will
  // otherwise refuse to delete a tunnel that still has active connectors.
  await cfTunnelFetch(`/accounts/${accountId}/cfd_tunnel/${cloudflareTunnelId}/connections`, {
    method: "DELETE",
  }).catch(() => {
    // Best-effort: if there were no connections to close, or the tunnel is
    // already gone, this call may itself fail — fall through to the delete
    // below, which is unconditionally idempotent (see next comment).
  });

  // Empirically confirmed against a real account: DELETE on an already-gone
  // (or never-existed) tunnel ID still returns 200 { success: true } rather
  // than an error — Cloudflare's tunnel delete is unconditionally idempotent,
  // so no not-found special-casing is needed here (unlike deleteDnsRecord()
  // in cloudflare.ts, which does need one for the DNS-record delete endpoint).
  await cfTunnelFetch(`/accounts/${accountId}/cfd_tunnel/${cloudflareTunnelId}`, {
    method: "DELETE",
  });
}

export async function getConnectorToken(cloudflareTunnelId: string): Promise<string> {
  const { accountId } = getTunnelConfig();
  const body = (await cfTunnelFetch(`/accounts/${accountId}/cfd_tunnel/${cloudflareTunnelId}/token`, {
    method: "GET",
  })) as { result: string };
  return body.result;
}

export interface IngressHostname {
  hostname: string;
  localPort: number;
}

interface IngressRule {
  hostname?: string;
  service: string;
}

// Pure function — no network/DB access. Maps each hostname to a loopback-only
// service target (never a student-supplied host) and appends the mandatory
// trailing catch-all as the last entry. Cloudflare's ingress config requires
// the LAST rule to have no `hostname` field, matching all otherwise-unrouted
// traffic; every hostname add/remove must recompute this full array, since
// the Configuration API replaces the whole ingress list, not incrementally.
export function buildIngressRules(hostnames: IngressHostname[]): IngressRule[] {
  const rules: IngressRule[] = hostnames.map((h) => ({
    hostname: h.hostname,
    service: `http://127.0.0.1:${h.localPort}`,
  }));
  rules.push({ service: "http_status:404" });
  return rules;
}

export async function putIngressConfig(
  cloudflareTunnelId: string,
  hostnames: IngressHostname[]
): Promise<void> {
  const { accountId } = getTunnelConfig();
  await cfTunnelFetch(`/accounts/${accountId}/cfd_tunnel/${cloudflareTunnelId}/configurations`, {
    method: "PUT",
    body: JSON.stringify({ config: { ingress: buildIngressRules(hostnames) } }),
  });
}

// In-memory mutex, one per tunnel, serializing the read-existing-hostnames-
// then-PUT-ingress-config sequence below. The Configuration API replaces the
// whole ingress array on every call (see buildIngressRules), so two
// concurrent recomputes for the SAME tunnel (e.g. one request adding a
// hostname, another deleting a different one) would otherwise both read a
// stale list and whichever PUT lands last would silently drop the other's
// change. Correct ONLY because this API runs as a single Node.js process —
// DEPLOYMENT.md already documents that clustering requires moving rate
// limiting to Redis first; a multi-instance deployment would need a
// cross-process lock here too (e.g. the same pg_advisory_xact_lock pattern
// src/lib/subdomain.ts uses for subdomain claims).
const tunnelLocks = new Map<string, Promise<unknown>>();

export async function withTunnelLock<T>(tunnelId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tunnelLocks.get(tunnelId) ?? Promise.resolve();
  const current = previous.then(fn, fn);
  tunnelLocks.set(tunnelId, current.catch(() => {}));
  return current;
}

// Recompute a tunnel's full ingress list from its current DB rows (optionally
// with one extra candidate not yet committed, for the create path) and PUT
// it to Cloudflare — always under withTunnelLock. Shared by every call site
// that needs to sync ingress state, so the lock can never accidentally be
// forgotten at a new call site.
export async function syncTunnelIngress(
  prisma: {
    tunnelHostname: {
      findMany: (args: { where: { tunnelId: string } }) => Promise<Array<{ fqdn: string; localPort: number }>>;
    };
  },
  tunnelId: string,
  cloudflareTunnelId: string,
  extra?: { fqdn: string; localPort: number }
): Promise<void> {
  await withTunnelLock(tunnelId, async () => {
    const existing = await prisma.tunnelHostname.findMany({ where: { tunnelId } });
    const all = extra ? [...existing, extra] : existing;
    await putIngressConfig(cloudflareTunnelId, all.map((h) => ({ hostname: h.fqdn, localPort: h.localPort })));
  });
}
