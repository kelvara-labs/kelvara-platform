import { sign, verify } from 'node:crypto';

const FIELDS = ['issuer', 'audience', 'walletId', 'nonce', 'issuedAt', 'expiresAt'];
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function canonical(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('owner receipt payload must be an object');
  return JSON.stringify(Object.fromEntries(FIELDS.map(field => [field, value[field]])));
}
function payload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !FIELDS.includes(key))) throw new TypeError('owner receipt fields are invalid');
  for (const field of FIELDS) if (typeof value[field] !== 'string' || !value[field].trim()) throw new TypeError(`owner receipt ${field} is required`);
  for (const field of ['walletId', 'nonce']) if (!ID.test(value[field])) throw new TypeError(`owner receipt ${field} is invalid`);
  if (![value.issuedAt, value.expiresAt].every(value => ISO.test(value) && new Date(value).toISOString() === value)) throw new TypeError('owner receipt timestamps are invalid');
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) throw new TypeError('owner receipt lifetime is invalid');
  return Object.fromEntries(FIELDS.map(field => [field, value[field]]));
}
export function issueOwnerAuthorityReceipt(input, privateKey, kid) {
  if (typeof kid !== 'string' || !ID.test(kid)) throw new TypeError('owner receipt key ID is invalid');
  const body = payload(input); const bytes = Buffer.from(canonical(body));
  return Object.freeze({ alg: 'Ed25519', kid, ...body, signature: sign(null, bytes, privateKey).toString('base64url') });
}
export function verifyOwnerAuthorityReceipt(receipt, publicKey, { now = Date.now(), issuer = 'program-backend', audience = 'control-plane', clockSkewMs = 30_000 } = {}) {
  if (!receipt || typeof receipt !== 'object' || receipt.alg !== 'Ed25519' || typeof receipt.kid !== 'string' || typeof receipt.signature !== 'string') throw new TypeError('owner receipt envelope is invalid');
  const body = payload(Object.fromEntries(FIELDS.map(field => [field, receipt[field]])));
  if (body.issuer !== issuer || body.audience !== audience) throw new Error('owner receipt binding invalid');
  const issued = Date.parse(body.issuedAt); const expires = Date.parse(body.expiresAt);
  if (issued > now + clockSkewMs || expires <= now - clockSkewMs) throw new Error('owner receipt expired');
  if (!verify(null, Buffer.from(canonical(body)), publicKey, Buffer.from(receipt.signature, 'base64url'))) throw new Error('owner receipt signature invalid');
  return Object.freeze(body);
}
