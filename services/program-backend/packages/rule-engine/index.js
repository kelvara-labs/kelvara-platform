const OPERATORS = new Set([
  "equals",
  "greater_than",
  "less_than",
  "percent_change_greater_than",
  "freshness_greater_than",
  "source_disagreement",
]);
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export function validateRule(rule) {
  const errors = [];
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return { valid: false, errors: ["rule must be an object"] };
  if (typeof rule.id !== "string" || !rule.id) errors.push("id is required");
  if (!Number.isInteger(rule.version) || rule.version < 1) errors.push("version must be a positive integer");
  if (typeof rule.name !== "string" || !rule.name.trim()) errors.push("name is required");
  if (!SAFE_FIELD.test(rule.field ?? "")) errors.push("field is unsafe or invalid");
  if (rule.previousField !== undefined && !SAFE_FIELD.test(rule.previousField)) errors.push("previousField is unsafe or invalid");
  if (!OPERATORS.has(rule.operator)) errors.push("operator is unsupported");
  if (rule.threshold === undefined) errors.push("threshold is required");
  if (rule.nearThresholdPercent !== undefined && (!Number.isFinite(rule.nearThresholdPercent) || rule.nearThresholdPercent < 0)) {
    errors.push("nearThresholdPercent must be non-negative");
  }
  if (typeof rule.recommendedAction !== "string" || !rule.recommendedAction.trim()) errors.push("recommendedAction is required");
  return { valid: errors.length === 0, errors };
}

function unknown(rule, evidence, reason) {
  return {
    ruleId: rule?.id ?? null,
    ruleVersion: rule?.version ?? null,
    status: "unknown",
    reason,
    evidenceIds: evidence?.id ? [evidence.id] : [],
    severity: rule?.severity ?? "unknown",
    recommendedAction: rule?.recommendedAction ?? "Collect valid evidence before deciding.",
  };
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nearBoundary(value, threshold, percent, direction) {
  if (!percent || threshold === 0) return false;
  const margin = Math.abs(threshold) * (percent / 100);
  return direction === "greater" ? value >= threshold - margin : value <= threshold + margin;
}

export function evaluateRule(rule, evidence) {
  const validation = validateRule(rule);
  if (!validation.valid) return unknown(rule, evidence, `invalid_rule: ${validation.errors.join("; ")}`);
  if (!evidence) return unknown(rule, evidence, "missing_evidence");
  if (["stale", "unavailable", "disagreement"].includes(evidence.state)) return unknown(rule, evidence, `evidence_${evidence.state}`);
  if (evidence.freshness?.status === "stale") return unknown(rule, evidence, "evidence_stale");

  let breach = false;
  let review = false;
  let actual;
  const threshold = rule.threshold;

  if (rule.operator === "freshness_greater_than") {
    actual = numeric(evidence.freshness?.ageMs);
    if (actual === null || numeric(threshold) === null) return unknown(rule, evidence, "missing_numeric_value");
    breach = actual > threshold;
    review = !breach && nearBoundary(actual, threshold, rule.nearThresholdPercent, "greater");
  } else {
    actual = evidence.value?.[rule.field];
    if (actual === undefined || actual === null) return unknown(rule, evidence, "missing_field");
    if (rule.operator === "equals") breach = actual !== threshold;
    else if (rule.operator === "source_disagreement") breach = Boolean(actual) === Boolean(threshold);
    else if (rule.operator === "greater_than" || rule.operator === "less_than") {
      if (numeric(actual) === null || numeric(threshold) === null) return unknown(rule, evidence, "missing_numeric_value");
      breach = rule.operator === "greater_than" ? actual > threshold : actual < threshold;
      review = !breach && nearBoundary(actual, threshold, rule.nearThresholdPercent, rule.operator === "greater_than" ? "greater" : "less");
    } else if (rule.operator === "percent_change_greater_than") {
      const previous = evidence.value?.[rule.previousField];
      if (numeric(actual) === null || numeric(previous) === null || previous === 0 || numeric(threshold) === null) {
        return unknown(rule, evidence, "missing_numeric_value");
      }
      actual = Math.abs(((actual - previous) / previous) * 100);
      breach = actual > threshold;
      review = !breach && nearBoundary(actual, threshold, rule.nearThresholdPercent, "greater");
    }
  }

  return {
    ruleId: rule.id,
    ruleVersion: rule.version,
    status: breach ? "breach" : review ? "review" : "pass",
    reason: breach ? "threshold_breached" : review ? "near_threshold" : "condition_not_met",
    actual,
    threshold,
    evidenceIds: [evidence.id],
    cluster: evidence.cluster,
    severity: rule.severity,
    recommendedAction: rule.recommendedAction,
  };
}

export function summarizeRule(rule) {
  const labels = {
    equals: "differs from",
    greater_than: "is greater than",
    less_than: "is less than",
    percent_change_greater_than: "changes by more than",
    freshness_greater_than: "evidence age is greater than",
    source_disagreement: "reports source disagreement equal to",
  };
  const near = rule.nearThresholdPercent ? ` Review within ${rule.nearThresholdPercent}% of the threshold.` : "";
  return `Breach when ${rule.field} ${labels[rule.operator] ?? rule.operator} ${rule.threshold}.${near}`;
}

export const ruleOperators = Object.freeze([...OPERATORS]);
