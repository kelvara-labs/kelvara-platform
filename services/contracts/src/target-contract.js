const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const REQUIRED_STRINGS = ['id', 'indexerId', 'protocol', 'network', 'kind', 'address', 'displayName', 'curator'];

export function validateTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError('target must be an object');
  }
  for (const field of REQUIRED_STRINGS) {
    if (typeof target[field] !== 'string' || target[field].length === 0) {
      throw new TypeError(`${field} must be a non-empty string`);
    }
  }
  if (!BASE58_ADDRESS.test(target.address)) {
    throw new TypeError('address must be a valid Solana base58 address');
  }
  const expectedId = `${target.indexerId}:${target.address}`;
  if (target.id !== expectedId) {
    throw new RangeError(`id must equal ${expectedId}`);
  }
  if (typeof target.enabled !== 'boolean') {
    throw new TypeError('enabled must be a boolean');
  }
  return target;
}
