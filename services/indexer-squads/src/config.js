const NETWORKS = new Set(['mainnet-beta', 'devnet', 'testnet', 'localnet']);
const MIN_TOKEN_LENGTH = 32;

function required(env, name) {
  if (typeof env[name] !== 'string' || env[name].length === 0) throw new TypeError(`${name} is required`);
  return env[name];
}

export function loadSquadsAssignments(env = process.env) {
  if (env.SQUADS_SUBJECT_ADDRESS || env.SQUADS_MULTISIG_ADDRESS || env.SQUADS_AUTHORITY_INDEX) throw new TypeError('legacy single-subject configuration is unsupported; migrate to SQUADS_ASSIGNMENTS_JSON');
  const raw = required(env, 'SQUADS_ASSIGNMENTS_JSON'); let value;
  try { value = JSON.parse(raw); } catch { throw new TypeError('SQUADS_ASSIGNMENTS_JSON must be valid JSON'); }
  if (!Array.isArray(value)) throw new TypeError('SQUADS_ASSIGNMENTS_JSON must be an array');
  return value;
}

export function loadSquadsConfig(env = process.env) {
  const network = required(env, 'NETWORK');
  if (!NETWORKS.has(network)) throw new TypeError('NETWORK must be a supported Solana network');
  const hubToken = required(env, 'KELVARA_OBSERVATION_HUB_TOKEN');
  if (hubToken.length < MIN_TOKEN_LENGTH) throw new TypeError('KELVARA_OBSERVATION_HUB_TOKEN must contain at least 32 characters');
  const authorityIndex = Number(required(env, 'SQUADS_AUTHORITY_INDEX'));
  if (!Number.isInteger(authorityIndex) || authorityIndex < 0 || authorityIndex > 255) throw new TypeError('SQUADS_AUTHORITY_INDEX is invalid');
  const rpcUrl = required(env, 'SQUADS_RPC_URL');
  const hubUrl = required(env, 'KELVARA_OBSERVATION_HUB_URL').replace(/\/$/, '');
  let parsedRpc;
  let parsedHub;
  try { parsedRpc = new URL(rpcUrl); parsedHub = new URL(hubUrl); } catch { throw new TypeError('RPC and Observation Hub URLs must be valid URLs'); }
  const localRpc = parsedRpc.hostname === '127.0.0.1' || parsedRpc.hostname === 'localhost';
  if (parsedRpc.protocol !== 'https:' && !(localRpc && env.ALLOW_INSECURE_LOCAL_RPC === '1' && process.env.NODE_ENV === 'test')) throw new TypeError('SQUADS_RPC_URL must use HTTPS');
  if (!['http:', 'https:'].includes(parsedHub.protocol)) throw new TypeError('KELVARA_OBSERVATION_HUB_URL must use HTTP or HTTPS');
  const config = {
    network,
    rpcUrl,
    hubUrl,
    hubToken,
    indexerId: required(env, 'INDEXER_ID'),
    subjectAddress: required(env, 'SQUADS_SUBJECT_ADDRESS'),
    multisigAddress: required(env, 'SQUADS_MULTISIG_ADDRESS'),
    programId: required(env, 'SQUADS_PROGRAM_ID'),
    authorityIndex,
    timeoutMs: Number(env.SQUADS_TIMEOUT_MS || 10_000)
  };
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120_000) throw new TypeError('SQUADS_TIMEOUT_MS is invalid');
  return config;
}
