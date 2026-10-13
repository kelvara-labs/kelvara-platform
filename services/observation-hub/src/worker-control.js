import { validateTarget } from '@kelvara/contracts/target-contract';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const NETWORKS = new Set(['mainnet-beta', 'devnet', 'testnet']);
const CAPABILITIES = new Set(['accounts', 'transactions', 'vault-state', 'authorities']);

function nonEmpty(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
}

export function validateWorkerRegistration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('registration must be an object');
  nonEmpty(value.indexerId, 'indexerId');
  nonEmpty(value.protocol, 'protocol');
  nonEmpty(value.network, 'network');
  nonEmpty(value.version, 'version');
  if (!ID.test(value.indexerId)) throw new TypeError('indexerId must use lowercase kebab-case');
  if (!ID.test(value.protocol)) throw new TypeError('protocol must use lowercase kebab-case');
  if (!NETWORKS.has(value.network)) throw new RangeError('network is unsupported');
  if (!SEMVER.test(value.version)) throw new TypeError('version must be semantic version text');
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    throw new TypeError('capabilities must be a non-empty array');
  }
  if (new Set(value.capabilities).size !== value.capabilities.length) throw new TypeError('capabilities must be unique');
  for (const capability of value.capabilities) {
    if (!CAPABILITIES.has(capability)) throw new RangeError(`unsupported capability: ${capability}`);
  }
  return value;
}

function isoTimestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be an ISO-8601 timestamp`);
  return value;
}

export function registerWorker(db, registration, now = new Date()) {
  validateWorkerRegistration(registration);
  const registeredAt = now.toISOString();
  const existing = db.prepare('SELECT protocol, network FROM indexers WHERE id = ?').get(registration.indexerId);
  if (existing && (existing.protocol !== registration.protocol || existing.network !== registration.network)) {
    throw new Error('registered worker identity does not match protocol or network');
  }
  db.prepare(`
    INSERT INTO indexers (
      id, protocol, network, version, status, capabilities_json, registered_at, last_heartbeat_at
    ) VALUES (?, ?, ?, ?, 'registered', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      version = excluded.version,
      status = 'registered',
      capabilities_json = excluded.capabilities_json,
      last_heartbeat_at = excluded.last_heartbeat_at,
      last_error_code = NULL,
      last_error_message = NULL
  `).run(
    registration.indexerId,
    registration.protocol,
    registration.network,
    registration.version,
    JSON.stringify(registration.capabilities),
    registeredAt,
    registeredAt
  );
  return { created: !existing, indexerId: registration.indexerId, registeredAt };
}

export function recordHeartbeat(db, heartbeat, now = new Date()) {
  if (!heartbeat || typeof heartbeat !== 'object' || Array.isArray(heartbeat)) throw new TypeError('heartbeat must be an object');
  nonEmpty(heartbeat.indexerId, 'indexerId');
  if (!['healthy', 'degraded', 'error'].includes(heartbeat.status)) throw new RangeError('heartbeat status is unsupported');
  const lastSuccessAt = heartbeat.lastSuccessAt === null ? null : isoTimestamp(heartbeat.lastSuccessAt, 'lastSuccessAt');
  if (heartbeat.error !== null && (!heartbeat.error || typeof heartbeat.error !== 'object' || Array.isArray(heartbeat.error))) {
    throw new TypeError('error must be null or an object');
  }
  let errorCode = null;
  let errorMessage = null;
  if (heartbeat.error) {
    nonEmpty(heartbeat.error.code, 'error.code');
    nonEmpty(heartbeat.error.message, 'error.message');
    errorCode = heartbeat.error.code;
    errorMessage = heartbeat.error.message;
  }
  const heartbeatAt = now.toISOString();
  const result = db.prepare(`
    UPDATE indexers SET
      status = ?, last_heartbeat_at = ?, last_success_at = ?,
      last_error_code = ?, last_error_message = ?
    WHERE id = ?
  `).run(heartbeat.status, heartbeatAt, lastSuccessAt, errorCode, errorMessage, heartbeat.indexerId);
  if (result.changes !== 1) throw new Error('worker is not registered');
  return { indexerId: heartbeat.indexerId, heartbeatAt, status: heartbeat.status };
}

export function listCursors(db, indexerId, stream) {
  if (!['account_snapshot', 'transactions', 'governance_control', 'governance_action'].includes(stream)) throw new RangeError('cursor stream is unsupported');
  const rows = db.prepare(`
    SELECT target_id, stream, slot, signature, updated_at
    FROM indexer_cursors
    WHERE indexer_id = ? AND stream = ?
    ORDER BY target_id
  `).all(indexerId, stream);
  return { indexerId, stream, cursors: rows.map((row) => ({
    indexerId,
    targetId: row.target_id,
    stream: row.stream,
    cursor: { signature: row.signature, slot: row.slot },
    updatedAt: row.updated_at
  })) };
}

export function upsertTargets(db, payload, now = new Date()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('target payload must be an object');
  nonEmpty(payload.indexerId, 'indexerId');
  if (!Array.isArray(payload.targets) || payload.targets.length === 0) throw new TypeError('targets must be a non-empty array');
  const worker = db.prepare('SELECT protocol, network FROM indexers WHERE id = ?').get(payload.indexerId);
  if (!worker) throw new Error('worker is not registered');
  const ids = new Set();
  for (const target of payload.targets) {
    validateTarget(target);
    if (target.indexerId !== payload.indexerId) throw new RangeError('target indexerId does not match request indexer');
    if (target.protocol !== worker.protocol || target.network !== worker.network) {
      throw new RangeError('target protocol or network does not match registered worker');
    }
    if (ids.has(target.id)) throw new TypeError('target IDs must be unique');
    ids.add(target.id);
  }
  const updatedAt = now.toISOString();
  const statement = db.prepare(`
    INSERT INTO indexer_targets (
      id, indexer_id, protocol, network, kind, address, display_name, curator, enabled, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      protocol = excluded.protocol,
      network = excluded.network,
      kind = excluded.kind,
      address = excluded.address,
      display_name = excluded.display_name,
      curator = excluded.curator,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const target of payload.targets) {
      statement.run(
        target.id, target.indexerId, target.protocol, target.network, target.kind,
        target.address, target.displayName, target.curator, target.enabled ? 1 : 0, updatedAt
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { indexerId: payload.indexerId, targetCount: payload.targets.length, updatedAt };
}
