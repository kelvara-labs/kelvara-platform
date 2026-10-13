import { createHash } from 'node:crypto';

const ROOT_FIELDS = new Set(['schemaVersion','chain','network','subjectAddress','provider','generation','programId','multisigAddress','authorityAddress','authorityIndex','threshold','members','timeLockSeconds','status','slot','observedAt','accountHash','decoderFamily','decoderVersion','artifactHash','providerData']);
const MEMBER_FIELDS = new Set(['address','permissions','providerData']);
const MEMBER_PROVIDER_DATA_FIELDS = new Set(['type','permissionMask']);
const PERMISSION_FIELDS = new Set(['initiate','vote','execute']);
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const KNOWN_GENERATIONS = new Set(['v3', 'v4', 'v5']);
const REGISTERED_GENERATIONS = new Set(['v4']);
const REQUIRED_ROOT_FIELDS = new Set(ROOT_FIELDS);
const ALLOWED_NETWORKS = new Set(['mainnet-beta', 'devnet', 'testnet', 'localnet']);
const PROVIDER_DATA_FIELDS = new Set(['type', 'reason', 'vaultPdaProof']);
const V4_PROOF_FIELDS = new Set(['index', 'seeds', 'derivedAddress']);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError(`${name} prototype is invalid`);
}
function keys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} unknown field: ${key}`);
}
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decodeAddress(value, name) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new TypeError(`${name} must be a valid Solana address`);
  let number = 0n;
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) throw new TypeError(`${name} must be a valid Solana address`);
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) { bytes.push(Number(number & 255n)); number >>= 8n; }
  for (const character of value) { if (character === '1') bytes.push(0); else break; }
  if (bytes.length !== 32) throw new TypeError(`${name} must be a valid Solana address`);
  bytes.reverse();
  let encoded = '';
  for (let number = BigInt('0x' + Buffer.from(bytes).toString('hex')); number > 0n; number = number / 58n) encoded = BASE58[Number(number % 58n)] + encoded;
  for (const byte of bytes) { if (byte === 0) encoded = `1${encoded}`; else break; }
  if (encoded !== value) throw new TypeError(`${name} must be a valid Solana address`);
}
function keysWithoutRequired(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name} unknown field: ${key}`);
}
function string(value, name, max = 256) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${name} is invalid`);
}
function nullableString(value, name) { if (value !== null) string(value, name); }
function integer(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new TypeError(`${name} must be a bounded safe integer`);
}
function address(value, name, nullable = false) {
  if (nullable && value === null) return;
  decodeAddress(value, name);
}
function boundedData(value, name = 'providerData', depth = 0, nodes = { count: 0 }) {
  if (depth > 6) throw new RangeError(`${name} exceeds maximum depth`);
  nodes.count += 1;
  if (nodes.count > 256) throw new RangeError(`${name} exceeds node bound`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string') string(value, name, 2048);
    return;
  }
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw new TypeError(`${name} contains unsafe number`); return; }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new RangeError(`${name} exceeds array bound`);
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) throw new TypeError(`${name} is sparse`);
      boundedData(value[i], `${name}[${i}]`, depth + 1, nodes);
    }
    return;
  }
  if (value === undefined) throw new TypeError(`${name} contains undefined`);
  object(value, name);
  if (Object.keys(value).length > 64) throw new RangeError(`${name} exceeds key bound`);
  for (const [key, entry] of Object.entries(value)) { string(key, `${name} key`, 128); boundedData(entry, `${name}.${key}`, depth + 1, nodes); }
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
function cloneSorted(value) {
  if (Array.isArray(value)) return value.map(cloneSorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, cloneSorted(value[key])]));
  return value;
}
function canonicalJson(value) { return JSON.stringify(cloneSorted(value)); }

export function validateGovernanceControl(input, { now = new Date() } = {}) {
  object(input, 'governance control'); keys(input, ROOT_FIELDS, 'governance control');
  for (const required of REQUIRED_ROOT_FIELDS) if (!Object.prototype.hasOwnProperty.call(input, required)) throw new TypeError(`governance control missing field: ${required}`);
  if (input.schemaVersion !== 'governance-control/v1') throw new RangeError('unsupported schemaVersion');
  if (input.chain !== 'solana' || input.provider !== 'squads') throw new RangeError('unsupported chain or provider');
  string(input.network, 'network', 64); if (!ALLOWED_NETWORKS.has(input.network)) throw new RangeError('network is not registered'); string(input.generation, 'generation', 32); if (input.status === 'verified' && !REGISTERED_GENERATIONS.has(input.generation)) throw new RangeError('generation is not registered'); if (input.status !== 'verified' && input.generation !== 'unknown' && !KNOWN_GENERATIONS.has(input.generation)) throw new RangeError('generation is not registered'); string(input.decoderFamily, 'decoderFamily', 128); string(input.decoderVersion, 'decoderVersion', 128);
  address(input.subjectAddress, 'subjectAddress'); string(input.observedAt, 'observedAt', 32); if (!ISO_UTC.test(input.observedAt) || new Date(input.observedAt).toISOString() !== input.observedAt) throw new TypeError('observedAt must be canonical UTC');
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) throw new TypeError('now must be a valid date');
  if (new Date(input.observedAt) > now) throw new RangeError('observedAt cannot be in the future');
  integer(input.slot, 'slot'); if (!HASH.test(input.accountHash)) throw new TypeError('accountHash is invalid'); if (!HASH.test(input.artifactHash)) throw new TypeError('artifactHash is invalid');
  if (!['verified','unsupported','invalid'].includes(input.status)) throw new RangeError('status is invalid');
  if (input.status === 'verified') {
    address(input.programId, 'programId'); address(input.multisigAddress, 'multisigAddress'); address(input.authorityAddress, 'authorityAddress'); integer(input.authorityIndex, 'authorityIndex');
    integer(input.threshold, 'threshold'); if (input.threshold < 1) throw new RangeError('threshold is invalid'); integer(input.timeLockSeconds, 'timeLockSeconds', 31_536_000);
    if (!Array.isArray(input.members) || input.members.length < 1 || input.members.length > 64) throw new TypeError('members is invalid');
    const seen = new Set();
    for (const [i, member] of input.members.entries()) {
      object(member, `members[${i}]`); keys(member, MEMBER_FIELDS, `members[${i}]`); address(member.address, `members[${i}].address`);
      if (seen.has(member.address)) throw new RangeError('duplicate member'); seen.add(member.address);
      if (input.generation !== 'v4') {
        if (member.permissions !== null || member.providerData !== null) throw new TypeError('unknown member permissions must be null');
        continue;
      }
      object(member.permissions, `members[${i}].permissions`); keys(member.permissions, PERMISSION_FIELDS, `members[${i}].permissions`);
      object(member.providerData, `members[${i}].providerData`); keys(member.providerData, MEMBER_PROVIDER_DATA_FIELDS, `members[${i}].providerData`);
      if (member.providerData.type !== 'squads-v4-member' || !Number.isSafeInteger(member.providerData.permissionMask) || member.providerData.permissionMask < 0 || member.providerData.permissionMask > 7) throw new TypeError('permission mask is invalid');
      for (const permission of PERMISSION_FIELDS) if (typeof member.permissions[permission] !== 'boolean' || member.permissions[permission] !== Boolean(member.providerData.permissionMask & ({ initiate: 1, vote: 2, execute: 4 })[permission])) throw new TypeError('permission facts do not match provider mask');
    }
    if (input.threshold > input.members.length) throw new RangeError('threshold exceeds member count');
  } else {
    for (const field of ['programId','multisigAddress','authorityAddress','authorityIndex','threshold','timeLockSeconds']) if (input[field] !== null) throw new TypeError(`${input.status} evidence cannot claim ${field}`);
    if (!Array.isArray(input.members) || input.members.length !== 0) throw new TypeError(`${input.status} evidence members must be empty`);
  }
  boundedData(input.providerData);
  object(input.providerData, 'providerData');
  keysWithoutRequired(input.providerData, PROVIDER_DATA_FIELDS, 'providerData');
  if (input.status !== 'verified') {
    if (input.providerData.type !== input.status || !Object.hasOwn(input.providerData, 'reason') || Object.keys(input.providerData).length !== 2) throw new RangeError('providerData type is invalid');
    if (typeof input.providerData.reason !== 'string' || input.providerData.reason.length === 0) throw new TypeError('providerData.reason is invalid');
  } else {
    if (input.generation !== 'v4' || input.providerData.type !== 'squads-v4' || !Object.hasOwn(input.providerData, 'vaultPdaProof') || Object.keys(input.providerData).length !== 2) throw new RangeError('providerData type is invalid');
    object(input.providerData.vaultPdaProof, 'providerData.vaultPdaProof');
    keysWithoutRequired(input.providerData.vaultPdaProof, V4_PROOF_FIELDS, 'providerData.vaultPdaProof');
    if (!Number.isSafeInteger(input.providerData.vaultPdaProof.index) || input.providerData.vaultPdaProof.index < 0 || input.providerData.vaultPdaProof.index > 255) throw new TypeError('providerData.vaultPdaProof.index is invalid');
    if (!Array.isArray(input.providerData.vaultPdaProof.seeds) || input.providerData.vaultPdaProof.seeds.some(seed => typeof seed !== 'string' || seed.length === 0)) throw new TypeError('providerData.vaultPdaProof.seeds is invalid');
    address(input.providerData.vaultPdaProof.derivedAddress, 'providerData.vaultPdaProof.derivedAddress');
  }
  return deepFreeze(structuredClone(input));
}

export function canonicalGovernanceControl(input, options) { return validateGovernanceControl(input, options); }
export function governanceControlDigest(input) { return createHash('sha256').update(canonicalJson(validateGovernanceControl(input))).digest('hex'); }
