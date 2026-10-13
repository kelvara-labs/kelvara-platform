import { createHash } from 'node:crypto';

const RESULTS = new Set(['pass', 'fail', 'unknown', 'stale']);
const FIELDS = new Set(['receiptId', 'idempotencyKey', 'policyRevision', 'ruleId', 'ruleVersion', 'bindingId', 'targetId', 'evidenceRefs', 'evaluatorVersion', 'result', 'evaluatedAt', 'observedAt', 'provenance']);
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function text(value, name, max = 128) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}
function id(value, name) { const result = text(value, name); if (!ID.test(result)) throw new TypeError(`${name} is invalid`); return result; }
function positiveInteger(value, name) { if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`); return value; }
function strictJson(value, path = 'value', state = { depth: 0, nodes: 0, keys: 0 }) {
  state.nodes += 1;
  if (state.nodes > 256 || state.depth > 16) throw new TypeError(`${path} is too complex`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => strictJson(item, `${path}[${index}]`, { ...state, depth: state.depth + 1 }));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value);
    state.keys += keys.length;
    if (state.keys > 128) throw new TypeError(`${path} has too many keys`);
    return Object.fromEntries(keys.sort().map(key => [key, strictJson(value[key], `${path}.${key}`, { ...state, depth: state.depth + 1 })]));
  }
  throw new TypeError(`${path} must be JSON-safe`);
}
function canonical(value) { return JSON.stringify(strictJson(value)); }
function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function jsonObject(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`); return strictJson(value, name); }

export function validateEvaluationReceipt(value, now = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('receipt must be an object');
  for (const key of Object.keys(value)) if (!FIELDS.has(key)) throw new TypeError(`unknown receipt field: ${key}`);
  const receipt = {
    receiptId: id(value.receiptId, 'receiptId'), idempotencyKey: id(value.idempotencyKey, 'idempotencyKey'),
    policyRevision: positiveInteger(value.policyRevision, 'policyRevision'), ruleId: id(value.ruleId, 'ruleId'),
    ruleVersion: positiveInteger(value.ruleVersion, 'ruleVersion'), bindingId: id(value.bindingId, 'bindingId'), targetId: id(value.targetId, 'targetId'),
    evidenceRefs: value.evidenceRefs, evaluatorVersion: text(value.evaluatorVersion, 'evaluatorVersion', 64), result: value.result,
    evaluatedAt: value.evaluatedAt, observedAt: value.observedAt, provenance: jsonObject(value.provenance, 'provenance')
  };
  if (!Array.isArray(receipt.evidenceRefs) || receipt.evidenceRefs.length < 1 || receipt.evidenceRefs.length > 128) throw new TypeError('evidenceRefs must be a non-empty bounded array');
  receipt.evidenceRefs = [...new Set(receipt.evidenceRefs.map((item, index) => id(item, `evidenceRefs[${index}]`)))];
  if (receipt.evidenceRefs.length !== value.evidenceRefs.length) throw new TypeError('evidenceRefs must be unique');
  if (!RESULTS.has(receipt.result)) throw new TypeError('result is unsupported');
  for (const name of ['evaluatedAt', 'observedAt']) { text(receipt[name], name, 24); if (!ISO.test(receipt[name]) || new Date(receipt[name]).toISOString() !== receipt[name]) throw new TypeError(`${name} must be canonical ISO date`); }
  if (typeof receipt.provenance.sourceId !== 'string' || typeof receipt.provenance.schemaVersion !== 'string' || typeof receipt.provenance.producerVersion !== 'string') throw new TypeError('provenance identifiers are required');
  const evaluated = Date.parse(receipt.evaluatedAt); const observed = Date.parse(receipt.observedAt); const current = now.valueOf();
  if (canonical(receipt.provenance).length > 8192) throw new TypeError('provenance is too large');
  if (observed > evaluated || evaluated > current || observed > current) throw new TypeError('receipt timestamps are out of order');
  return receipt;
}

