import { createVaultSnapshot } from './snapshot.js';
import { normalizeSnapshotBatch } from './normalize.js';

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const DEFAULT_PROGRAM = 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd';
const DEFAULT_TARGET = {
  address: 'BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5',
  displayName: 'Steakhouse USDG High Yield',
  curator: 'Steakhouse Financial',
  kind: 'kvault'
};

function booleanValue(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

function parseTargets(value, indexerId) {
  const input = value ? JSON.parse(value) : [DEFAULT_TARGET];
  if (!Array.isArray(input) || input.length === 0) throw new TypeError('TARGETS_JSON must contain at least one target');
  return input.map((entry) => ({
    id: entry.id || `${indexerId}:${entry.address}`,
    indexerId,
    protocol: 'kamino',
    network: entry.network || 'mainnet-beta',
    kind: entry.kind || 'kvault',
    address: entry.address,
    programId: entry.programId || DEFAULT_PROGRAM,
    displayName: entry.displayName || entry.address,
    curator: entry.curator || 'Unknown',
    enabled: entry.enabled !== false
  }));
}

export function loadWorkerConfig(env = process.env) {
  const indexerId = env.INDEXER_ID || 'kamino-mainnet';
  const pollIntervalMs = Number(env.POLL_INTERVAL_MS || 60_000);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 5_000) throw new RangeError('POLL_INTERVAL_MS must be an integer of at least 5000');
  const backfillDays = Number(env.BACKFILL_DAYS || 7);
  if (!Number.isInteger(backfillDays) || backfillDays < 1 || backfillDays > 365) throw new RangeError('BACKFILL_DAYS must be an integer from 1 to 365');
  const rpcHttpUrls = [env.SOLANA_RPC_PRIMARY, env.SOLANA_RPC_FALLBACK, DEFAULT_RPC].filter(Boolean);
  return {
    indexerId,
    version: env.npm_package_version || '0.1.0',
    host: env.HEALTH_HOST || '0.0.0.0',
    port: Number(env.HEALTH_PORT || 7620),
    pollIntervalMs,
    backfillDays,
    rpcHttpUrls: [...new Set(rpcHttpUrls)],
    rpcWebsocketUrl: env.SOLANA_RPC_WEBSOCKET || '',
    solamiConfigured: Boolean(env.SOLAMI_GRPC_ENDPOINT && env.SOLAMI_GRPC_KEY),
    backendUrl: (env.KELVARA_OBSERVATION_HUB_URL || '').replace(/\/$/, ''),
    backendToken: env.KELVARA_OBSERVATION_HUB_TOKEN || '',
    alertWebhookUrl: env.ALERT_WEBHOOK_URL || '',
    canaryMode: booleanValue(env.CANARY_MODE, true),
    reconcileDesiredTargets: Boolean(env.KELVARA_OBSERVATION_HUB_URL && env.KELVARA_OBSERVATION_HUB_TOKEN),
    emergencyBootstrap: String(env.KELVARA_EMERGENCY_BOOTSTRAP || '').toLowerCase() === 'true',
    targets: parseTargets(env.TARGETS_JSON, indexerId)
  };
}

