import { resolve } from "node:path";
import { createIndexerRuntime } from "./runtime.js";
import { createDaemonPolicy, createCycleController } from "./daemon-policy.js";
import { runIndexerStep } from "./process.js";
import { inspectIndexer } from "./inspect.js";
import { createJsonStatusStore } from "./status-store.js";
import { createConsumerStore } from "../../platform/storage/consumer-store.js";
import { compactTelemetry, retentionFromEnv } from "../../platform/storage/retention.js";
import { evaluateDiskPressure, readDiskStats } from "../../platform/storage/disk-governor.js";

const indexerDir = resolve(process.env.KELVARA_INDEXER_DIR || "/home/andy/kelvara-build/[codebase]/indexer_anchor_protocol");
const dbPath = resolve(process.env.KELVARA_INDEXER_DB_PATH || `${indexerDir}/indexer.db`);
const statusPath = resolve(process.env.KELVARA_INGESTION_STATUS_PATH || "./var/ingestion-status.json");
const maintenanceStatusPath = resolve(process.env.KELVARA_MAINTENANCE_STATUS_PATH || "./var/maintenance-status.json");
const consumerDbPath = resolve(process.env.KELVARA_DB_PATH || "./var/kelvara.sqlite");
const intervalMs = Number(process.env.KELVARA_INGESTION_INTERVAL_MS || 15_000);
const timeoutMs = Number(process.env.KELVARA_INDEXER_STEP_TIMEOUT_MS || 120_000);
const processLimit = Number(process.env.KELVARA_PROCESS_LIMIT || 25);
const once = process.argv.includes("--once");
const statusStore = createJsonStatusStore(statusPath);
const maintenanceStatusStore = createJsonStatusStore(maintenanceStatusPath);
const consumerStore = createConsumerStore({ path: consumerDbPath });
const retention = retentionFromEnv();
let shuttingDown = false;
let activeSignal = null;
let interval = null;

const runtime = createIndexerRuntime({
  statusStore,
  consumerStore,
  runStep: step => runIndexerStep(step, { indexerDir, timeoutMs, processLimit, signal: activeSignal }),
  inspectSource: () => inspectIndexer(dbPath, { maxAgeSeconds: Math.ceil(intervalMs / 1000) * 3 }),
});
const policy = createDaemonPolicy({
  runCycle: () => runtime.runOnce(),
  runRoutineMaintenance: () => compactTelemetry(consumerStore, { policy: retention }),
  evaluatePressure: () => {
    const maxBytes = consumerStore.getSetting("evidence_quota_bytes")?.value ?? 50 * 1024 ** 3;
    const pressure = evaluateDiskPressure(readDiskStats(consumerDbPath), { maxBytes });
    return { ...pressure, pauseOptionalBackfill: pressure.action === "pause-backfill" };
  },
  writeMaintenanceStatus: status => maintenanceStatusStore.write(status),
  initialMaintenanceStatus: maintenanceStatusStore.read(),
});

const cycleController = createCycleController({
  runCycle: async signal => {
    activeSignal = signal;
    try {
      const result = await policy.cycle();
      console.log(JSON.stringify({ type: "ingestion-cycle", result }));
      return result;
    } finally { activeSignal = null; }
  },
});

async function cycle() {
  if (shuttingDown) return { ok: false, skipped: true, reason: "shutdown" };
  return cycleController.run();
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (interval) clearInterval(interval);
  cycleController.abort();
  await Promise.race([
    cycleController.waitForIdle(),
    new Promise(resolveWait => setTimeout(resolveWait, 10_000)),
  ]);
  consumerStore.checkpoint("TRUNCATE");
  consumerStore.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const result = await cycle();
if (once) {
  consumerStore.close();
  process.exit(result.ok ? 0 : 1);
}
interval = setInterval(cycle, intervalMs);
