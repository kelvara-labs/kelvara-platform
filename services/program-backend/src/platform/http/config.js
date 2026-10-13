import { resolve } from "node:path";

function positiveInteger(value, name, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function resolveServerConfig(env = process.env) {
  const host = env.HOST || "127.0.0.1";
  const operationsToken = env.KELVARA_OPERATIONS_TOKEN || null;
  if (!isLoopback(host) && !operationsToken) {
    throw new Error("KELVARA_OPERATIONS_TOKEN is required for non-loopback HOST");
  }
  return {
    host,
    port: positiveInteger(env.PORT, "PORT", 7610),
    operationsToken,
    consumerDbPath: resolve(env.KELVARA_DB_PATH || "./var/kelvara.sqlite"),
    statusPath: resolve(env.KELVARA_INGESTION_STATUS_PATH || "./var/ingestion-status.json"),
    maintenanceStatusPath: resolve(env.KELVARA_MAINTENANCE_STATUS_PATH || "./var/maintenance-status.json"),
  };
}