export function createRuntimeMetrics({ now = () => Date.now(), historyLimit = 240 } = {}) {
  const startedAtMs = now();
  let total = 0;
  let succeeded = 0;
  let failed = 0;
  let rpcChange = 0;
  let canary = 0;
  let durationTotal = 0;
  let latencyTotal = 0;
  let latencySamples = 0;
  let lastDurationMs = null;
  const continuity = [];
  return {
    record(status, reason, durationMs) {
      total += 1;
      if (status.overall === 'healthy') succeeded += 1;
      else failed += 1;
      if (reason === 'rpc-change') rpcChange += 1;
      if (reason === 'canary') canary += 1;
      lastDurationMs = durationMs;
      durationTotal += durationMs;
      for (const target of status.targets || []) {
        if (Number.isFinite(target.latencyMs)) {
          latencyTotal += target.latencyMs;
          latencySamples += 1;
        }
      }
      continuity.push({ at: new Date(now()).toISOString(), status: status.overall, reason, durationMs });
      if (continuity.length > historyLimit) continuity.splice(0, continuity.length - historyLimit);
    },
    snapshot() {
      return {
        startedAt: new Date(startedAtMs).toISOString(),
        uptimeMs: Math.max(0, now() - startedAtMs),
        cycles: {
          total, succeeded, failed,
          successRate: total ? Math.round((succeeded / total) * 10_000) / 100 : null,
          lastDurationMs,
          averageDurationMs: total ? Math.round(durationTotal / total) : null
        },
        triggers: { rpcChange, canary },
        rpc: {
          samples: latencySamples,
          averageLatencyMs: latencySamples ? Math.round(latencyTotal / latencySamples) : null
        },
        continuity: [...continuity]
      };
    }
  };
}

export function createSequentialRunner(run) {
  let running = false;
  let pendingReason = null;
  let idlePromise = Promise.resolve();
  async function drain(reason) {
    running = true;
    let next = reason;
    try {
      while (next) {
        pendingReason = null;
        await run(next);
        next = pendingReason;
      }
    } finally {
      running = false;
    }
  }
  return {
    trigger(reason) {
      if (running) {
        pendingReason = reason;
        return idlePromise;
      }
      idlePromise = drain(reason);
      return idlePromise;
    },
    whenIdle() { return idlePromise; }
  };
}

async function fetchJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) { const error = new Error(`${response.status} ${body?.error?.code ? `${body.error.code}: ` : ''}${body?.error?.message || response.statusText}`); error.code = body?.error?.code; throw error; }
  return body;
}

export async function postBackend(config, path, method, body, fetchImpl = fetch) {
  if (!config.backendUrl || !config.backendToken) return null;
  return fetchJson(`${config.backendUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.backendToken}` },
    body: JSON.stringify(body)
  }, fetchImpl);
}

export async function loadDesiredTargets(config, fetchImpl = fetch) {
  if (!config.backendUrl || !config.backendToken) return { authoritative: false, mode: 'standalone', targets: config.targets };
  try {
    const body = await fetchJson(`${config.backendUrl}/internal/indexers/${config.indexerId}/desired-targets`, {
      method: 'GET', headers: { authorization: `Bearer ${config.backendToken}` }
    }, fetchImpl);
    return { authoritative: true, mode: 'authoritative', targets: (body.targets || []).map(target => ({
      id: target.target_id || target.id, indexerId: config.indexerId, protocol: target.protocol,
      network: target.network, kind: target.kind, address: target.address,
      programId: target.programId || DEFAULT_PROGRAM, displayName: target.display_name || target.displayName || target.address,
      curator: target.curator || 'Unknown', enabled: true
    })) };
  } catch (error) {
    if (config.emergencyBootstrap === true && error.code === 'unconfigured') return { authoritative: false, mode: 'emergency', targets: config.targets };
    throw error;
  }
}

export async function loadBackendCursors(config, fetchImpl = fetch) {
  const cursors = new Map();
  if (!config.backendUrl || !config.backendToken) return cursors;
  const body = await fetchJson(`${config.backendUrl}/internal/indexers/${config.indexerId}/cursors?stream=account_snapshot`, {
    method: 'GET',
    headers: { authorization: `Bearer ${config.backendToken}` }
  }, fetchImpl);
  for (const item of body.cursors || []) cursors.set(item.targetId, item.cursor);
  return cursors;
}

export async function registerWithBackend(config, fetchImpl = fetch) {
  if (!config.backendUrl || !config.backendToken) return { mode: 'standalone' };
  const registration = {
    indexerId: config.indexerId,
    protocol: 'kamino',
    network: 'mainnet-beta',
    version: config.version,
    capabilities: ['accounts', 'vault-state', 'authorities']
  };
  await postBackend(config, '/internal/indexers/register', 'POST', registration, fetchImpl);
  const targets = config.targets.map(({ programId, ...target }) => target);
  await postBackend(config, `/internal/indexers/${config.indexerId}/targets`, 'PUT', { indexerId: config.indexerId, targets }, fetchImpl);
  return { mode: 'backend' };
}

