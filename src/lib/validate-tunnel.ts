import { invalidRequest } from "./errors.js";

const MIN_UNPRIVILEGED_PORT = 1024;
const MAX_PORT = 65535;

// Blocklist, not a hard security boundary — a student who wants to expose SSH
// on a non-default port defeats this entirely, since they fully control their
// own VM. This deters the common *accidental* foot-guns (default-port
// databases/admin panels left open), not a determined bad actor.
const BLOCKED_LOCAL_PORTS = new Set([
  22, 25, 111,                           // SSH, SMTP, rpcbind
  2375, 2376, 2379, 2380,                // Docker daemon, etcd
  3306, 3389, 5432, 5601, 5900,          // MySQL, RDP, Postgres, Kibana, VNC
  6379, 9090, 9200, 9300, 11211, 15672,  // Redis, Prometheus, Elasticsearch, Memcached, RabbitMQ
]);

export function validateLocalPort(port: unknown): number {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PORT) {
    throw invalidRequest(`Local port must be an integer between 1 and ${MAX_PORT}.`);
  }
  if (n < MIN_UNPRIVILEGED_PORT) {
    throw invalidRequest(`Local port must be ${MIN_UNPRIVILEGED_PORT} or higher (privileged ports are blocked).`);
  }
  if (BLOCKED_LOCAL_PORTS.has(n)) {
    throw invalidRequest(`Port ${n} is reserved for infrastructure services and cannot be tunneled.`);
  }
  return n;
}
