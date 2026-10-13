import { createHash } from 'node:crypto';
import { validateVelocityObservation } from '../../contracts/src/velocity-observation-v1.js';

const PROGRAM_KINDS = new Set(['state', 'spot-market', 'perp-market', 'amm-cache', 'oracle', 'lp-pool', 'constituent-pool']);
const ACCOUNT_KINDS = new Set(['insurance-vault', 'spl-token-account']);

function observationKind(target) {
  if (PROGRAM_KINDS.has(target.kind)) return 'program';
  if (ACCOUNT_KINDS.has(target.kind)) return 'account';
  throw new Error('unsupported_velocity_target_kind');
}

export async function postVelocityObservation({ backendUrl, backendToken }, target, account, observedAt, fetchImpl = fetch) {
  if (typeof backendToken !== 'string' || backendToken.length < 32) throw new Error('KELVARA_OBSERVATION_HUB_TOKEN must be at least 32 characters');
  if (account.owner !== target.expectedOwner || Boolean(account.executable) !== Boolean(target.expectedExecutable)) throw new Error('account_identity_mismatch');
  const bytes = Buffer.isBuffer(account.data) ? account.data : Buffer.from(account.data || []);
  if (!Number.isInteger(target.expectedDataLength) || bytes.length !== target.expectedDataLength) throw new Error('account_data_length_mismatch');
  const kind = observationKind(target);
  const dataHash = createHash('sha256').update(bytes).digest('hex');
  const evidence = { network: target.network, programId: target.programId, address: target.address, slot: String(account.slot), owner: account.owner, executable: Boolean(account.executable), dataLength: bytes.length, dataHash, ...(target.token ? { token: target.token } : {}) };
  const observation = validateVelocityObservation({ observationId: createHash('sha256').update(JSON.stringify(evidence)).digest('hex').slice(0, 32), kind, network: target.network, programId: target.programId, address: target.address, slot: String(account.slot), owner: account.owner, executable: Boolean(account.executable), dataLength: bytes.length, dataHash, observedAt, provenance: { source: 'solana', method: 'getAccountInfo', commitment: 'finalized' }, status: 'verified' });
  const response = await fetchImpl(`${backendUrl}/internal/velocity/observations`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Kelvara-Authorization': `Bearer ${backendToken}` }, body: JSON.stringify(observation) });
  if (!response.ok) throw new Error(`hub_${response.status}`);
  return { status: response.status, observation };
}

export const VELOCITY_MAINNET_PROGRAM = 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P';
export const VELOCITY_MAINNET_QUOTE_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

// Derived with @velocity-exchange/sdk@0.20.0 PDA helpers; live RPC verified below.
const MAINNET_TARGETS = [
  ['State', '2etx5NvPNxeMZ7EfHE6GjJfW2imRYEUANehNS1WB4CVW', 'state', 1752],
  ['SpotMarket0', '2QpHj5vzgCdWaGM2KSoGtYJWeSkx24cMyzUDHDrucvRc', 'spot-market', 1064],
  ['SpotMarket1', '5MzQRp6hhesVuM3CSAzBfPSNP1WaJyF1ifwkmzcrWLtU', 'spot-market', 1064],
  ['PerpMarket0', 'FDejXbUrSy6zayBCL5xuk2SXLHZgr8ppfFTLcHbyJorY', 'perp-market', 1560],
  ['PerpMarket1', '7s5WRWA3GahueLNfNb8bbVnHnxCssK5YjGCR3wP6Aa1t', 'perp-market', 1560],
  ['AmmCache', '8sHTsXVdPN2JeMP5RZf8aX1hJe8esjDFqJTgE8jJyTMY', 'amm-cache', 20]
];
const DEVNET_TARGETS = [
  ['State', 'F5yjMkHa2wAXagYifsjZp8WvjvKGNshRAcWd684agqcp', 'state', 1016],
  ['AmmCache', '4TqNgTNPS26vhDxp94eVR4iD9QSaEvbVELJUVqoqd22c', 'amm-cache', 20],
  ['SpotMarket0', 'H4UqRQuYXBbfPyiADFsWwRhajS7Jpwu3zyYwFn47GXC4', 'spot-market', 808],
  ['PythLazerOracle', '57ZE6W8mGWPQokUHjyfTAeXvVLK8xuMbWn9HGg6fG7oW', 'oracle', 48],
  ['PerpMarket0', 'AnT1Xu3RG9GyuGzhsxKQqYgLRupSbTNkangaLqeLziSg', 'perp-market', 1240],
  ['LPPool1', 'GLybnswR5113ZU2XHomrEjZn8N8oYUhYaLgEcmmXvwGv', 'lp-pool', 504],
  ['ConstituentPool1Spot0', '7wVMDLArAzW6bMtr8dg9LgR9htjZrusQXD2AwyLGbL9J', 'constituent-pool', 488],
  ['dUSDT', 'GqmEqYsy8EyvofDpmtFxK8zhYrgWgNokAtYoduQdL7v6', 'mint', 82]
];

function manifest(rows, network, programId) {
  return rows.map(([displayName, address, kind, expectedDataLength]) => ({
    targetId: `solana:${network}:velocity:${kind}:${address}`, chain: 'solana', network, protocol: 'velocity', kind, address, displayName,
    programId: kind === 'mint' ? TOKEN_PROGRAM : programId, expectedOwner: kind === 'mint' ? TOKEN_PROGRAM : programId,
    expectedDataLength, decoderFamily: 'raw-account-v1', decoderVersion: '1.0.0', provenance: network === 'mainnet-beta' ? 'velocity-sdk-0.20.0+pda-helper+solana-finalized-rpc' : 'user-supplied-devnet-address; semantic-layout-unverified', status: 'draft'
  }));
}
export function velocityMainnetManifest() { return manifest(MAINNET_TARGETS, 'mainnet-beta', VELOCITY_MAINNET_PROGRAM); }
export function velocityDevnetManifest() { return manifest(DEVNET_TARGETS, 'devnet', VELOCITY_MAINNET_PROGRAM); }
export function loadVelocityConfig(env = process.env) {
  const network = env.NETWORK || 'mainnet-beta';
  if (!['mainnet-beta', 'devnet'].includes(network)) throw new Error('NETWORK must be mainnet-beta or devnet');
  const programId = env.VELOCITY_PROGRAM_ID || VELOCITY_MAINNET_PROGRAM;
  if (network === 'mainnet-beta' && programId !== VELOCITY_MAINNET_PROGRAM) throw new Error('velocity mainnet program mismatch');
  const quoteMint = env.QUOTE_MINT_ADDRESS || VELOCITY_MAINNET_QUOTE_MINT;
  if (network === 'mainnet-beta' && quoteMint !== VELOCITY_MAINNET_QUOTE_MINT) throw new Error('velocity mainnet quote mint mismatch');
  if (!env.KELVARA_OBSERVATION_HUB_URL || !env.KELVARA_OBSERVATION_HUB_TOKEN) throw new Error('KELVARA_OBSERVATION_HUB_URL and KELVARA_OBSERVATION_HUB_TOKEN are required');
  if (env.KELVARA_OBSERVATION_HUB_TOKEN.length < 32) throw new Error('KELVARA_OBSERVATION_HUB_TOKEN must be at least 32 characters');
  const controlPlane = env.CONTROL_PLANE_URL && env.CONTROL_PLANE_ADMIN_TOKEN ? { url: env.CONTROL_PLANE_URL.replace(/\/$/, ''), token: env.CONTROL_PLANE_ADMIN_TOKEN } : null;
  if (controlPlane && controlPlane.token.length < 32) throw new Error('CONTROL_PLANE_ADMIN_TOKEN must be at least 32 characters');
  const viewerUrl = env.VELOCITY_VIEWER_URL || env.KELVARA_OBSERVATION_HUB_URL;
  const viewerToken = env.VELOCITY_VIEWER_TOKEN || '';
  if (viewerToken.length < 32) throw new Error('VELOCITY_VIEWER_TOKEN must be at least 32 characters');
  return { indexerId: env.INDEXER_ID || `velocity-${network === 'mainnet-beta' ? 'mainnet' : 'devnet'}`, protocol: 'velocity', network, programId, quoteMint, rpcUrl: env.SOLANA_RPC_URL || MAINNET_RPC, backendUrl: env.KELVARA_OBSERVATION_HUB_URL.replace(/\/$/, ''), backendToken: env.KELVARA_OBSERVATION_HUB_TOKEN, controlPlane, viewer: { url: viewerUrl.replace(/\/$/, ''), token: viewerToken } };
}
export function decodeVelocityAccount() { throw new Error('unsupported_velocity_account_layout'); }
export function createVelocityIndexer({ fetchDesiredTargets, now = () => new Date(), fetchAccount = null, fetchCursor = null, submitObservationBatch = null, postObservation = null, network = null, programId = null }) {
  if (typeof fetchDesiredTargets !== 'function') throw new TypeError('fetchDesiredTargets is required');
  return { async reconcile() {
    const targets = await fetchDesiredTargets(); const results = [];
    for (const target of targets) {
      if (target.status === 'paused' || target.status === 'retired') { results.push({ targetId: target.id || target.targetId, status: target.status }); continue; }
      if (network && target.network !== network || programId && target.programId !== programId) { results.push({ targetId: target.id || target.targetId, status: 'degraded', reason: 'network_or_program_mismatch' }); continue; }
      if (!target.expectedOwner || !Number.isInteger(target.expectedDataLength)) { results.push({ targetId: target.id || target.targetId, status: 'unsupported', reason: 'velocity_protocol_facts_unverified' }); continue; }
      if (!fetchAccount) { results.push({ targetId: target.id || target.targetId, status: 'unsupported', reason: 'raw_account_probe_unconfigured' }); continue; }
      try {
        const account = await fetchAccount(target); const owner = account?.owner; const length = account?.dataLength ?? account?.data?.length;
        if (owner !== target.expectedOwner || length !== target.expectedDataLength || (account.executable ?? false) !== Boolean(target.expectedExecutable)) throw new Error('account_facts_mismatch');
        if (postObservation) await postObservation(target, account);
        const bytes = Buffer.isBuffer(account?.data) ? account.data : Buffer.from(account?.data || []);
        const evidence = { network: target.network, programId: target.programId, address: target.address, owner, executable: Boolean(account.executable), dataLength: length, slot: account.slot ?? account.context?.slot ?? null, dataHash: createHash('sha256').update(bytes).digest('hex'), observedAt: now().toISOString(), provenance: target.provenance, schema: target.decoderFamily || 'raw-account-v1', decoder: target.decoderVersion || '1.0.0' };
        let ingestion = null;
        if (submitObservationBatch) {
          const cursorBefore = fetchCursor ? await fetchCursor(target) : { slot: 0, signature: null };
          const cursorAfter = { slot: evidence.slot ?? cursorBefore.slot, signature: null };
          const rawRecord = { type: 'raw_account', address: target.address, accountHash: evidence.dataHash, slot: cursorAfter.slot, owner, dataLength: length, dataHash: evidence.dataHash, executable: evidence.executable, decoderFamily: evidence.schema, decoderVersion: evidence.decoder };
          const batchId = createHash('sha256').update(`${target.targetId || target.id}:${cursorAfter.slot}:${evidence.dataHash}`).digest('hex');
          try {
            ingestion = await submitObservationBatch({ schemaVersion: 1, batchId, indexerId: target.indexerId || 'velocity-mainnet', targetId: target.targetId || target.id, network: target.network, observedAt: evidence.observedAt, cursorBefore, cursorAfter, records: [rawRecord] });
          } catch (error) { results.push({ targetId: target.id || target.targetId, status: 'degraded', reason: `observation_ingestion_failed:${error.message}` }); continue; }
        }
        results.push({ targetId: target.id || target.targetId, status: 'observing', owner, dataLength: length, evidence, ingestion });
      } catch (error) { results.push({ targetId: target.id || target.targetId, status: 'degraded', reason: error.message }); }
    }
    return { status: results.some(item => ['degraded', 'unsupported'].includes(item.status)) ? 'degraded' : results.length ? 'observing' : 'paused', observedAt: now().toISOString(), targets: results };
  } };
}
export { MAINNET_TARGETS, DEVNET_TARGETS };
