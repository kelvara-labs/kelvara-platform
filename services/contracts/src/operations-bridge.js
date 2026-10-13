import { createHash } from 'node:crypto';

export const MAX_ID_LENGTH = 256;
export const MAX_CANONICAL_STRING_LENGTH = 4096;
export const MAX_CANONICAL_NODES = 2048;
export const MAX_CANONICAL_BYTES = 64 * 1024;
export const MAX_PROPOSAL_LIFETIME_MS = 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 30 * 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SERVICE = /^[a-z][a-z0-9-]{0,63}$/;
const NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){0,5}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const APPROVAL_REQUIREMENTS = Object.freeze({
  read: Object.freeze({ proposal: false, dedicated: false }),
  mutate: Object.freeze({ proposal: true, dedicated: false }),
  critical: Object.freeze({ proposal: true, dedicated: true })
});

function plain(value) { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
function inspect(value, state = { depth: 0, nodes: 0 }) {
  if (++state.nodes > MAX_CANONICAL_NODES) throw new RangeError('canonical node limit exceeded');
  if (state.depth > 8) throw new RangeError('maximum canonical depth exceeded');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { if (value.length > MAX_CANONICAL_STRING_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('invalid canonical string'); return; }
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw new TypeError('number must be safe integer'); return; }
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) { if (!Object.hasOwn(value, i)) throw new TypeError('sparse array'); state.depth++; inspect(value[i], state); state.depth--; } return; }
  if (!plain(value)) throw new TypeError('canonical value must use plain object');
  const keys = Object.keys(value); if (keys.length > 256) throw new RangeError('object too large');
  for (const key of keys) { if (!FIELD.test(key)) throw new TypeError('invalid key'); state.depth++; inspect(value[key], state); state.depth--; }
}
export function canonicalize(value) {
  inspect(value);
  const out = JSON.stringify(value, (_k, v) => plain(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
  if (out.length > MAX_CANONICAL_BYTES) throw new RangeError('canonical size limit exceeded');
  return out;
}
export function payloadDigest(payload) { return createHash('sha256').update(canonicalize(payload)).digest('hex'); }
export function envelopeDigest(proposal) {
  return createHash('sha256').update(canonicalize({
    proposalId: proposal.proposalId, requester: proposal.requester,
    destinationService: proposal.destinationService, operation: proposal.operation,
    operationVersion: proposal.operationVersion, resourceIds: proposal.resourceIds,
    idempotencyKey: proposal.idempotencyKey, createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt, payloadDigest: payloadDigest(proposal.payload)
  })).digest('hex');
}

function definition(definition) {
  const keys = Object.keys(definition).sort();
  if (keys.join(',') !== 'name,payloadFields,requiredFields,risk,service,version') throw new TypeError('unknown operation definition field');
  if (!SERVICE.test(definition.service) || !NAME.test(definition.name) || !Number.isSafeInteger(definition.version) || definition.version < 1 || !APPROVAL_REQUIREMENTS[definition.risk]) throw new TypeError('invalid operation definition');
  if (!Array.isArray(definition.payloadFields) || !Array.isArray(definition.requiredFields) || definition.requiredFields.some((x) => !FIELD.test(x)) || definition.payloadFields.some((x) => !FIELD.test(x)) || new Set(definition.payloadFields).size !== definition.payloadFields.length || definition.requiredFields.some((x) => !definition.payloadFields.includes(x))) throw new TypeError('invalid operation definition fields');
  return Object.freeze({ ...definition, payloadFields: Object.freeze([...definition.payloadFields]), requiredFields: Object.freeze([...definition.requiredFields]) });
}
export function createOperationRegistry(definitions) {
  const registry = new Map();
  for (const item of definitions) { const value = definition(item); const key = `${value.service}:${value.name}:${value.version}`; if (registry.has(key)) throw new TypeError('duplicate operation definition'); registry.set(key, value); }
  return Object.freeze({ get: (service, name, version) => registry.get(`${service}:${name}:${version}`) });
}
export const DEFAULT_OPERATIONS = Object.freeze([
  { service: 'control-center', name: 'policy.read-rules', version: 1, risk: 'read', payloadFields: ['vaultId'], requiredFields: ['vaultId'] },
  { service: 'control-center', name: 'preflight.add-vault', version: 1, risk: 'read', payloadFields: ['vaultId'], requiredFields: ['vaultId'] },
  { service: 'control-center', name: 'target.create-draft', version: 1, risk: 'mutate', payloadFields: ['vaultId', 'revision', 'rules'], requiredFields: ['vaultId', 'revision', 'rules'] },
  { service: 'control-center', name: 'policy.create-rule-draft', version: 1, risk: 'mutate', payloadFields: ['vaultId', 'revision', 'rules'], requiredFields: ['vaultId', 'revision', 'rules'] },
  { service: 'control-center', name: 'policy.update-rule-draft', version: 1, risk: 'mutate', payloadFields: ['vaultId', 'revision', 'rules'], requiredFields: ['vaultId', 'revision', 'rules'] },
  { service: 'control-center', name: 'policy.validate', version: 1, risk: 'read', payloadFields: ['vaultId', 'revision'], requiredFields: ['vaultId', 'revision'] },
  { service: 'control-center', name: 'policy.activate', version: 1, risk: 'critical', payloadFields: ['vaultId', 'revision'], requiredFields: ['vaultId', 'revision'] }
].map(definition));
const defaultRegistry = createOperationRegistry(DEFAULT_OPERATIONS);
export function getOperation(service, name, version) { return defaultRegistry.get(service, name, version); }

function id(value, field) { if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`${field} ID invalid`); }
function timestamp(value, field) { if (typeof value !== 'string' || !ISO.test(value)) throw new TypeError(`${field} timestamp invalid`); const ms = Date.parse(value); if (new Date(ms).toISOString() !== value) throw new TypeError(`${field} timestamp invalid`); return ms; }
export function validateProposal(proposal, { now = () => Date.now(), registry = defaultRegistry } = {}) {
  const allowed = ['proposalId', 'requester', 'destinationService', 'operation', 'operationVersion', 'payload', 'resourceIds', 'idempotencyKey', 'createdAt', 'expiresAt'];
  if (!plain(proposal) || Object.keys(proposal).some((key) => !allowed.includes(key))) throw new TypeError('unknown proposal field');
  for (const field of allowed) if (!Object.hasOwn(proposal, field)) throw new TypeError(`${field} required`);
  id(proposal.proposalId, 'proposal'); id(proposal.requester, 'requester'); id(proposal.destinationService, 'service'); id(proposal.operation, 'operation'); id(proposal.idempotencyKey, 'idempotency');
  const operation = registry.get(proposal.destinationService, proposal.operation, proposal.operationVersion); if (!operation) throw new RangeError('operation not in registry');
  if (!Number.isSafeInteger(proposal.operationVersion) || proposal.operationVersion < 1) throw new TypeError('version invalid');
  if (!Array.isArray(proposal.resourceIds) || proposal.resourceIds.length === 0 || new Set(proposal.resourceIds).size !== proposal.resourceIds.length) throw new TypeError('resource IDs invalid');
  proposal.resourceIds.forEach((value) => id(value, 'resource'));
  if (!plain(proposal.payload)) throw new TypeError('payload invalid');
  for (const key of Object.keys(proposal.payload)) if (!operation.payloadFields.includes(key)) throw new TypeError('unknown payload field');
  for (const key of operation.requiredFields) if (!Object.hasOwn(proposal.payload, key)) throw new TypeError('required payload field');
  const current = now(); const created = timestamp(proposal.createdAt, 'createdAt'); const expiry = timestamp(proposal.expiresAt, 'expiresAt');
  if (created > current + CLOCK_SKEW_MS) throw new RangeError('createdAt in future');
  if (expiry <= current) throw new RangeError('proposal expired');
  if (expiry <= created || expiry - created > MAX_PROPOSAL_LIFETIME_MS) throw new RangeError('proposal lifetime invalid');
  const digest = payloadDigest(proposal.payload);
  return { ...proposal, risk: operation.risk, approvalRequirements: APPROVAL_REQUIREMENTS[operation.risk], payloadDigest: digest, envelopeDigest: envelopeDigest({ ...proposal, payloadDigest: digest }) };
}
