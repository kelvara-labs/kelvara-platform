import { createDashboardServer } from './dashboard-server.js';
import {
  createRpcChangeListener,
  createRuntimeMetrics,
  createSequentialRunner,
  loadBackendCursors,
  loadWorkerConfig,
  registerWithBackend,
  runMonitoringCycle
} from './worker-core.js';

const config = loadWorkerConfig();
const metrics = createRuntimeMetrics();
let cursors = new Map();
const reconciliationState = { targets: [] };
let liveConnected = false;
let status = {
  indexerId: config.indexerId, protocol: 'onre', network: 'mainnet-beta', version: config.version,
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
  process.stdout.write(`${JSON.stringify({ level: next.overall === 'healthy' ? 'info' : 'error', event: 'onre_monitoring_cycle', reason, status: next.overall, observedAt: next.observedAt })}\n`);
});

const dashboard = createDashboardServer({ getStatus: () => ({ ...status, metrics: { ...metrics.snapshot(), continuity: status.metrics?.continuity || [] } }) });
dashboard.listen(config.port, config.host, () => {
  process.stdout.write(`${JSON.stringify({ level: 'info', event: 'onre_dashboard_listening', host: config.host, port: config.port, pollIntervalMs: config.pollIntervalMs })}\n`);
});

const listener = createRpcChangeListener({
  url: config.rpcWebsocketUrl,
  targets: config.targets,
  onChange: () => runner.trigger('rpc-change'),
  onState: (connected) => { liveConnected = connected; }
});

await runner.trigger('startup');
const timer = setInterval(() => runner.trigger('canary'), config.pollIntervalMs);

function shutdown(signal) {
  clearInterval(timer);
  listener.close();
  dashboard.close(() => {
    process.stdout.write(`${JSON.stringify({ level: 'info', event: 'onre_worker_shutdown', signal })}\n`);
    process.exit(0);
  });
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
