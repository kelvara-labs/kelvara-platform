const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const FIELDS = ['chain', 'network', 'protocol', 'kind', 'address'];

function required(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  if (!IDENTIFIER.test(value) && field !== 'address') throw new TypeError(`${field} has invalid format`);
  return value;
}

export function canonicalTargetId(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new TypeError('target must be an object');
  const values = FIELDS.map((field) => required(target[field], field));
  if (!ADDRESS.test(values[4])) throw new TypeError('address must be a valid Solana base58 address');
  return values.join(':');
}

export function validateCanonicalTarget(target) {
  const id = canonicalTargetId(target);
  if (target.id !== id) throw new RangeError(`id must equal ${id}`);
  return { ...target, id };
}

export function validateAssignment({ target, indexerId, protocol, network }) {
  const canonical = validateCanonicalTarget(target);
  required(indexerId, 'indexerId');
  if (canonical.protocol !== protocol) throw new RangeError('assignment protocol mismatch');
  if (canonical.network !== network) throw new RangeError('assignment network mismatch');
  return { targetId: canonical.id, indexerId };
}
