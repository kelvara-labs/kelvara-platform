import { evaluateDiskPressure } from "../../platform/storage/disk-governor.js";

function average(values) {
  const known = values.filter(value => Number.isFinite(value));
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
}

export function createOperationsService({ store, readIngestionStatus, diskStats, inspectIndexers = () => [], retention = null, startedAt = Math.floor(Date.now() / 1000), now = () => Math.floor(Date.now() / 1000) }) {
  return {
    getStatus() {
      const ingestion = readIngestionStatus();
      const retentionStatus = typeof retention === "function" ? retention() : retention;
      const samples = store.listTelemetry({ tier: "raw" });
      const providers = samples.filter(sample => sample.provider);
      const latestByProvider = new Map();
      for (const sample of providers) {
        const previous = latestByProvider.get(sample.provider);
        if (!previous || sample.sampledAt >= previous.sampledAt) latestByProvider.set(sample.provider, sample);
      }
      const currentProviders = [...latestByProvider.values()];
      const successful = samples.filter(sample => sample.success).length;
      const last = samples.at(-1) ?? null;
      return {
        service: { state: ingestion.state ?? "unknown", cycle: ingestion.cycle ?? null, stage: ingestion.stage ?? null, uptimeSeconds: Math.max(0, now() - startedAt) },
        kpis: {
          providerLatencyMs: average(providers.map(sample => sample.latencyMs)),
          sourceLagMs: last?.sourceLagMs ?? null,
          processingLagMs: last?.processingLagMs ?? null,
          backlog: last?.backlog ?? ingestion.lastResult?.source?.counts?.pending ?? null,
          observationSuccessRatio: samples.length ? successful / samples.length : null,
        },
        providers: {
          state: currentProviders.length ? (currentProviders.some(sample => !sample.success) ? "degraded" : "available") : "unknown",
          providerCount: currentProviders.length,
          recentWindow: {
            sampleCount: providers.length,
            successRatio: providers.length ? providers.filter(sample => sample.success).length / providers.length : null,
          },
        },
        storage: evaluateDiskPressure(diskStats(), { maxBytes: store.getSetting?.("evidence_quota_bytes")?.value ?? 50 * 1024 ** 3 }),
        retention: retentionStatus ?? { state: "unknown", lastSuccessfulCompactionAt: null, compactionLagSeconds: null },
        incidents: store.listIncidents(),
      };
    },
    getIndexers() { return { indexers: inspectIndexers() }; },
    getTargets() {
      const targets = store.listTargets();
      const measured = store.getCoverage?.() ?? { walletTargetLinks: targets.reduce((sum, target) => sum + Number(target.walletCount || 0), 0), distinctWallets: null };
      return { targets, coverage: { uniqueTargets: targets.length, ...measured } };
    },
    getHistory({ hours = 24 } = {}) {
      const end = Math.floor(now() / 3600) * 3600;
      const start = end - (hours - 1) * 3600;
      const samples = store.listTelemetry({ tier: "raw" }).filter(sample => sample.provider && sample.sampledAt >= start && sample.sampledAt < end + 3600);
      const providers = [...new Set(samples.map(sample => sample.provider))].sort();
      const buckets = new Map();
      for (const sample of samples) {
        const bucket = Math.floor(sample.sampledAt / 3600) * 3600;
        const group = buckets.get(bucket) ?? [];
        group.push(sample); buckets.set(bucket, group);
      }
      const history = [];
      for (let bucket = start; bucket <= end; bucket += 3600) {
        const group = buckets.get(bucket) ?? [];
        const state = !group.length ? "gap" : group.some(sample => !sample.success || sample.disagreement) ? "adverse" : "healthy";
        history.push({ bucketStart: bucket, state, sampleCount: group.length, successRatio: group.length ? group.filter(sample => sample.success).length / group.length : null });
      }
      return { hours: history, providers };
    },
    getSettings() {
      const stored = store.getSetting?.("evidence_quota_bytes");
      const evidenceQuotaBytes = stored?.value ?? 50 * 1024 ** 3;
      return { evidenceQuotaBytes, evidenceQuotaGb: evidenceQuotaBytes / 1024 ** 3, updatedAt: stored?.updatedAt ?? null };
    },
    updateSettings({ evidenceQuotaGb }) {
      if (!Number.isFinite(evidenceQuotaGb) || evidenceQuotaGb < 1 || evidenceQuotaGb > 10_000) throw new TypeError("invalid_evidence_quota");
      const value = Math.round(evidenceQuotaGb * 1024 ** 3);
      const updatedAt = now();
      store.setSetting("evidence_quota_bytes", value, updatedAt);
      return { evidenceQuotaBytes: value, evidenceQuotaGb, updatedAt };
    },
    getClients() { return { clients: store.listClients() }; },
    getClient(walletId) { return store.getClient(walletId); },
    getWallets() { return { wallets: store.listClients() }; },
    getWallet(walletId) { return store.getClient(walletId); },
  };
}
