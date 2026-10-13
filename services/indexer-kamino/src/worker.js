import { createSolanaTransport } from '@kelvara/solana-transport';
import { createDashboardServer } from './dashboard-server.js';
import { createKaminoLiveRunner } from './live-runner.js';
import {
  createRpcChangeListener,
  createRuntimeMetrics,
  createSequentialRunner,
  loadBackendCursors,
  loadWorkerConfig,
  postBackend,
  registerWithBackend,
  runMonitoringCycle
} from './worker-core.js';

const config = loadWorkerConfig();
const metrics = createRuntimeMetrics();
let cursors = new Map();
const reconciliationState = { targets: [] };
let liveConnected = false;
let status = {
  indexerId: config.indexerId, protocol: 'kamino', network: 'mainnet-beta', version: config.version,
  overall: 'starting', observedAt: null, pollIntervalMs: config.pollIntervalMs, canaryMode: config.canaryMode,
  live: { configured: Boolean(config.rpcWebsocketUrl), connected: false },
  backend: { configured: Boolean(config.backendUrl && config.backendToken), mode: 'starting' },
  notifications: { configured: Boolean(config.alertWebhookUrl), type: 'generic-webhook' }, targets: []
};

try {
  const backend = await registerWithBackend(config);
  status.backend.mode = backend.mode;
  cursors = await loadBackendCursors(config);
} catch (error) {
  status.backend = { configured: true, mode: 'error', error: error.message };
}

const runner = createSequentialRunner(async (reason) => {
  const startedAt = Date.now();
  const next = await runMonitoringCycle({ config, liveConnected, previousStatus: status, cursors, reason, reconciliationState });
  metrics.record(next, reason, Date.now() - startedAt);
  status = { ...next, metrics: metrics.snapshot(), backfillDays: config.backfillDays };
  process.stdout.write(`${JSON.stringify({ level: next.overall === 'healthy' ? 'info' : 'error', event: 'kamino_monitoring_cycle', reason, status: next.overall, observedAt: next.observedAt })}\n`);
});

const dashboard = createDashboardServer({ getStatus: () => ({ ...status, metrics: { ...metrics.snapshot(), continuity: status.metrics?.continuity || [] } }) });
dashboard.listen(config.port, config.host, () => {
  process.stdout.write(`${JSON.stringify({ level: 'info', event: 'kamino_dashboard_listening', host: config.host, port: config.port, pollIntervalMs: config.pollIntervalMs })}\n`);
});

let listener = createRpcChangeListener({
  url: config.solamiConfigured ? '' : config.rpcWebsocketUrl,
  targets: config.targets,
  onChange: () => runner.trigger('rpc-change'),
  onState: (connected) => { liveConnected = connected; }
});

let liveTask = null;
if (config.solamiConfigured) {
  const transport = createSolanaTransport({ cluster: 'mainnet-beta' });
  const liveRunner = createKaminoLiveRunner({
    config, targets: config.targets, cursors, transport,
    ingest: batch => postBackend(config, `/internal/indexers/${config.indexerId}/batches`, 'POST', batch)
  });
  liveTask = liveRunner.run().then(result => {
    liveConnected = result.continuity === 'verified';
    status = { ...status, live: { configured: true, connected: liveConnected, ...liveRunner.status() } };
  }).catch(error => {
    liveConnected = false;
    status = { ...status, overall: status.overall === 'healthy' ? 'degraded' : status.overall, live: { configured: true, connected: false, ...liveRunner.status(), error: error.message } };
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'kamino_live_stream_failed', error: error.message })}\n`);
  });
}

await runner.trigger('startup');
const timer = setInterval(() => runner.trigger('canary'), config.pollIntervalMs);

function shutdown(signal) {
  clearInterval(timer);
  listener.close();
  dashboard.close(() => {
    process.stdout.write(`${JSON.stringify({ level: 'info', event: 'kamino_worker_shutdown', signal })}\n`);
    process.exit(0);
  });
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