async function fetchAccount(target, rpcUrls, fetchImpl) {
  const errors = [];
  for (const rpcUrl of rpcUrls) {
    const started = Date.now();
    try {
      const payload = await fetchJson(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [target.address, { encoding: 'base64', commitment: 'finalized' }] })
      }, fetchImpl);
      if (payload.error) throw new Error(`RPC ${payload.error.code}: ${payload.error.message}`);
      return { rpcResult: payload.result, provider: new URL(rpcUrl).hostname, latencyMs: Date.now() - started };
    } catch (error) {
      errors.push(`${new URL(rpcUrl).hostname}: ${error.message}`);
    }
  }
  throw new Error(errors.join('; '));
}

async function notifyWebhook(config, status, previousStatus, fetchImpl) {
  if (!config.alertWebhookUrl) return;
  const changed = previousStatus?.overall !== status.overall;
  if (!changed && !(config.canaryMode && status.reason === 'canary')) return;
  const payload = {
    event: 'kamino_indexer_status',
    delivery: 'generic-webhook',
    indexerId: config.indexerId,
    status: status.overall,
    observedAt: status.observedAt,
    liveConnected: status.live.connected,
    targetCount: status.targets.length,
    failedTargets: status.targets.filter((item) => item.status === 'error').map((item) => item.id),
    message: status.overall === 'healthy' ? 'Kamino indexer is operational.' : 'Kamino indexer requires attention.'
  };
  await fetchJson(config.alertWebhookUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  }, fetchImpl);
}

