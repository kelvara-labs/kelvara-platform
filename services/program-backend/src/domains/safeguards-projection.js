import { projectExpectedSafeguards } from './safeguards-expected.js';

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function privateProjection(value, name) {
  const projection = object(value, name);
  if (!Array.isArray(projection.bindings) || !Array.isArray(projection.receipts)) throw new TypeError(`${name} must contain bindings and receipts`);
  return projection;
}

/**
 * Project public/global safeguards, optionally adding the private projection
 * resolved for the authenticated owner. No private projection is inferred
 * from a public address or from an untrusted request field.
 */
export function projectProgramBackendSafeguards(input, { authenticatedWallet } = {}) {
  object(input, 'input');
  if (!Array.isArray(input.positions)) throw new TypeError('positions must be an array');
  if (!input.global) throw new TypeError('global projection is required');
  const global = privateProjection(input.global, 'global');
  const publicProjection = projectExpectedSafeguards({ policyRevision: input.policyRevision, positions: input.positions, bindings: global.bindings, receipts: global.receipts });
  const privateData = authenticatedWallet === undefined ? undefined : input.privateByWallet?.[authenticatedWallet];
  if (!privateData) return publicProjection;
  const ownerProjection = privateProjectionData(privateData);
  const privateResult = projectExpectedSafeguards({ policyRevision: input.policyRevision, positions: input.positions.filter(position => position.wallet === authenticatedWallet), bindings: ownerProjection.bindings, receipts: ownerProjection.receipts });
  const privateByTarget = new Map(privateResult.positions.map(position => [position.targetId, position.safeguards]));
  const positions = publicProjection.positions.map(position => Object.freeze({
    ...position,
    safeguards: Object.freeze([...position.safeguards, ...(privateByTarget.get(position.targetId) ?? [])])
  }));
  return Object.freeze({ policyRevision: input.policyRevision, positions: Object.freeze(positions) });
}

function privateProjectionData(value) {
  return privateProjection(value, 'private projection');
}
