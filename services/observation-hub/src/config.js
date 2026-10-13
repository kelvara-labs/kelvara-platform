import { createPublicKey } from 'node:crypto';

export function loadBackendConfig(env = process.env) {
  const host = env.HOST || '0.0.0.0';
  const port = Number(env.PORT || 7610);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError('PORT must be an integer from 1 to 65535');
  }
  if (!env.INDEXER_TOKENS_JSON) throw new TypeError('INDEXER_TOKENS_JSON is required');
  let rawTokens;
  try {
    rawTokens = JSON.parse(env.INDEXER_TOKENS_JSON);
  } catch {
    throw new TypeError('INDEXER_TOKENS_JSON must be valid JSON');
  }
  if (!rawTokens || typeof rawTokens !== 'object' || Array.isArray(rawTokens)) {
    throw new TypeError('INDEXER_TOKENS_JSON must be an object');
  }
  const tokens = new Map(Object.entries(rawTokens));
  if (tokens.size === 0) throw new TypeError('INDEXER_TOKENS_JSON requires at least one token');
  let rawSources = {};
  const walletEvaluationConfigured = Boolean(env.WALLET_SAFEGUARD_EVALUATION_TOKEN || env.CONTROL_PLANE_WALLET_SAFEGUARD_URL || env.PRIVATE_EVALUATION_RECEIPT_TOKEN);
  if (!env.OBSERVATION_PRODUCER_SOURCES_JSON && !walletEvaluationConfigured && tokens.size === 1) rawSources = { [tokens.keys().next().value]: 'default' };
  if (env.OBSERVATION_PRODUCER_SOURCES_JSON) {
    try { rawSources = JSON.parse(env.OBSERVATION_PRODUCER_SOURCES_JSON); } catch { throw new TypeError('OBSERVATION_PRODUCER_SOURCES_JSON must be valid JSON'); }
    if (!rawSources || typeof rawSources !== 'object' || Array.isArray(rawSources)) throw new TypeError('OBSERVATION_PRODUCER_SOURCES_JSON must be an object');
  }
  const observationProducerSources = new Map(Object.entries(rawSources));
  if (observationProducerSources.size !== tokens.size || [...tokens.keys()].some(id => !observationProducerSources.has(id))) throw new TypeError('OBSERVATION_PRODUCER_SOURCES_JSON must map every producer');
  const velocityViewerToken = env.VELOCITY_VIEWER_TOKEN || '';
  if (velocityViewerToken.length < 32) throw new TypeError('VELOCITY_VIEWER_TOKEN must contain at least 32 characters');
  for (const [indexerId, token] of tokens) {
    if (!indexerId || typeof token !== 'string' || token.length < 32) {
      throw new TypeError('each indexer requires a non-empty token');
    }
  }
  const evacuationToken = env.EVACUATION_EVENTS_TOKEN || '';
  const evaluationToken = env.EVALUATION_RECEIPTS_TOKEN || '';
  const revalidationToken = env.EVACUATION_REVALIDATION_TOKEN || '';
  const walletSafeguardToken = env.WALLET_SAFEGUARD_EVALUATION_TOKEN || '';
  const assignmentToken = env.ASSIGNMENT_TOKEN || '';
  const privateReceiptToken = env.PRIVATE_EVALUATION_RECEIPT_TOKEN || '';
  const ownerAuthorityPublicKey = env.OWNER_AUTHORITY_PUBLIC_KEY || '';
  if ((privateReceiptToken && !ownerAuthorityPublicKey) || (!privateReceiptToken && ownerAuthorityPublicKey)) throw new TypeError('private receipt token and owner authority public key must be configured together');
  if (privateReceiptToken && privateReceiptToken.length < 32) throw new TypeError('PRIVATE_EVALUATION_RECEIPT_TOKEN must contain at least 32 characters');
  if (ownerAuthorityPublicKey && typeof ownerAuthorityPublicKey !== 'string') throw new TypeError('OWNER_AUTHORITY_PUBLIC_KEY must be configured');
  if (privateReceiptToken && privateReceiptToken === evaluationToken) throw new TypeError('service tokens must be distinct');
  if (ownerAuthorityPublicKey) {
    try { createPublicKey(ownerAuthorityPublicKey); } catch { throw new TypeError('OWNER_AUTHORITY_PUBLIC_KEY must be a valid public key'); }
  }
  for (const [name, token] of [['EVACUATION_EVENTS_TOKEN', evacuationToken], ['EVALUATION_RECEIPTS_TOKEN', evaluationToken], ['EVACUATION_REVALIDATION_TOKEN', revalidationToken], ['WALLET_SAFEGUARD_EVALUATION_TOKEN', walletSafeguardToken], ['ASSIGNMENT_TOKEN', assignmentToken]]) {
    if (token && token.length < 32) throw new TypeError(`${name} must contain at least 32 characters`);
  }
  const walletSafeguardUrl = env.CONTROL_PLANE_WALLET_SAFEGUARD_URL || '';
  const controlPlaneWalletSafeguardToken = env.CONTROL_PLANE_WALLET_SAFEGUARD_TOKEN || '';
  if ((walletSafeguardUrl && !controlPlaneWalletSafeguardToken) || (!walletSafeguardUrl && controlPlaneWalletSafeguardToken)) throw new TypeError('wallet safeguard URL and token must be configured together');
  if (walletSafeguardUrl && !/^https?:\/\//.test(walletSafeguardUrl)) throw new TypeError('CONTROL_PLANE_WALLET_SAFEGUARD_URL must be an HTTP URL');
  if (controlPlaneWalletSafeguardToken) {
    if (controlPlaneWalletSafeguardToken.length < 32) throw new TypeError('CONTROL_PLANE_WALLET_SAFEGUARD_TOKEN must contain at least 32 characters');
    if (walletSafeguardToken === controlPlaneWalletSafeguardToken) throw new TypeError('service tokens must be distinct');
  }
  let scenarioRegistry;
  try { scenarioRegistry=JSON.parse(env.SCENARIO_CAPSULE_REGISTRY_JSON||'[]'); } catch { throw new TypeError('SCENARIO_CAPSULE_REGISTRY_JSON must be valid JSON'); }
  if(!Array.isArray(scenarioRegistry))throw new TypeError('SCENARIO_CAPSULE_REGISTRY_JSON must be an array');
  let governanceReaderScopes;
  try { governanceReaderScopes=JSON.parse(env.GOVERNANCE_READER_SCOPES_JSON||'{}'); } catch { throw new TypeError('GOVERNANCE_READER_SCOPES_JSON must be valid JSON'); }
  if(!governanceReaderScopes||typeof governanceReaderScopes!=='object'||Array.isArray(governanceReaderScopes))throw new TypeError('GOVERNANCE_READER_SCOPES_JSON must be an object');
  for(const [producer,wallets] of Object.entries(governanceReaderScopes)){if(!tokens.has(producer)||!wallets||typeof wallets!=='object'||Array.isArray(wallets)||Object.keys(wallets).some(wallet=>wallet==='*'||!wallet||!Array.isArray(wallets[wallet])||wallets[wallet].length===0||wallets[wallet].some(target=>typeof target!=='string'||!target||target==='*')))throw new TypeError('governance reader scope invalid')}
  let governanceSubjectBindings;
  try { governanceSubjectBindings=JSON.parse(env.GOVERNANCE_SUBJECT_BINDINGS_JSON||'[]'); } catch { throw new TypeError('GOVERNANCE_SUBJECT_BINDINGS_JSON must be valid JSON'); }
  if(!Array.isArray(governanceSubjectBindings))throw new TypeError('GOVERNANCE_SUBJECT_BINDINGS_JSON must be an array');
  const bindingKeys=new Set();for(const binding of governanceSubjectBindings){const key=`${binding?.network}:${binding?.subjectAddress}`;if(!binding||typeof binding!=='object'||Array.isArray(binding)||!['mainnet-beta','devnet','testnet','localnet'].includes(binding.network)||typeof binding.subjectAddress!=='string'||!binding.subjectAddress||typeof binding.positionId!=='string'||!binding.positionId||bindingKeys.has(key))throw new TypeError('governance subject binding invalid');bindingKeys.add(key)}
  const allTokens = [...tokens.values(), evacuationToken, evaluationToken, revalidationToken, walletSafeguardToken, assignmentToken, privateReceiptToken, controlPlaneWalletSafeguardToken].filter(Boolean);
  if (new Set(allTokens).size !== allTokens.length) throw new TypeError('service tokens must be distinct');
  return {
    host,
    port,
    databasePath: env.DATABASE_PATH || '/data/kelvara-observation.sqlite',
    tokens,
    observationProducerSources,
    velocityViewerToken,
    evacuationToken,
    evaluationToken,
    revalidationToken,
    walletSafeguardToken,
    walletSafeguardUrl,
    controlPlaneWalletSafeguardToken,
    assignmentToken,
    privateReceiptToken,
    ownerAuthorityPublicKey,
    scenarioRegistry,
    governanceReaderScopes,
    governanceSubjectBindings
  };
}
