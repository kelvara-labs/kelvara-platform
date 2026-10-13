import { statfsSync, statSync } from "node:fs";

export const DISK_THRESHOLDS = Object.freeze({ warning: 0.70, compact: 0.80, prune: 0.85 });

export function readDiskStats(dbPath) {
  const fs = statfsSync(dbPath);
  const totalBytes = Number(fs.blocks) * Number(fs.bsize);
  const freeBytes = Number(fs.bavail) * Number(fs.bsize);
  let dbBytes = 0;
  try { dbBytes = statSync(dbPath).size; } catch {}
  return { totalBytes, freeBytes, dbBytes, telemetryGrowthBytesPerSecond: null };
}

export function evaluateDiskPressure(stats, quota = null) {
  const maxBytes = quota?.maxBytes ?? null;
  const remainingBytes = maxBytes == null ? stats.freeBytes : Math.max(0, maxBytes - stats.dbBytes);
  const utilization = maxBytes != null ? stats.dbBytes / maxBytes : stats.totalBytes > 0 ? 1 - stats.freeBytes / stats.totalBytes : null;
  let action = "normal";
  if (utilization >= DISK_THRESHOLDS.warning) action = "warning";
  if (utilization >= DISK_THRESHOLDS.compact) action = "compact";
  if (utilization >= DISK_THRESHOLDS.prune) action = "prune";
  if (utilization >= DISK_THRESHOLDS.prune && remainingBytes / (maxBytes ?? stats.totalBytes) <= 0.05) action = "pause-backfill";
  const projectedExhaustionSeconds = stats.telemetryGrowthBytesPerSecond > 0 ? remainingBytes / stats.telemetryGrowthBytesPerSecond : null;
  return { ...stats, maxBytes, remainingBytes, utilization, action, thresholds: DISK_THRESHOLDS, projectedExhaustionSeconds };
}

export function runDiskGovernor({ diskStats, compact = () => {}, pruneTelemetry = () => {} }) {
  const result = evaluateDiskPressure(diskStats());
  if (["compact", "prune", "pause-backfill"].includes(result.action)) compact();
  if (["prune", "pause-backfill"].includes(result.action)) pruneTelemetry();
  return { ...result, pauseOptionalBackfill: result.action === "pause-backfill" };
}