export async function runMonitoringCycle({ config, fetchImpl = fetch, liveConnected = false, previousStatus = null, now = () => new Date(), cursors = new Map(), reason = 'canary', reconciliationState = { targets: [] } }) {
  const observedAt = now().toISOString();
  let desired;
  let reconciliation = { mode: 'standalone', state: 'unconfigured', authoritative: false };
  try {
    desired = config.reconcileDesiredTargets
      ? await loadDesiredTargets(config, fetchImpl)
      : { authoritative: false, mode: 'standalone', targets: config.targets };
    if (desired.authoritative) reconciliationState.targets = desired.targets;
    reconciliation = { mode: desired.mode, state: desired.authoritative ? 'observing' : desired.mode === 'emergency' ? 'emergency' : 'unconfigured', authoritative: desired.authoritative };
  } catch (error) {
    const retained = reconciliationState.targets;
    desired = { authoritative: retained.length > 0, mode: 'degraded', targets: retained };
    reconciliation = { mode: 'degraded', state: 'degraded', authoritative: retained.length > 0, error: error.message };
  }
  const targets = [];
  const activeConfig = { ...config, targets: desired.targets };
  if (reconciliation.state === 'degraded') {
    const status = {
      indexerId: config.indexerId, protocol: 'kamino', network: 'mainnet-beta', version: config.version || '0.1.0',
      overall: 'degraded', observedAt, reason, pollIntervalMs: config.pollIntervalMs || 60_000, canaryMode: config.canaryMode,
      live: { configured: Boolean(config.rpcWebsocketUrl), connected: liveConnected },
      backend: { configured: true, mode: 'error', error: reconciliation.error }, notifications: { configured: Boolean(config.alertWebhookUrl), type: 'generic-webhook' },
      targets: activeConfig.targets.map(target => ({ id: target.id, address: target.address, displayName: target.displayName, status: 'degraded', error: reconciliation.error, observedAt })), reconciliation
    };
    return status;
  }
  for (const target of activeConfig.targets) {
    if (!target.enabled) {
      targets.push({ id: target.id, address: target.address, displayName: target.displayName, status: 'disabled' });
      continue;
    }
    try {
      const rpc = await fetchAccount(target, config.rpcHttpUrls, fetchImpl);
      const snapshot = createVaultSnapshot({ address: target.address, programId: target.programId, rpcResult: rpc.rpcResult });
      const cursorBefore = cursors.get(target.id) || { signature: null, slot: 0 };
      const batch = normalizeSnapshotBatch({ snapshot, indexerId: config.indexerId, targetId: target.id, network: target.network, cursorBefore, observedAt });
      const acknowledgment = await postBackend(config, `/internal/indexers/${config.indexerId}/batches`, 'POST', batch, fetchImpl);
      const committedCursor = acknowledgment?.committedCursor || batch.cursorAfter;
      cursors.set(target.id, committedCursor);
      targets.push({
        id: target.id, address: target.address, displayName: target.displayName, status: 'healthy',
        slot: snapshot.slot, accountHash: snapshot.accountHash, provider: rpc.provider,
        latencyMs: rpc.latencyMs, observedAt, backendCommitted: Boolean(acknowledgment)
      });
    } catch (error) {
      targets.push({ id: target.id, address: target.address, displayName: target.displayName, status: 'error', error: error.message, observedAt });
    }
  }
  const failed = targets.filter((target) => target.status === 'error');
  const status = {
    indexerId: config.indexerId,
    protocol: 'kamino',
    network: 'mainnet-beta',
    version: config.version || '0.1.0',
    overall: failed.length === 0 ? 'healthy' : failed.length === targets.length ? 'error' : 'degraded',
    observedAt,
    reason,
    pollIntervalMs: config.pollIntervalMs || 60_000,
    canaryMode: config.canaryMode,
    live: { configured: Boolean(config.rpcWebsocketUrl), connected: liveConnected },
    backend: { configured: Boolean(config.backendUrl && config.backendToken), mode: config.backendUrl && config.backendToken ? 'connected' : 'standalone' },
    notifications: { configured: Boolean(config.alertWebhookUrl), type: 'generic-webhook' },
    targets,
    reconciliation
  };
  try {
    await postBackend(config, `/internal/indexers/${config.indexerId}/heartbeat`, 'POST', {
      indexerId: config.indexerId,
      status: status.overall,
      lastSuccessAt: failed.length === targets.length ? null : observedAt,
      error: failed.length ? { code: 'target_poll_failed', message: failed.map((item) => `${item.displayName}: ${item.error}`).join('; ') } : null
    }, fetchImpl);
  } catch (error) {
    status.backend = { configured: true, mode: 'error', error: error.message };
    if (status.overall === 'healthy') status.overall = 'degraded';
  }
  try {
    await notifyWebhook(config, status, previousStatus, fetchImpl);
  } catch (error) {
    status.notifications = { configured: true, type: 'generic-webhook', error: error.message };
  }
  return status;
}

export function createRpcChangeListener({ url, targets, onChange, onState, WebSocketImpl = globalThis.WebSocket }) {
  if (!url || !WebSocketImpl) return { close() {}, configured: false };
  let socket;
  let stopped = false;
  let reconnectTimer;
  const connect = () => {
    if (stopped) return;
    socket = new WebSocketImpl(url);
    socket.addEventListener('open', () => {
      onState(true);
      targets.filter((target) => target.enabled).forEach((target, index) => socket.send(JSON.stringify({
        jsonrpc: '2.0', id: index + 1, method: 'accountSubscribe',
        params: [target.address, { encoding: 'base64', commitment: 'finalized' }]
      })));
    });
    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.method === 'accountNotification') onChange();
      } catch {}
    });
    const disconnected = () => {
      onState(false);
      if (!stopped && !reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5_000);
    };
    socket.addEventListener('close', disconnected);
    socket.addEventListener('error', () => { try { socket.close(); } catch {} });
  };
  connect();
  return {
    configured: true,
    close() { stopped = true; clearTimeout(reconnectTimer); try { socket?.close(); } catch {} }
  };
}
