import { createIngestionRunner } from "./runner.js";
import { runDiskGovernor } from "../../platform/storage/disk-governor.js";

export function createIndexerRuntime({
  statusStore,
  consumerStore,
  runStep,
  inspectSource,
  maintenance = null,
  now,
  highResolutionNow,
}) {
  const runner = createIngestionRunner({
    runStep,
    inspectSource,
    writeStatus: status => statusStore.write(status),
    recordTelemetry: sample => consumerStore.recordTelemetry(sample),
    recordIncident: incident => consumerStore.recordIncident(incident),
    initialStatus: statusStore.read(),
    ...(now ? { now } : {}),
    ...(highResolutionNow ? { highResolutionNow } : {}),
  });

  return {
    runOnce: runner.runOnce,
    getStatus: runner.getStatus,
    runMaintenance() {
      if (!maintenance) return null;
      return runDiskGovernor({
        diskStats: maintenance.diskStats,
        compact: maintenance.compact,
        pruneTelemetry: maintenance.pruneTelemetry,
      });
    },
  };
}
