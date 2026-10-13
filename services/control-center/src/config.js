const DEFAULT_KAMINO_METRICS_BASE_URL = 'https://api.kamino.finance';

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function scopedToken(environment, name) {
  const value = required(environment, name);
  if (value.length < 32) throw new Error(`${name} must be at least 32 characters`);
  return value;
}

export function loadControlPlaneConfig(environment = process.env) {
  const port = Number(required(environment, 'PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');

  const credentials = [
    { token: scopedToken(environment, 'CONTROL_PLANE_READ_TOKEN'), role: 'reader', actorId: 'program-backend', capabilities: ['governance-bindings:read', 'eligible-position-enrollments:reconcile'] },
    { token: scopedToken(environment, 'CONTROL_PLANE_ADMIN_TOKEN'), role: 'administrator', actorId: 'administrator' },
    { token: scopedToken(environment, 'CONTROL_PLANE_OPERATOR_TOKEN'), role: 'operator', actorId: 'operator' },
    { token: scopedToken(environment, 'CONTROL_PLANE_AUDITOR_TOKEN'), role: 'auditor', actorId: 'auditor' }
  ];
  if (environment.OPERATIONS_BRIDGE_TOKEN !== undefined) {
    const bridge = scopedToken(environment, 'OPERATIONS_BRIDGE_TOKEN');
    if (bridge === environment.CONTROL_PLANE_ADMIN_TOKEN) throw new Error('OPERATIONS_BRIDGE_TOKEN must differ from admin token');
    credentials.push({ token: bridge, role: 'bridge', actorId: 'operations-bridge' });
  }
  if (environment.CONTROL_PLANE_WALLET_SAFEGUARD_TOKEN !== undefined) credentials.push({ token: scopedToken(environment, 'CONTROL_PLANE_WALLET_SAFEGUARD_TOKEN'), role: 'wallet-safeguard', actorId: 'observation-hub' });
  if (new Set(credentials.map(item => item.token)).size !== credentials.length) throw new Error('CONTROL_PLANE scoped tokens must differ');
  const observationHubUrl = required(environment, 'OBSERVATION_HUB_URL').replace(/\/$/, '');
  let parsedHubUrl;
  try { parsedHubUrl = new URL(observationHubUrl); } catch { throw new Error('OBSERVATION_HUB_URL must be a valid URL'); }
  if (!['http:', 'https:'].includes(parsedHubUrl.protocol)) throw new Error('OBSERVATION_HUB_URL must use http or https');
  const observationHubToken = scopedToken(environment, 'OBSERVATION_HUB_TOKEN');
  const permitVaultUrl = required(environment, 'PERMIT_VAULT_URL').replace(/\/$/, '');
  let parsedPermitVaultUrl; try { parsedPermitVaultUrl = new URL(permitVaultUrl); } catch { throw new Error('PERMIT_VAULT_URL must be a valid URL'); }
  if (!['http:', 'https:'].includes(parsedPermitVaultUrl.protocol)) throw new Error('PERMIT_VAULT_URL must use http or https');
  const permitVaultReadToken = scopedToken(environment, 'PERMIT_VAULT_READ_TOKEN');
  if (credentials.some(item => item.token === permitVaultReadToken) || permitVaultReadToken === observationHubToken) throw new Error('PERMIT_VAULT_READ_TOKEN must differ from all configured credentials');
  let kaminoMetricsBaseUrl = DEFAULT_KAMINO_METRICS_BASE_URL;
  if (environment.KAMINO_METRICS_BASE_URL !== undefined) {
    const value = required(environment, 'KAMINO_METRICS_BASE_URL').replace(/\/+$/, '');
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error('KAMINO_METRICS_BASE_URL must be a valid URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('KAMINO_METRICS_BASE_URL must use http or https');
    kaminoMetricsBaseUrl = parsed.toString().replace(/\/+$/, '');
  }
  const outboxIntervalMs = Number(environment.OUTBOX_INTERVAL_MS || 5000);
  if (!Number.isInteger(outboxIntervalMs) || outboxIntervalMs < 100 || outboxIntervalMs > 3600000) throw new Error('OUTBOX_INTERVAL_MS must be from 100 to 3600000');
  const outboxMaxAttempts = Number(environment.OUTBOX_MAX_ATTEMPTS || 3);
  if (!Number.isInteger(outboxMaxAttempts) || outboxMaxAttempts < 1 || outboxMaxAttempts > 10) throw new Error('OUTBOX_MAX_ATTEMPTS must be from 1 to 10');

  let governanceVerifiedMappings;
  try { governanceVerifiedMappings=JSON.parse(environment.GOVERNANCE_VERIFIED_MAPPINGS_JSON??'[]'); } catch { throw new Error('GOVERNANCE_VERIFIED_MAPPINGS_JSON must be valid JSON'); }
  if(!Array.isArray(governanceVerifiedMappings))throw new Error('GOVERNANCE_VERIFIED_MAPPINGS_JSON must be an array');
  return {
    host: required(environment, 'HOST'),
    governanceVerifiedMappings,
    port,
    databasePath: required(environment, 'DATABASE_PATH'),
    credentials,
    observationHubUrl,
    observationHubToken,
    permitVaultUrl,
    permitVaultReadToken,
    kaminoMetricsBaseUrl,
    outboxIntervalMs,
    outboxMaxAttempts
  };
}
