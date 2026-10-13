export function assessIndexerFreshness({ newestBlockTime, now, maxAgeSeconds }) {
  if (newestBlockTime === null || newestBlockTime === undefined) {
    return {
      status: "unavailable",
      ageSeconds: null,
      usable: false,
      reason: "no_indexed_transactions",
    };
  }

  const ageSeconds = Math.max(0, now - newestBlockTime);
  if (ageSeconds > maxAgeSeconds) {
    return {
      status: "stale",
      ageSeconds,
      usable: true,
      reason: "source_age_exceeded",
    };
  }

  return {
    status: "live",
    ageSeconds,
    usable: true,
    reason: null,
  };
}