export function listLatestEvaluationReceipts(db, { policyRevision, targetIds }, { now = new Date(), scenarioMaximumAgeMs = 30_000 } = {}) {
  if (!Number.isSafeInteger(policyRevision) || policyRevision < 1) throw new TypeError('policyRevision must be a positive safe integer');
  if (!Array.isArray(targetIds) || targetIds.length < 1 || targetIds.length > 100) throw new RangeError('targetIds must contain 1 to 100 IDs');
  if (new Set(targetIds).size !== targetIds.length || targetIds.some((targetId, index) => !ID.test(targetId))) throw new TypeError('targetIds must be unique valid IDs');
  const placeholders = targetIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT receipt_id,idempotency_key,policy_revision,rule_id,rule_version,binding_id,target_id,evidence_refs_json,evaluator_version,result,evaluated_at,observed_at,provenance_json
    FROM evaluation_receipts WHERE policy_revision=? AND target_id IN (${placeholders})
    ORDER BY policy_revision,binding_id,target_id,rule_id,rule_version,evaluated_at DESC,receipt_id ASC`).all(policyRevision, ...targetIds);
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf()) || !Number.isSafeInteger(scenarioMaximumAgeMs) || scenarioMaximumAgeMs < 1) throw new TypeError('receipt freshness options are invalid');
  const seen = new Set();
  return rows.filter(row => { const identity = [row.policy_revision, row.binding_id, row.target_id, row.rule_id, row.rule_version].join('\u0000'); if (seen.has(identity)) return false; seen.add(identity); return true; }).map(row => { const provenance=JSON.parse(row.provenance_json),scenario=provenance.sourceId==='scenario-capsule-devnet',stale=scenario&&now.valueOf()-Date.parse(row.observed_at)>scenarioMaximumAgeMs;return {
    receiptId: row.receipt_id, idempotencyKey: row.idempotency_key, policyRevision: Number(row.policy_revision), ruleId: row.rule_id, ruleVersion: Number(row.rule_version), bindingId: row.binding_id,
    targetId: row.target_id, evidenceRefs: JSON.parse(row.evidence_refs_json), evaluatorVersion: row.evaluator_version, result: stale?'stale':row.result,
    evaluatedAt: row.evaluated_at, observedAt: row.observed_at, provenance
  }});
}

export function listLatestEvaluationReceiptsByIdentity(db, { policyRevision, identities }) {
  if (!Number.isSafeInteger(policyRevision) || policyRevision < 1) throw new TypeError('policyRevision must be a positive safe integer');
  if (!Array.isArray(identities) || identities.length < 1 || identities.length > 100) throw new RangeError('identities must contain 1 to 100 items');
  const allowed = identities.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['bindingId', 'targetId', 'ruleId', 'ruleVersion'].includes(key)) || !ID.test(item.bindingId) || !ID.test(item.targetId) || !ID.test(item.ruleId) || !Number.isSafeInteger(item.ruleVersion) || item.ruleVersion < 1) throw new TypeError(`identities[${index}] is invalid`);
    return [item.bindingId, item.targetId, item.ruleId, item.ruleVersion].join('\\u0000');
  });
  if (new Set(allowed).size !== allowed.length) throw new TypeError('identities must be unique');
  const rows = db.prepare(`SELECT receipt_id,idempotency_key,policy_revision,rule_id,rule_version,binding_id,target_id,evidence_refs_json,evaluator_version,result,evaluated_at,observed_at,provenance_json FROM evaluation_receipts WHERE policy_revision=? ORDER BY evaluated_at DESC,receipt_id ASC`).all(policyRevision);
  const seen = new Set();
  return rows.filter(row => { const key = [row.binding_id,row.target_id,row.rule_id,row.rule_version].join('\\u0000'); if (!allowed.includes(key) || seen.has(key)) return false; seen.add(key); return true; }).map(row => ({ receiptId: row.receipt_id, idempotencyKey: row.idempotency_key, policyRevision: Number(row.policy_revision), ruleId: row.rule_id, ruleVersion: Number(row.rule_version), bindingId: row.binding_id, targetId: row.target_id, evidenceRefs: JSON.parse(row.evidence_refs_json), evaluatorVersion: row.evaluator_version, result: row.result, evaluatedAt: row.evaluated_at, observedAt: row.observed_at, provenance: JSON.parse(row.provenance_json) }));
}

export function recordEvaluationReceipt(db, input, now = new Date()) {
  const receipt = validateEvaluationReceipt(input, now);
  const payloadHash = digest(receipt);
  const createdAt = now.toISOString();
  const existing = db.prepare('SELECT receipt_id,payload_hash,policy_revision FROM evaluation_receipts WHERE idempotency_key=?').get(receipt.idempotencyKey);
  if (existing) {
    if (existing.payload_hash !== payloadHash) throw new Error('receipt_idempotency_conflict');
    return { inserted: false, receiptId: existing.receipt_id, policyRevision: Number(existing.policy_revision) };
  }
  const existingReceipt = db.prepare('SELECT receipt_id FROM evaluation_receipts WHERE receipt_id=?').get(receipt.receiptId);
  if (existingReceipt) throw new Error('receipt_id_conflict');
  try {
    db.prepare(`INSERT INTO evaluation_receipts
      (receipt_id,idempotency_key,payload_hash,policy_revision,rule_id,rule_version,binding_id,target_id,evidence_refs_json,evaluator_version,result,evaluated_at,observed_at,provenance_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      receipt.receiptId, receipt.idempotencyKey, payloadHash, receipt.policyRevision, receipt.ruleId, receipt.ruleVersion,
      receipt.bindingId, receipt.targetId, canonical(receipt.evidenceRefs), receipt.evaluatorVersion, receipt.result,
      receipt.evaluatedAt, receipt.observedAt, canonical(receipt.provenance), createdAt);
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) {
      const concurrent = db.prepare('SELECT receipt_id,payload_hash,policy_revision FROM evaluation_receipts WHERE idempotency_key=?').get(receipt.idempotencyKey);
      if (concurrent?.payload_hash === payloadHash) return { inserted: false, receiptId: concurrent.receipt_id, policyRevision: Number(concurrent.policy_revision) };
      if (concurrent) throw new Error('receipt_idempotency_conflict');
      throw new Error('receipt_id_conflict');
    }
    throw error;
  }
  return { inserted: true, receiptId: receipt.receiptId, policyRevision: receipt.policyRevision };
}
