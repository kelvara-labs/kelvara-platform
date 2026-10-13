import { createHash } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EVIDENCE_FIELDS = new Set(['policyHash', 'policyRevision', 'targetId', 'source', 'evidenceSchema', 'evaluatorVersion', 'observedAt', 'evaluatedAt', 'maxAgeSeconds', 'navLossBps', 'apyDropBps', 'oracleAgeSeconds', 'authority', 'eligibleAmountRaw', 'signedCapRaw']);
function validId(value, name) { if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function validLabel(value, name, max = 128) { if (typeof value !== 'string' || value.length < 1 || value.length > max || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${name} is invalid`); return value; }
function validTime(value, name) { if (typeof value !== 'string' || !ISO.test(value) || new Date(value).toISOString() !== value) throw new TypeError(`${name} is invalid`); return value; }
function validInteger(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} is invalid`); return value; }
function validRaw(value, name) { if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > ((1n << 256n) - 1n)) throw new TypeError(`${name} is invalid`); return value; }
function canonical(value, depth = 0, state = { nodes: 0 }) {
  if (++state.nodes > 512 || depth > 16 || value === undefined || typeof value === 'function' || typeof value === 'symbol') throw new TypeError('evidence is not JSON-safe');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('evidence contains non-finite number'); return value; }
  if (Array.isArray(value)) { if (value.length > 128) throw new TypeError('evidence array is too large'); return value.map(item => canonical(item, depth + 1, state)); }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('evidence is not JSON-safe');
  const keys = Object.keys(value); if (keys.length > 64) throw new TypeError('evidence has too many fields');
  return Object.fromEntries(keys.sort().map(key => [key, canonical(value[key], depth + 1, state)]));
}
function digest(value) { const serialized = JSON.stringify(canonical(value)); if (serialized.length > 65536) throw new TypeError('evidence is too large'); return createHash('sha256').update(serialized).digest('hex'); }
export function validateWalletSafeguardEvidence(evidence, targetId) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new TypeError('evidence is invalid');
  for (const key of Object.keys(evidence)) if (!EVIDENCE_FIELDS.has(key)) throw new TypeError(`unknown evidence field: ${key}`);
  if (typeof evidence.policyHash !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.policyHash)) throw new TypeError('evidence.policyHash is invalid');
  validInteger(evidence.policyRevision, 'evidence.policyRevision', 1, 2147483647);
  if (evidence.targetId !== targetId) throw new TypeError('evidence.targetId does not match targetId');
  for (const name of ['source', 'evidenceSchema', 'evaluatorVersion']) validLabel(evidence[name], `evidence.${name}`);
  if (evidence.authority !== undefined) {
    const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    if (!BASE58.test(evidence.authority)) throw new TypeError('evidence.authority is invalid');
  }
  validTime(evidence.observedAt, 'evidence.observedAt'); validTime(evidence.evaluatedAt, 'evidence.evaluatedAt');
  if (Date.parse(evidence.observedAt) > Date.parse(evidence.evaluatedAt)) throw new TypeError('evidence timestamps are invalid');
  validInteger(evidence.maxAgeSeconds, 'evidence.maxAgeSeconds', 1, 31536000);
  for (const name of ['navLossBps', 'apyDropBps']) if (evidence[name] !== undefined) validInteger(evidence[name], `evidence.${name}`, 0, 10000);
  if (evidence.oracleAgeSeconds !== undefined) validInteger(evidence.oracleAgeSeconds, 'evidence.oracleAgeSeconds', 0, 31536000);
  validRaw(evidence.eligibleAmountRaw, 'evidence.eligibleAmountRaw'); validRaw(evidence.signedCapRaw, 'evidence.signedCapRaw');
  canonical(evidence); return evidence;
}
export function recordWalletSafeguardObservation(db, { evidenceRef, producerId, targetId, evidence }, createdAt = new Date().toISOString()) {
  validId(evidenceRef, 'evidenceRef'); validId(producerId, 'producerId'); validId(targetId, 'targetId'); validTime(createdAt, 'createdAt');
  validateWalletSafeguardEvidence(evidence, targetId); const payloadHash = digest(evidence);
  const existing = db.prepare('SELECT payload_hash FROM wallet_safeguard_observations WHERE evidence_ref=? AND producer_id=? AND target_id=?').get(evidenceRef, producerId, targetId);
  if (existing) { if (existing.payload_hash !== payloadHash) throw new Error('observation_conflict'); return { inserted: false, evidenceRef }; }
  db.prepare('INSERT INTO wallet_safeguard_observations (evidence_ref,producer_id,target_id,observed_at,evidence_json,payload_hash,created_at) VALUES (?,?,?,?,?,?,?)').run(evidenceRef, producerId, targetId, evidence.observedAt, JSON.stringify(canonical(evidence)), payloadHash, createdAt); return { inserted: true, evidenceRef };
}
export function getWalletSafeguardObservation(db, { evidenceRef, producerId, targetId }) {
  validId(evidenceRef, 'evidenceRef'); validId(producerId, 'producerId'); validId(targetId, 'targetId');
  const row = db.prepare('SELECT evidence_ref AS evidenceRef,producer_id AS producerId,target_id AS targetId,observed_at AS observedAt,evidence_json AS evidenceJson,payload_hash AS payloadHash,created_at AS createdAt FROM wallet_safeguard_observations WHERE evidence_ref=? AND producer_id=? AND target_id=?').get(evidenceRef, producerId, targetId); if (!row) return null; return { ...row, evidence: JSON.parse(row.evidenceJson) };
}
