import { randomUUID } from 'node:crypto';
import { canonicalDigest } from './canonical-json.js';
import { velocityMainnetManifest } from '../../indexer-velocity/src/index.js';

const KAMINO_OWNER = 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd';
const KAMINO_LENGTH = 62552;
const KAMINO_KIND = new Set(['kvault', 'vault']);
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decodeBase58(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) throw new TypeError('address is not canonical Solana base58');
  let n = 0n; for (const c of value) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const bytes = []; while (n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of value) if (c === '1') bytes.unshift(0); else break;
  if (bytes.length !== 32) throw new TypeError('address must decode to 32 bytes');
  let out = ''; let x = 0n; for (const b of bytes) x = (x << 8n) + BigInt(b);
  while (x) { out = ALPHABET[Number(x % 58n)] + out; x /= 58n; }
  for (const b of bytes) { if (b) break; out = `1${out}`; }
  if (out !== value) throw new TypeError('address is not canonical Solana base58');
  return value;
}
function targetId(input) { return `solana:${input.network}:${input.protocol}:${input.kind}:${input.address}`; }
function identity(input) { return ['chain','network','protocol','kind','address'].map(k => input[k]).join(':'); }

export function createPreflightService({ rpcChecker, kaminoAdapter, metricsAdapter, clock = () => Date.now(), receiptTtlMs = 5 * 60_000 } = {}) {
  if (typeof rpcChecker !== 'function') throw new TypeError('rpcChecker is required');
  if (!kaminoAdapter || typeof kaminoAdapter.decode !== 'function') throw new TypeError('kaminoAdapter is required');
  const bounded = async (operation, timeoutMs = 10_000) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try { return await operation(controller.signal); } finally { clearTimeout(timeout); }
  };
  return {
    async validate(input) {
      if (!input || input.chain !== 'solana') throw new Error('unsupported_chain');
      decodeBase58(input.address);
      if (input.targetId !== targetId(input)) throw new Error('target_id_mismatch');
      let facts;
      if (input.protocol === 'velocity') {
        if (input.network !== 'mainnet-beta') throw new Error('velocity_network_unsupported');
        const entry = velocityMainnetManifest().find(item => item.address === input.address && item.kind === input.kind);
        if (!entry || identity(entry) !== identity(input)) throw new Error('velocity_target_not_pinned');
        facts = await bounded(signal => rpcChecker(entry, signal));
        if (!facts || facts.owner !== entry.expectedOwner || facts.dataLength !== entry.expectedDataLength || Boolean(facts.executable) !== false) throw new Error('velocity_rpc_facts_mismatch');
        if (input.programId && input.programId !== entry.programId) throw new Error('velocity_program_mismatch');
        if (input.quoteMint && input.quoteMint !== 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') throw new Error('velocity_quote_mint_mismatch');
        facts = { owner: facts.owner, dataLength: facts.dataLength, executable: false, slot: facts.slot ?? null };
      } else if (input.protocol === 'kamino') {
        if (!input.network || !KAMINO_KIND.has(input.kind) || input.expectedOwner !== KAMINO_OWNER) throw new Error('kamino_manifest_mismatch');
        if (!kaminoAdapter || typeof kaminoAdapter.decode !== 'function') throw new Error('kamino_preflight_unavailable');
        facts = await bounded(signal => kaminoAdapter.decode(input, signal));
        if (!facts || facts.owner !== KAMINO_OWNER || facts.dataLength !== KAMINO_LENGTH || facts.decoderFamily !== 'kamino-vault' || !facts.decoderVersion) throw new Error('kamino_facts_mismatch');
        if (metricsAdapter) {
          if (`${input.metricsAdapter?.id}@${input.metricsAdapter?.version}` !== 'kamino-kvault-metrics@1') throw new Error('metrics_adapter_reference_invalid');
          const metrics = await bounded(signal => metricsAdapter.fetch(input, signal));
          facts = { owner: facts.owner, dataLength: facts.dataLength, decoderFamily: facts.decoderFamily, decoderVersion: facts.decoderVersion, tokenMint: facts.tokenMint, sharesMint: facts.sharesMint, metrics: { adapter: metrics.adapter, tvl: metrics.tvl, observedAt: metrics.observedAt, responseDigest: metrics.responseDigest } };
        }
      } else throw new Error('protocol_unsupported');
      const now = new Date(clock()).toISOString();
      return { receiptId: randomUUID(), targetId: targetId(input), identity: identity(input), valid: true, issuedAt: now, expiresAt: new Date(clock() + receiptTtlMs).toISOString(), provenance: { source: 'control-plane-preflight', facts, digest: canonicalDigest(facts) } };
    }
  };
}
export { KAMINO_OWNER, KAMINO_LENGTH, targetId };
