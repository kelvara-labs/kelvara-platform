function baseResult(ruleVersion, binding, normalizedEvidence, observedAt) {
  return {
    ruleId: ruleVersion.ruleId, ruleVersion: ruleVersion.version, bindingId: binding.id,
    targetId: binding.targetId, evaluatorVersion: ruleVersion.evaluatorVersion,
    evidenceRefs: Array.isArray(normalizedEvidence?.evidenceRefs) ? normalizedEvidence.evidenceRefs : [],
    evaluatedAt: observedAt
  };
}

function unknown(result, reason = 'evidence_missing_or_undecodable', diagnostics = {}) {
  return { ...result, result: 'unknown', reason, diagnostics };
}

function evaluateFreshness(result, ruleVersion, evidence, observedAt) {
  const maximumAgeMs = ruleVersion.parameters?.maximumAgeMs;
  if (typeof maximumAgeMs !== 'number' || !Number.isFinite(maximumAgeMs) || maximumAgeMs < 0) return unknown(result, 'invalid_rule_parameters');
  const evidenceTime = Date.parse(evidence?.observedAt ?? '');
  if (!evidence || !Number.isFinite(evidenceTime)) return unknown(result);
  const ageMs = Date.parse(observedAt) - evidenceTime;
  if (ageMs < 0 || ageMs > maximumAgeMs) return { ...result, result: 'stale', reason: 'evidence_stale', diagnostics: { ageMs, maximumAgeMs } };
  return { ...result, result: 'pass', reason: 'evidence_fresh', diagnostics: { ageMs, maximumAgeMs } };
}

function evaluateSetMembership(result, ruleVersion, evidence) {
  const { observedField, approved } = ruleVersion.parameters ?? {};
  if (typeof observedField !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(observedField) ||
      !Array.isArray(approved) || approved.length === 0 || approved.some(value => typeof value !== 'string' || value.length === 0)) {
    return unknown(result, 'invalid_rule_parameters');
  }
  const value = evidence?.[observedField];
  if (typeof value !== 'string') return unknown(result);
  const allowed = Object.prototype.hasOwnProperty.call(evidence, observedField);
  if (!allowed) return unknown(result);
  const matches = approved.includes(value);
  return { ...result, result: matches ? 'pass' : 'fail', reason: matches ? 'value_in_approved_set' : 'value_not_in_approved_set', diagnostics: { field: observedField } };
}

export function evaluateRule({ ruleVersion, binding, normalizedEvidence, observedAt }) {
  if (!ruleVersion || !binding || typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) throw new TypeError('ruleVersion, binding, and observedAt are required');
  if (ruleVersion.evaluatorVersion !== '1') return unknown(baseResult(ruleVersion, binding, normalizedEvidence, observedAt), 'unsupported_evaluator_version');
  const result = baseResult(ruleVersion, binding, normalizedEvidence, observedAt);
  if (ruleVersion.evaluatorType === 'freshness' && ruleVersion.evidenceSchema === 'freshness-v1') return evaluateFreshness(result, ruleVersion, normalizedEvidence, observedAt);
  if (ruleVersion.evaluatorType === 'set-membership' && ruleVersion.evidenceSchema === 'authority-v1') return evaluateSetMembership(result, ruleVersion, normalizedEvidence);
  return unknown(result, 'unsupported_evaluator');
}
