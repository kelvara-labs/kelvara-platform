import { evaluateWalletSafeguards, validateWalletSafeguardPolicy } from './wallet-safeguard-policy.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIELDS = new Set(['receiptId', 'idempotencyKey', 'policyRevision', 'ruleId', 'ruleVersion', 'bindingId', 'targetId', 'evidenceRefs', 'evaluatorVersion', 'result', 'evaluatedAt', 'observedAt', 'provenance']);
function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freezeDeep(child); Object.freeze(value); }
  return value;
}
function id(value, name) { if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function timestamp(value, name) { if (typeof value !== 'string' || !ISO.test(value) || new Date(value).toISOString() !== value) throw new TypeError(`${name} is invalid`); return value; }
function enrollment(value) { return id(value, 'enrollmentId'); }

export function evaluateWalletSafeguardReceipt({ policy: inputPolicy, enrollmentId, bindingId, ruleId, ruleVersion, receiptId, idempotencyKey, evidenceRef, evidence, now = new Date().toISOString() }) {
  const policy = validateWalletSafeguardPolicy(inputPolicy, { requireHash: true });
  enrollment(enrollmentId); id(bindingId, 'bindingId'); id(ruleId, 'ruleId'); id(receiptId, 'receiptId'); id(idempotencyKey, 'idempotencyKey'); id(evidenceRef, 'evidenceRef');
  if (!Number.isSafeInteger(ruleVersion) || ruleVersion < 1) throw new TypeError('ruleVersion is invalid');
  timestamp(now, 'now');
  const evaluation = evaluateWalletSafeguards({ policy, evidence, now });
  const unknown = evaluation.results.some(item => item.result === 'unknown');
  const result = unknown ? 'unknown' : (evaluation.authorized ? 'fail' : 'pass');
  const observedAt = timestamp(evidence.observedAt, 'observedAt');
  const evaluatedAt = timestamp(evidence.evaluatedAt, 'evaluatedAt');
  const receipt = {
    receiptId, idempotencyKey, policyRevision: policy.policyRevision, ruleId, ruleVersion, bindingId, targetId: policy.targetId,
    evidenceRefs: [evidenceRef], evaluatorVersion: policy.evaluatorVersion, result, evaluatedAt, observedAt,
    provenance: { sourceId: evidence.source, schemaVersion: evidence.evidenceSchema, producerVersion: evidence.evaluatorVersion, actionType: policy.actionType, policyHash: policy.policyHash, policyVersion: policy.policyVersion }
  };
  for (const key of Object.keys(receipt)) if (!FIELDS.has(key)) throw new TypeError(`unknown receipt field: ${key}`);
  return freezeDeep(receipt);
}
