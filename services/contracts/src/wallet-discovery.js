import { validateCanonicalTarget } from './target-contract-v2.js';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DECIMAL = /^[+-]?(?:\d+)(?:\.\d+)?$/;

function decodeBase58(value) {
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
    if (number > (1n << 264n)) return null;
  }
  const bytes = [];
  while (number > 0n) { bytes.unshift(Number(number & 255n)); number >>= 8n; }
  let leading = 0;
  while (leading < value.length && value[leading] === '1') leading += 1;
  return leading + bytes.length === 32 ? bytes : null;
}

function validWallet(wallet) {
  if (typeof wallet !== 'string' || wallet.length < 32 || wallet.length > 44 || !decodeBase58(wallet)) throw new TypeError('wallet must be a valid Solana address');
  return wallet;
}

function validDecimal(value, field) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new TypeError(`position ${field} must be a canonical decimal`);
  return value;
}

function isZero(value) { return /^0+$/.test(value.replace(/^[+-]/, '').replace('.', '')); }

function canonicalPosition(protocol, adapterVersion, wallet, targetId, position) {
  if (!position || typeof position !== 'object' || Array.isArray(position)) throw new TypeError('adapter position must be an object');
  for (const field of ['kind', 'asset', 'source']) if (typeof position[field] !== 'string' || !position[field].trim()) throw new TypeError(`position ${field} must be a non-empty string`);
  return Object.freeze({ protocol, adapterVersion, wallet, targetId, kind: position.kind, asset: position.asset, amount: validDecimal(position.amount, 'amount'), valueUsd: validDecimal(position.valueUsd, 'valueUsd'), source: position.source });
}

function adapterKey(adapter) {
  if (!adapter || typeof adapter.id !== 'string' || !adapter.id.trim()) throw new TypeError('adapter id required');
  if (!Number.isInteger(adapter.version) || adapter.version < 1) throw new TypeError(`adapter ${adapter.id} version required`);
  if (typeof adapter.discover !== 'function') throw new TypeError(`adapter ${adapter.id} discover required`);
  return adapter.id;
}

export class WalletDiscovery {
  #adapters;
  #timeoutMs;

  constructor({ adapters = [], timeoutMs = 5000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be a positive integer');
    this.#adapters = new Map();
    for (const adapter of adapters) { const id = adapterKey(adapter); if (this.#adapters.has(id)) throw new RangeError(`duplicate adapter ${id}`); this.#adapters.set(id, Object.freeze({ ...adapter })); }
    this.#timeoutMs = timeoutMs;
  }

  async discover({ wallet, adapterIds, targetRegistry } = {}) {
    validWallet(wallet);
    if (!Array.isArray(adapterIds) || adapterIds.length === 0) throw new TypeError('adapterIds must be a non-empty array');
    if (!Array.isArray(targetRegistry) || targetRegistry.length === 0) throw new TypeError('targetRegistry must be a non-empty array');
    const targets = new Map();
    for (const entry of targetRegistry) { if (!entry || typeof entry.adapterId !== 'string') throw new TypeError('target registry adapterId required'); const target = validateCanonicalTarget(entry.target); if (targets.has(entry.adapterId)) throw new RangeError(`duplicate target for adapter ${entry.adapterId}`); targets.set(entry.adapterId, target); }
    const adapters = adapterIds.map((id) => { if (typeof id !== 'string' || !this.#adapters.has(id)) throw new RangeError(`unregistered adapter: ${id}`); if (!targets.has(id)) throw new RangeError(`missing canonical target for adapter: ${id}`); return [this.#adapters.get(id), targets.get(id)]; });
    const results = await Promise.all(adapters.map(([adapter, target]) => this.#run(adapter, target, wallet)));
    return { positions: results.flatMap((result) => result.positions).sort((a, b) => `${a.protocol}:${a.kind}:${a.asset}`.localeCompare(`${b.protocol}:${b.kind}:${b.asset}`)), statuses: results.map((result) => result.status).sort((a, b) => a.protocol.localeCompare(b.protocol)) };
  }

  async #run(adapter, target, wallet) {
    const controller = new AbortController(); let timeout;
    try {
      const positions = await Promise.race([adapter.discover({ wallet, signal: controller.signal }), new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, this.#timeoutMs); })]);
      if (!Array.isArray(positions)) throw new TypeError('adapter discover must return an array');
      return { positions: positions.filter((position) => typeof position?.amount === 'string' && !isZero(position.amount)).map((position) => canonicalPosition(adapter.id, adapter.version, wallet, target.id, position)), status: { protocol: adapter.id, adapterVersion: adapter.version, state: 'available' } };
    } catch (error) {
      const reason = controller.signal.aborted ? 'timeout' : (error instanceof TypeError && /position|array/.test(error.message) ? 'invalid_response' : 'adapter_error');
      return { positions: [], status: { protocol: adapter.id, adapterVersion: adapter.version, state: reason === 'timeout' ? 'degraded' : 'unavailable', reason } };
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  }
}
