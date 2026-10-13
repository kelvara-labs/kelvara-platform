import { createHash } from 'node:crypto';

const TYPES = new Set(['nav_loss', 'apy_drop', 'oracle_staleness', 'authority_change']);
const POLICY_FIELDS = new Set(['walletId', 'targetId', 'network', 'mint', 'destination', 'authority', 'authorizedBps', 'conditions', 'policyVersion', 'policyRevision', 'expectedEvidenceSource', 'evidenceSchema', 'evaluatorVersion', 'actionType', 'combineMode', 'policyHash']);
const CONDITION_FIELDS = { nav_loss: new Set(['type', 'thresholdBps']), apy_drop: new Set(['type', 'thresholdBps']), oracle_staleness: new Set(['type', 'maxAgeSeconds']), authority_change: new Set(['type', 'expected']) };
const EVIDENCE_FIELDS = new Set(['policyHash', 'policyRevision', 'targetId', 'source', 'evidenceSchema', 'evaluatorVersion', 'observedAt', 'evaluatedAt', 'maxAgeSeconds', 'navLossBps', 'apyDropBps', 'oracleAgeSeconds', 'authority', 'eligibleAmountRaw', 'signedCapRaw']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const HASH = /^[a-f0-9]{64}$/;
const MAX_RAW = (1n << 256n) - 1n;

function closedObject(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`unknown field: ${name}.${key}`);
}
function decodeSolana(value, name) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) throw new TypeError(`${name} is invalid`);
  let n = 0n;
  for (const c of value) { const d = BASE58.indexOf(c); if (d < 0) throw new TypeError(`${name} is invalid`); n = n * 58n + BigInt(d); }
  let bytes = 0; while (n) { bytes++; n >>= 8n; }
  let leading = 0; while (leading < value.length && value[leading] === '1') leading++;
  if (bytes + leading !== 32) throw new TypeError(`${name} is invalid`);
  return value;
}
function integer(value, name, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} is invalid`); return value; }
function nonempty(value, name) { if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function raw(value, name, optional = false) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${name} is invalid`);
  const n = BigInt(value); if (n > MAX_RAW) throw new TypeError(`${name} is invalid`); return n;
}
function timestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) throw new TypeError(`${name} is invalid`);
  const t = Date.parse(value);
  if (!Number.isFinite(t) || new Date(t).toISOString() !== value) throw new TypeError(`${name} is invalid`);
  return [value, t];
}
function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freezeDeep(child); Object.freeze(value); }
  return value;
}
function hashPayload(policy) {
  return { walletId: policy.walletId, targetId: policy.targetId, network: policy.network, mint: policy.mint, destination: policy.destination, authority: policy.authority, authorizedBps: policy.authorizedBps, conditions: policy.conditions, policyVersion: policy.policyVersion, policyRevision: policy.policyRevision, expectedEvidenceSource: policy.expectedEvidenceSource, evidenceSchema: policy.evidenceSchema, evaluatorVersion: policy.evaluatorVersion, actionType: policy.actionType, combineMode: policy.combineMode };
}
function hashFor(policy) { return createHash('sha256').update(JSON.stringify(hashPayload(policy))).digest('hex'); }
function target(value) {
  if (typeof value !== 'string') throw new TypeError('targetId is invalid');
  const match = /^([a-z][a-z0-9]{1,31})-(mainnet):([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(value);
  if (!match || match[1] !== 'kamino') throw new TypeError('targetId is invalid');
  decodeSolana(match[3], 'targetId'); return value;
}

export function normalizeWalletSafeguardPolicy(input) {
  closedObject(input, POLICY_FIELDS, 'policy');
  const walletId = decodeSolana(input.walletId, 'walletId'); const targetId = target(input.targetId);
  if (input.network !== 'mainnet') throw new TypeError('network is invalid');
  const mint = decodeSolana(input.mint, 'mint'); const destination = decodeSolana(input.destination, 'destination'); const authority = decodeSolana(input.authority, 'authority');
  const authorizedBps = input.authorizedBps === undefined ? 10000 : integer(input.authorizedBps, 'authorizedBps', 1, 10000);
  const policyVersion = integer(input.policyVersion, 'policyVersion', 1, 2147483647); const policyRevision = integer(input.policyRevision, 'policyRevision', 1, 2147483647);
  const expectedEvidenceSource = nonempty(input.expectedEvidenceSource, 'expectedEvidenceSource'); const evidenceSchema = nonempty(input.evidenceSchema, 'evidenceSchema'); const evaluatorVersion = nonempty(input.evaluatorVersion, 'evaluatorVersion');
  if (input.actionType !== 'permit-backed-evacuation') throw new TypeError('actionType is invalid'); if (input.combineMode !== 'OR') throw new TypeError('combineMode is invalid');
  if (input.policyHash !== undefined && !HASH.test(input.policyHash)) throw new TypeError('policyHash is invalid');
  if (!Array.isArray(input.conditions) || input.conditions.length < 1 || input.conditions.length > 4) throw new TypeError('conditions must contain 1 to 4 items');
  const seen = new Set();
  const conditions = input.conditions.map((condition, i) => { const type = condition?.type; closedObject(condition, CONDITION_FIELDS[type] ?? new Set(), `conditions[${i}]`); if (!TYPES.has(type) || seen.has(type)) throw new TypeError(`conditions[${i}].type is invalid`); seen.add(type); if (type === 'nav_loss' || type === 'apy_drop') return { type, thresholdBps: integer(condition.thresholdBps, 'thresholdBps', 0, 10000) }; if (type === 'oracle_staleness') return { type, maxAgeSeconds: integer(condition.maxAgeSeconds, 'maxAgeSeconds', 1, 31536000) }; return { type, expected: decodeSolana(condition.expected, 'expected') }; }).sort((a, b) => a.type.localeCompare(b.type));
  const result = { walletId, targetId, network: 'mainnet', mint, destination, authority, authorizedBps, conditions, policyVersion, policyRevision, expectedEvidenceSource, evidenceSchema, evaluatorVersion, actionType: 'permit-backed-evacuation', combineMode: 'OR' };
  if (input.policyHash !== undefined) result.policyHash = input.policyHash;
  return freezeDeep(result);
}
export function validateWalletSafeguardPolicy(input, options = {}) { const policy = normalizeWalletSafeguardPolicy(input); const computed = hashFor(policy); if (options.requireHash && policy.policyHash !== computed) throw new RangeError('policyHash does not match policy'); if (policy.policyHash !== undefined && policy.policyHash !== computed) throw new RangeError('policyHash does not match policy'); return policy; }
export function createWalletSafeguardPolicy(input) { const policy = normalizeWalletSafeguardPolicy(input); return freezeDeep({ ...policy, policyHash: hashFor(policy) }); }
export function canonicalPolicyObject(policy) { return hashPayload(normalizeWalletSafeguardPolicy(policy)); }
export function canonicalPolicyBytes(policy) { return Buffer.from(JSON.stringify(canonicalPolicyObject(policy))); }
export function policyFingerprint(policy) { return hashFor(normalizeWalletSafeguardPolicy(policy)); }

export function evaluateWalletSafeguards({ policy, evidence, now = new Date().toISOString() }) {
  const p = validateWalletSafeguardPolicy(policy, { requireHash: true }); closedObject(evidence, EVIDENCE_FIELDS, 'evidence');
  if (evidence.policyHash !== p.policyHash || evidence.policyRevision !== p.policyRevision || evidence.targetId !== p.targetId || evidence.source !== p.expectedEvidenceSource || evidence.evidenceSchema !== p.evidenceSchema || evidence.evaluatorVersion !== p.evaluatorVersion) throw new RangeError('evidence identity mismatch');
  const nowMs = timestamp(now, 'now')[1]; if (nowMs > Date.now() + 300000) throw new RangeError('now is too far in future');
  const observed = timestamp(evidence.observedAt, 'observedAt')[1]; const evaluated = timestamp(evidence.evaluatedAt, 'evaluatedAt')[1];
  if (observed > nowMs || evaluated > nowMs || evaluated < observed) throw new RangeError('evidence timestamps are invalid');
  const maxAge = integer(evidence.maxAgeSeconds, 'maxAgeSeconds', 1, 31536000); if (nowMs - observed > maxAge * 1000) throw new RangeError('evidence is stale');
  for (const field of ['navLossBps', 'apyDropBps']) if (evidence[field] !== undefined) integer(evidence[field], field, 0, 10000); if (evidence.oracleAgeSeconds !== undefined) integer(evidence.oracleAgeSeconds, 'oracleAgeSeconds', 0, 31536000); if (evidence.authority !== undefined) decodeSolana(evidence.authority, 'authority');
  const results = p.conditions.map(c => { let known = true; let breached = false; if (c.type === 'nav_loss') { known = Number.isSafeInteger(evidence.navLossBps); breached = known && evidence.navLossBps >= c.thresholdBps; } if (c.type === 'apy_drop') { known = Number.isSafeInteger(evidence.apyDropBps); breached = known && evidence.apyDropBps >= c.thresholdBps; } if (c.type === 'oracle_staleness') { known = Number.isSafeInteger(evidence.oracleAgeSeconds); breached = known && evidence.oracleAgeSeconds > c.maxAgeSeconds; } if (c.type === 'authority_change') { known = typeof evidence.authority === 'string'; breached = known && evidence.authority !== c.expected; } return { type: c.type, result: known ? (breached ? 'breach' : 'pass') : 'unknown' }; });
  const eligible = raw(evidence.eligibleAmountRaw, 'eligibleAmountRaw'); const signed = raw(evidence.signedCapRaw, 'signedCapRaw'); const amountRaw = [eligible, eligible * BigInt(p.authorizedBps) / 10000n, signed].reduce((a, b) => a < b ? a : b);
  return { authorized: results.every(x => x.result !== 'unknown') && results.some(x => x.result === 'breach'), results, amountRaw: amountRaw.toString() };
}
