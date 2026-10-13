const CLUSTERS = new Set(["mainnet-beta", "devnet"]);
const STATES = new Set(["active", "degraded", "unavailable", "stale", "disagreement"]);
const CONFIDENCE = new Set(["verified", "single_source", "estimated", "unknown"]);
const COVERAGE = new Set(["complete", "partial", "none"]);
const FRESHNESS = new Set(["fresh", "stale", "unknown"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function deepFreeze(value) {
  if (!isObject(value) && !Array.isArray(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function validateEvidence(value) {
  const errors = [];
  if (!isObject(value)) return { valid: false, errors: ["evidence must be an object"] };
  if (typeof value.id !== "string" || !value.id) errors.push("id is required");
  if (typeof value.kind !== "string" || !value.kind) errors.push("kind is required");
  if (!CLUSTERS.has(value.cluster)) errors.push("cluster must be mainnet-beta or devnet");
  if (!isObject(value.source)) errors.push("source is required");
  else {
    if (typeof value.source.id !== "string" || !value.source.id) errors.push("source.id is required");
    if (typeof value.source.type !== "string" || !value.source.type) errors.push("source.type is required");
  }
  if (!isTimestamp(value.observedAt)) errors.push("observedAt must be an ISO timestamp");
  if (!isTimestamp(value.fetchedAt)) errors.push("fetchedAt must be an ISO timestamp");
  if (isTimestamp(value.observedAt) && isTimestamp(value.fetchedAt)
      && Date.parse(value.observedAt) > Date.parse(value.fetchedAt)) {
    errors.push("observedAt cannot be after fetchedAt");
  }
  if (!isObject(value.freshness) || !FRESHNESS.has(value.freshness.status)) {
    errors.push("freshness.status must be fresh, stale, or unknown");
  }
  if (!CONFIDENCE.has(value.confidence)) errors.push("confidence is invalid");
  if (!COVERAGE.has(value.coverage)) errors.push("coverage is invalid");
  if (!STATES.has(value.state)) errors.push("state is invalid");
  return { valid: errors.length === 0, errors };
}

export function createEvidence(input) {
  const copy = structuredClone(input);
  const result = validateEvidence(copy);
  if (!result.valid) throw new TypeError(`invalid_evidence: ${result.errors.join("; ")}`);
  return deepFreeze(copy);
}

export function conclusionState(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return "unknown";
  const clusters = new Set(evidence.map(item => item.cluster));
  if (clusters.size > 1) throw new TypeError("mixed_clusters");
  if (evidence.some(item => ["stale", "unavailable", "disagreement"].includes(item.state))) return "unknown";
  if (evidence.some(item => item.state === "degraded" || item.coverage !== "complete" || item.confidence !== "verified")) return "review";
  return "healthy";
}

export const evidenceContract = Object.freeze({
  clusters: Object.freeze([...CLUSTERS]),
  states: Object.freeze([...STATES]),
  confidence: Object.freeze([...CONFIDENCE]),
  coverage: Object.freeze([...COVERAGE]),
});
