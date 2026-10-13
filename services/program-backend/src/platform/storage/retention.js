export const DEFAULT_RETENTION = Object.freeze({
  rawSeconds: 72 * 3600,
  minuteSeconds: 7 * 86400,
  fifteenMinuteSeconds: 90 * 86400,
  hourSeconds: 730 * 86400,
});

export function retentionFromEnv(env = process.env) {
  const policy = {
    rawSeconds: Number(env.KELVARA_RETENTION_RAW_SECONDS ?? DEFAULT_RETENTION.rawSeconds),
    minuteSeconds: Number(env.KELVARA_RETENTION_1M_SECONDS ?? DEFAULT_RETENTION.minuteSeconds),
    fifteenMinuteSeconds: Number(env.KELVARA_RETENTION_15M_SECONDS ?? DEFAULT_RETENTION.fifteenMinuteSeconds),
    hourSeconds: Number(env.KELVARA_RETENTION_1H_SECONDS ?? DEFAULT_RETENTION.hourSeconds),
  };
  const values = Object.values(policy);
  if (values.some(value => !Number.isFinite(value) || value <= 0)
    || policy.rawSeconds > policy.minuteSeconds
    || policy.minuteSeconds > policy.fifteenMinuteSeconds
    || policy.fifteenMinuteSeconds > policy.hourSeconds) throw new TypeError("invalid_retention_policy");
  return policy;
}

export function compactTelemetry(store, { now = Math.floor(Date.now() / 1000), policy = DEFAULT_RETENTION } = {}) {
  // Each promotion and source deletion is one transaction. Destination primary keys make retries idempotent.
  const rawCompacted = store.compactRaw({ before: now - policy.rawSeconds, bucketSeconds: 60, tier: "1m" });
  const minuteCompacted = store.compactRollups({ fromTier: "1m", toTier: "15m", before: now - policy.minuteSeconds, bucketSeconds: 900 });
  const fifteenMinuteCompacted = store.compactRollups({ fromTier: "15m", toTier: "1h", before: now - policy.fifteenMinuteSeconds, bucketSeconds: 3600 });
  const hourPruned = store.pruneRollups({ tier: "1h", before: now - policy.hourSeconds });
  return { rawCompacted, minuteCompacted, fifteenMinuteCompacted, hourPruned, policy };
}
