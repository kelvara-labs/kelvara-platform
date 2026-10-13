import { createHash } from 'node:crypto';

export function canonicalJson(value, path = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be JSON-safe`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalJson(item, `${path}[${index}]`));
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key], `${path}.${key}`)]));
  }
  throw new TypeError(`${path} must be JSON-safe`);
}

export function canonicalDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex');
}
