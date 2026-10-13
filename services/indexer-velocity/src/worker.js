import { createVelocityRuntimeServer, fetchVelocityAssignments, reportVelocityReconciliation } from './runtime.js';
import { createVelocityIndexer, loadVelocityConfig, postVelocityObservation } from './index.js';
export { postVelocityObservation };

const config = loadVelocityConfig();

export async function fetchVelocityAccount(target, rpcUrl = config.rpcUrl, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const call = async (method, params) => {
      const response = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }), signal: controller.signal });
      if (!response.ok) throw new Error(`rpc_http_${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(`rpc_${body.error.code || 'error'}:${body.error.message || 'request failed'}`);
      return body.result;
    };
    const account = await call('getAccountInfo', [target.address, { encoding: 'base64', commitment: 'finalized' }]);
    if (!account?.value) throw new Error('account_not_found');
    const value = account.value;
    const encoded = Array.isArray(value.data) ? value.data[0] : value.data;
    if (typeof encoded !== 'string') throw new Error('account_data_missing');
    const slot = account.context?.slot ?? (await call('getSlot', [{ commitment: 'finalized' }]));
    return { owner: value.owner, executable: Boolean(value.executable), data: Buffer.from(encoded, 'base64'), slot };
  } finally { clearTimeout(timeout); }
}

let status = { indexerId: config.indexerId, protocol: 'velocity', network: config.network, overall: 'starting', targets: [] };
async function hubJson(path, options = {}) {
  const response = await fetch(`${config.backendUrl}${path}`, { ...options, headers: { 'X-Kelvara-Authorization': `Bearer ${config.backendToken}`, ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(`hub_${response.status}:${body?.error?.message || response.statusText}`);
  return body;
}
async function fetchVelocityCursor(target) {
  const body = await hubJson(`/internal/indexers/${config.indexerId}/cursors?stream=account_snapshot`);
  return body.cursors?.find(item => item.targetId === (target.targetId || target.id))?.cursor || { slot: 0, signature: null };
}
async function submitVelocityObservationBatch(batch) {
  return hubJson(`/internal/indexers/${config.indexerId}/batches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch) });
}
const indexer = createVelocityIndexer({ fetchDesiredTargets: () => fetchVelocityAssignments(config), fetchCursor: fetchVelocityCursor, submitObservationBatch: submitVelocityObservationBatch, network: config.network, programId: config.programId, fetchAccount: target => fetchVelocityAccount(target), postObservation: (target, account) => postVelocityObservation(config, target, account, new Date().toISOString()) });
async function cycle() { try { const result = await indexer.reconcile(); status = { ...status, ...result, reconciliation: { state: result.status, targets: result.targets } }; await reportVelocityReconciliation(config, status); } catch (error) { status = { ...status, overall: 'degraded', error: error.message, reconciliation: { state: 'degraded', error: error.message } }; } }
const server = createVelocityRuntimeServer({ getStatus: () => status, controlPlane: config.controlPlane, viewer: config.viewer });
server.listen(Number(process.env.HEALTH_PORT || 7621), process.env.HEALTH_HOST || '0.0.0.0');
await cycle();
setInterval(cycle, Number(process.env.POLL_INTERVAL_MS || 60000));
