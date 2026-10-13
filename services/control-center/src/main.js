import { pathToFileURL } from 'node:url';

import { loadControlPlaneConfig } from './config.js';
import { createControlPlaneServer } from './server.js';
import { createControlPlaneStore } from './store.js';
import { createControlBaselineStore } from './control-baseline-store.js';
import { createGovernanceBaselineReconciler } from './governance-baseline-reconciler.js';
import { createGovernanceSubjectMappingStore } from './governance-subject-mapping-store.js';
import { bootstrapVerifiedGovernanceMappings, parseVerifiedGovernanceMappings } from './runtime-governance-mappings.js';
import { createPreflightService, KAMINO_OWNER, KAMINO_LENGTH } from './preflight.js';
import { createAssignmentOutboxDelivery } from './outbox-delivery.js';
import { createKaminoMetricsAdapter } from './kamino-metrics.js';
import { createPermitVaultClient } from './permit-vault.js';
import { KAMINO_KVAULT_PROFILE } from './kamino-profile.js';
import { decodeVaultAccount } from '../../indexer-kamino/src/decode-vault.js';
import { deriveV4VaultPda } from './squads-vault-pda.js';
import { ensureDemoPositionPolicy, parseDemoPositionPolicy } from './demo-position-policy.js';

const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

// Production adapters are explicit metadata only; store validation remains fail-closed when omitted.
export const PRODUCTION_DISCOVERY_ADAPTERS = Object.freeze([
  Object.freeze({ id: 'kamino', version: 1 }),
  Object.freeze({ id: KAMINO_KVAULT_PROFILE.discoveryAdapter.id, version: KAMINO_KVAULT_PROFILE.discoveryAdapter.version }),
  Object.freeze({ id: 'kelvara-governance-lab', version: 1 }),
  Object.freeze({ id: 'kelvara-demo-position', version: 1 })
]);

async function rpcAccount(rpcUrl, address, signal, fetchImpl = fetch) {
  const response = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [address, { encoding: 'base64', commitment: 'finalized' }] }) });
  if (!response.ok) throw new Error(`rpc_http_${response.status}`);
  const body = await response.json();
  if (body.error || !body.result?.value) throw new Error('rpc_account_unavailable');
  const value = body.result.value;
  const data = Buffer.from(value.data?.[0] ?? '', 'base64');
  return { owner: value.owner, dataLength: data.length, executable: Boolean(value.executable), data, slot: body.result.context?.slot ?? null };
}

export function productionPreflight(config, { fetchImpl = fetch } = {}) {
  const rpcUrl = config.rpcUrl || DEFAULT_RPC_URL;
  return createPreflightService({
    rpcChecker: (entry, signal) => rpcAccount(rpcUrl, entry.address, signal, fetchImpl),
    kaminoAdapter: { decode: async (input, signal) => { const account = await rpcAccount(rpcUrl, input.address, signal, fetchImpl); const decoded = decodeVaultAccount(account, KAMINO_OWNER); return { owner: account.owner, dataLength: account.dataLength, decoderFamily: 'kamino-vault', decoderVersion: decoded.decoderVersion, tokenMint: decoded.tokenMint, sharesMint: decoded.sharesMint }; } },
    metricsAdapter: createKaminoMetricsAdapter(config.kaminoMetricsBaseUrl === undefined ? { fetchImpl } : { fetchImpl, baseUrl: config.kaminoMetricsBaseUrl })
  });
}

export async function startControlPlane(config) {
  const store = createControlPlaneStore({ path: config.databasePath, registeredDiscoveryAdapters: PRODUCTION_DISCOVERY_ADAPTERS });
  const demoPolicy = config.demoPositionPolicy ?? parseDemoPositionPolicy(process.env.DEMO_POSITION_POLICY_JSON);
  const demoPolicyReconciliation = demoPolicy ? ensureDemoPositionPolicy(store, demoPolicy) : null;
  const targetAuthorityReconciliation = store.reconcileTargetAuthorities();
  const baselineStore = createControlBaselineStore({ path: config.databasePath.replace(/\.sqlite$/, '-control-baselines.sqlite'), authorize: input => input.source==='governance-control/v1'||store.authorizeControlBaseline(input) });
  const mappingStore = config.governanceMappingStore ?? createGovernanceSubjectMappingStore({ path: config.databasePath.replace(/\.sqlite$/, '-governance-mappings.sqlite'), deriveVaultPda: config.deriveGovernanceVaultPda ?? deriveV4VaultPda });
  bootstrapVerifiedGovernanceMappings(mappingStore,config.governanceVerifiedMappings??parseVerifiedGovernanceMappings(process.env.GOVERNANCE_VERIFIED_MAPPINGS_JSON));
  const readGovernanceEvidence = config.readGovernanceEvidence ?? (async ({walletId,network,governanceSubjectId}) => { let response;try{response=await fetch(`${config.observationHubUrl}/internal/v1/wallets/${encodeURIComponent(walletId)}/subjects/${encodeURIComponent(governanceSubjectId)}/governance-control?network=${encodeURIComponent(network)}`,{headers:{authorization:`Bearer ${config.observationHubToken}`},signal:AbortSignal.timeout(2000)})}catch{throw new Error('upstream_unavailable')}if(response.status===403)throw new Error('subject_mismatch');if(!response.ok)throw new Error('upstream_unavailable');try{return await response.json()}catch{throw new Error('governance_evidence_missing')} });
  const resolveMapping=async({positionId})=>{const value=mappingStore.get(positionId);if(!value)return null;return{positionId,governanceSubjectId:value.vaultAuthority,network:value.network,status:value.status,multisigAddress:value.multisigAddress,programId:value.proof?.programId,provider:'squads',generation:'v4',vaultAddress:value.vaultAuthority}};
  const reconcileEligiblePositions=async input=>createGovernanceBaselineReconciler({baselineStore,resolveMapping,readGovernanceEvidence,reconcileEnrollments:positions=>store.reconcileEligiblePositionEnrollments({...input,positions})}).reconcile(input);
  const preflight = config.preflight ?? productionPreflight(config);
  const permitVault = config.permitVault ?? createPermitVaultClient({ baseUrl: config.permitVaultUrl, readToken: config.permitVaultReadToken });
  const server = createControlPlaneServer({ store, credentials: config.credentials, preflight, permitVault, baselineStore, reconcileEligiblePositions, readControlBaseline: input => baselineStore.readActive(input), authorizeControlBaselineRead: () => false, readGovernanceBindings: input => baselineStore.readGovernanceBindings(input), authorizeGovernanceBindingsRead: input => store.authorizeGovernanceBindingsRead(input) });
  const outbox = createAssignmentOutboxDelivery({ store, hubUrl: config.observationHubUrl, token: config.observationHubToken, intervalMs: config.outboxIntervalMs, maxAttempts: config.outboxMaxAttempts });
  try {
    await new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.port, config.host);
    });
    await outbox.start();
  } catch (error) {
    await outbox.close();
    mappingStore.close();
    baselineStore.close();
    store.close();
    throw error;
  }

  let closed = false;
  return {
    server,
    store,
    baselineStore,
    demoPolicyReconciliation,
    targetAuthorityReconciliation,
    async close() {
      if (closed) return;
      closed = true;
      await outbox.close();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      mappingStore.close();
      baselineStore.close();
      store.close();
    }
  };
}

async function run() {
  const runtime = await startControlPlane(loadControlPlaneConfig());
  const address = runtime.server.address();
  console.log(`Kelvara Control Plane listening on ${address.address}:${address.port}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await runtime.close();
      process.exitCode = 0;
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
