import { createHash } from "node:crypto";

const CLUSTERS = new Set(["mainnet-beta", "devnet"]);
const MODES = new Set(["live", "historical", "historical_replay", "fixture_simulation"]);
const SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function identityFields(event) {
  return {
    type: event.type,
    cluster: event.cluster,
    mode: event.mode,
    subject: event.subject,
    details: event.details ?? {},
  };
}

export function eventDedupKey(event) {
  return `event-dedup:${digest(identityFields(event)).slice(0, 32)}`;
}

export function validateEvent(value) {
  const errors = [];
  if (!isObject(value)) return { valid: false, errors: ["event must be an object"] };
  if (typeof value.type !== "string" || !value.type) errors.push("type is required");
  if (!CLUSTERS.has(value.cluster)) errors.push("cluster must be mainnet-beta or devnet");
  if (!MODES.has(value.mode)) errors.push("mode is invalid");
  if (value.mode === "fixture_simulation" && value.cluster !== "devnet") {
    errors.push("fixture_simulation requires devnet cluster");
  }
  if (!Number.isFinite(Date.parse(value.occurredAt))) errors.push("occurredAt must be an ISO timestamp");
  if (!isObject(value.subject) || typeof value.subject.type !== "string" || typeof value.subject.id !== "string") {
    errors.push("subject.type and subject.id are required");
  }
  if (!SEVERITIES.has(value.severity)) errors.push("severity is invalid");
  if (typeof value.uncertainty !== "string" || !value.uncertainty) errors.push("uncertainty is required");
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length === 0
      || value.evidenceIds.some(id => typeof id !== "string" || !id)) {
    errors.push("evidenceIds requires at least one evidence ID");
  }
  if (typeof value.recommendedAction !== "string" || !value.recommendedAction.trim()) {
    errors.push("recommendedAction is required");
  }
  return { valid: errors.length === 0, errors };
}

export function createEvent(input) {
  const copy = structuredClone(input);
  const validation = validateEvent(copy);
  if (!validation.valid) throw new TypeError(`invalid_event: ${validation.errors.join("; ")}`);
  const dedupKey = eventDedupKey(copy);
  return Object.freeze({
    ...copy,
    evidenceIds: Object.freeze([...copy.evidenceIds]),
    dedupKey,
    id: `event:${digest({ dedupKey, occurredAt: copy.occurredAt, evidenceIds: [...copy.evidenceIds].sort() }).slice(0, 32)}`,
  });
}

export const eventContract = Object.freeze({
  clusters: Object.freeze([...CLUSTERS]),
  modes: Object.freeze([...MODES]),
  severities: Object.freeze([...SEVERITIES]),
});
