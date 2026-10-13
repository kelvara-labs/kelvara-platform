import { createHash, randomUUID } from 'node:crypto';
import { KAMINO_KVAULT_PROFILE, validateKaminoKvaultProfile } from './kamino-profile.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseCanonicalTargetId } from './target-identity.js';
import { validateProposal } from '../../contracts/src/operations-bridge.js';
import { validateWalletSafeguardPolicy } from '../../contracts/src/wallet-safeguard-policy.js';

const SCHEMA_VERSION = 15;
const CANONICAL_TARGET_ID = /^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*):([a-z][a-z0-9-]*):([a-z][a-z0-9-]*):([1-9A-HJ-NP-Za-km-z]{32,44})$/;
const LIFECYCLE_STATES = ['setup_incomplete','permit_validated','permit_stored','armed','revoked','expired','inactive_position_absent'];
const HEX64_SQL = "GLOB '[0-9a-f]*' AND length(?)=64";
let activeAdapterRegistry = null;
const LEGACY_DISCOVERY_ADAPTER_ID = 'legacy-disabled';
const ADAPTER_ID = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

function discoveryMetadata(id, version, { allowMissing = true } = {}) {
  if (id === undefined && version === undefined && allowMissing) return { id: null, version: null };
  if (typeof id !== 'string' || !ADAPTER_ID.test(id) || id.length > 64) throw new TypeError('discoveryAdapterId must be a valid adapter ID');
  if (!Number.isInteger(version) || version < 1 || version > 2147483647) throw new TypeError('discoveryAdapterVersion must be a positive integer');
  return { id, version };
}

function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required`);
  return value.trim();
}

function readerAddress(value) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('target address is invalid');
  return value;
}

function jsonSafe(value, path = 'parameters') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be JSON-safe`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonSafe(item, `${path}[${index}]`));
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, jsonSafe(value[key], `${path}.${key}`)]));
  }
  throw new TypeError(`${path} must be JSON-safe`);
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(jsonSafe(value, 'value'))).digest('hex');
}

const UINT256_MAX = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
const PERMIT_FIELDS = new Set(['enrollmentId','walletId','targetId','actionType','policyVersion','policyRevision','policyHash','transactionFingerprint','network','mint','destination','signedCapRaw','issuedAt','expiresAt','vaultAttestationId','vaultAttestationSource','vaultAttestationVersion']);
function uint256(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || value.length > 78 || (value.length === 78 && value > UINT256_MAX)) throw new TypeError('signedCapRaw is invalid');
  return value;
}
function canonicalUtc(value, name) {
  if (typeof value !== 'string' || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) === false) throw new TypeError(`${name} is invalid`);
  const date = new Date(value); if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new TypeError(`${name} is invalid`);
  return value;
}
function permitDigest(permit) {
  const normalized = Object.fromEntries([...PERMIT_FIELDS].sort().map(key => [key, permit[key]]));
  return hash(normalized);
}

function secretReference(value) {
  const reference = required(value, 'secretRef');
  if (!/^sec_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference)) {
    throw new TypeError('secretRef must be a provider-issued opaque ID');
  }
  return reference;
}

function lifecycleAudit(db, { enrollmentId, ownerId, fromState = null, toState, payloadDigest = null, reason }) {
  db.prepare('INSERT INTO wallet_protection_lifecycle_audit (audit_id,enrollment_id,owner_id,from_state,to_state,payload_digest,reason,occurred_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(randomUUID(), enrollmentId, ownerId, fromState, toState, payloadDigest, required(reason, 'reason'), new Date().toISOString());
}

function audit(db, { actorId, action, entityType, entityId, reason, before = null, after = null }) {
  required(actorId, 'actorId');
  required(reason, 'reason');
  db.prepare(`INSERT INTO audit_events
    (id,actor_id,action,entity_type,entity_id,reason,before_hash,after_hash,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(), actorId, action, entityType, entityId, reason,
      before === null ? null : hash(before), after === null ? null : hash(after), new Date().toISOString());
}

function createSchema(db) {
  const schemaObjects = db.prepare(`SELECT type,name FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
  if (schemaObjects.length) throw new Error('unrecognized_version_zero_schema');
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE protocols (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, chain TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','retired')),
      discovery_adapter_id TEXT CHECK(discovery_adapter_id IS NULL OR discovery_adapter_id GLOB '[a-z]*'),
      discovery_adapter_version INTEGER CHECK(discovery_adapter_version IS NULL OR discovery_adapter_version > 0),
      CHECK((discovery_adapter_id IS NULL) = (discovery_adapter_version IS NULL))
    );
    CREATE TABLE targets (
      id TEXT PRIMARY KEY, protocol_id TEXT NOT NULL REFERENCES protocols(id), kind TEXT NOT NULL,
      address TEXT NOT NULL, name TEXT NOT NULL, secret_ref TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','retired')),
      UNIQUE(protocol_id,kind,address)
    );
    CREATE TABLE target_registry (
      target_id TEXT PRIMARY KEY, chain TEXT NOT NULL, network TEXT NOT NULL, protocol_id TEXT NOT NULL,
      resource_type TEXT NOT NULL, address TEXT NOT NULL, display_name TEXT NOT NULL,
      strategy TEXT NOT NULL DEFAULT 'Yield', protocol_url TEXT NOT NULL DEFAULT '', protocol_icon_key TEXT NOT NULL DEFAULT 'kamino', token_icon_key TEXT NOT NULL DEFAULT '', token_symbol TEXT NOT NULL DEFAULT '', catalog_tvl_usd TEXT NOT NULL DEFAULT '0',
      UNIQUE(chain,network,protocol_id,resource_type,address)
    );
    CREATE TABLE target_capabilities (
      target_id TEXT PRIMARY KEY REFERENCES targets(id), token_mint TEXT NOT NULL, shares_mint TEXT NOT NULL,
      discovery_adapter_id TEXT NOT NULL, discovery_adapter_version INTEGER NOT NULL CHECK(discovery_adapter_version > 0),
      metrics_adapter_id TEXT NOT NULL, metrics_adapter_version INTEGER NOT NULL CHECK(metrics_adapter_version > 0)
    );
    CREATE TABLE onboarding_evidence (
      target_id TEXT PRIMARY KEY REFERENCES targets(id), cursor TEXT, first_observation_at TEXT, tvl_json TEXT,
      required_receipts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(required_receipts_json))
    );
    CREATE TABLE target_aliases (alias TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES target_registry(target_id));
    CREATE INDEX target_aliases_target_idx ON target_aliases(target_id);
    CREATE TABLE rule_definitions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, evaluator_type TEXT NOT NULL
    );
    CREATE TABLE rule_versions (
      rule_id TEXT NOT NULL REFERENCES rule_definitions(id), version INTEGER NOT NULL CHECK(version > 0),
      evaluator_version TEXT NOT NULL, parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json)),
      evidence_schema TEXT NOT NULL, content_hash TEXT NOT NULL,
      PRIMARY KEY(rule_id,version)
    );
    CREATE TABLE rule_bindings (
      id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, rule_version INTEGER NOT NULL,
      target_id TEXT NOT NULL REFERENCES targets(id),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','retired')),
      FOREIGN KEY(rule_id,rule_version) REFERENCES rule_versions(rule_id,version),
      UNIQUE(rule_id,rule_version,target_id)
    );
    CREATE TABLE wallets (
      wallet_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','retired'))
    );
    CREATE TABLE wallet_enrollments (
      wallet_id TEXT NOT NULL REFERENCES wallets(wallet_id), position_id TEXT NOT NULL, target_id TEXT NOT NULL REFERENCES targets(id),
      network TEXT NOT NULL, source TEXT NOT NULL CHECK(source='eligible-position'), subject_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','suspended','retired')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(wallet_id,position_id), UNIQUE(wallet_id,target_id)
    );
    CREATE TABLE configuration_revisions (
      revision INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
      content_hash TEXT NOT NULL, activated_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL,
      action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, reason TEXT NOT NULL,
      before_hash TEXT, after_hash TEXT, occurred_at TEXT NOT NULL
    );
    CREATE TABLE admin_requests (
      idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
      status_code INTEGER NOT NULL, response_json TEXT NOT NULL CHECK(json_valid(response_json)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE onboarding_proposals (
      proposal_id TEXT PRIMARY KEY, target_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      payload_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','validated','provisioning','activated','paused','retired')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
      CREATE TABLE assignment_outbox (
      event_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES onboarding_proposals(proposal_id),
      event_type TEXT NOT NULL CHECK(event_type IN ('assignment.activated','assignment.paused','assignment.retired')),
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), payload_hash TEXT NOT NULL,
      acknowledged_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE preflight_receipts (
      receipt_id TEXT PRIMARY KEY, target_id TEXT NOT NULL, identity TEXT NOT NULL,
      facts_json TEXT NOT NULL CHECK(json_valid(facts_json)), facts_digest TEXT NOT NULL CHECK(length(facts_digest)=64),
      issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_proposal_id TEXT UNIQUE,
      CHECK(expires_at > issued_at)
    );
    CREATE TRIGGER preflight_receipts_no_mutation BEFORE UPDATE OF receipt_id,target_id,identity,facts_json,facts_digest,issued_at,expires_at ON preflight_receipts BEGIN
      SELECT RAISE(ABORT,'immutable_preflight_receipt'); END;
    CREATE TRIGGER rule_versions_no_update BEFORE UPDATE ON rule_versions BEGIN
      SELECT RAISE(ABORT,'immutable_rule_version'); END;
    CREATE TRIGGER rule_versions_no_delete BEFORE DELETE ON rule_versions BEGIN
      SELECT RAISE(ABORT,'immutable_rule_version'); END;
    CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN
      SELECT RAISE(ABORT,'append_only_audit'); END;
    CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN
      SELECT RAISE(ABORT,'append_only_audit'); END;
    CREATE TABLE agent_access_requests (
      id TEXT PRIMARY KEY, scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)), reason TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','delivered','exchanged','revoked')),
      retrieval_digest TEXT NOT NULL CHECK(length(retrieval_digest)=64), exchange_digest TEXT CHECK(exchange_digest IS NULL OR length(exchange_digest)=64), exchange_expires_at INTEGER, delivered_at INTEGER,
      CHECK(duration_minutes BETWEEN 1 AND 60), CHECK(expires_at > created_at), CHECK(exchange_expires_at IS NULL OR exchange_expires_at <= expires_at)
    );
    CREATE TABLE agent_access_sessions (
      token_digest TEXT PRIMARY KEY CHECK(length(token_digest)=64), request_id TEXT NOT NULL REFERENCES agent_access_requests(id),
      scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)), expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)), CHECK(expires_at > 0)
    );
    CREATE TABLE operations_proposals (
      proposal_id TEXT PRIMARY KEY, requester TEXT NOT NULL, destination_service TEXT NOT NULL,
      operation TEXT NOT NULL, operation_version INTEGER NOT NULL CHECK(operation_version > 0),
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), resource_ids_json TEXT NOT NULL CHECK(json_valid(resource_ids_json)),
      idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      risk TEXT NOT NULL CHECK(risk IN ('read','mutate','critical')), approval_requirements_json TEXT NOT NULL CHECK(json_valid(approval_requirements_json)),
      payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64), envelope_digest TEXT NOT NULL CHECK(length(envelope_digest)=64),
      status TEXT NOT NULL CHECK(status IN ('pending_approval','approved','rejected','expired','revoked')), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      UNIQUE(requester,idempotency_key), CHECK(expires_at > created_at)
    );
    CREATE TABLE operations_approvals (
      approval_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES operations_proposals(proposal_id), proposal_revision INTEGER NOT NULL,
      envelope_digest TEXT NOT NULL CHECK(length(envelope_digest)=64), approver_id TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
      approval_kind TEXT NOT NULL CHECK(approval_kind IN ('proposal','critical')), decided_at TEXT NOT NULL, reason TEXT NOT NULL,
      UNIQUE(proposal_id,proposal_revision,approval_kind)
    );
    CREATE TRIGGER operations_proposals_immutable BEFORE UPDATE OF proposal_id,requester,destination_service,operation,operation_version,payload_json,resource_ids_json,idempotency_key,created_at,expires_at,risk,approval_requirements_json,payload_digest,envelope_digest,revision ON operations_proposals BEGIN SELECT RAISE(ABORT,'immutable_operations_proposal'); END;
    CREATE TRIGGER operations_approvals_no_update BEFORE UPDATE ON operations_approvals BEGIN SELECT RAISE(ABORT,'append_only_operations_approval'); END;
    CREATE TRIGGER operations_approvals_no_delete BEFORE DELETE ON operations_approvals BEGIN SELECT RAISE(ABORT,'append_only_operations_approval'); END;
    CREATE INDEX operations_proposals_status_idx ON operations_proposals(status,created_at);
    CREATE INDEX operations_approvals_proposal_idx ON operations_approvals(proposal_id,proposal_revision);
    CREATE TABLE wallet_protection_policies (
      policy_hash TEXT PRIMARY KEY CHECK(length(policy_hash)=64), action_type TEXT NOT NULL,
      policy_version INTEGER NOT NULL CHECK(policy_version BETWEEN 1 AND 2147483647),
      combine_mode TEXT NOT NULL CHECK(combine_mode='OR'), policy_json TEXT NOT NULL CHECK(json_valid(policy_json))
    );
    CREATE TABLE protection_enrollments (
      enrollment_id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL, policy_hash TEXT NOT NULL REFERENCES wallet_protection_policies(policy_hash),
      state TEXT NOT NULL CHECK(state IN ('setup_incomplete','permit_validated','permit_stored','armed','revoked','expired','inactive_position_absent')),
      owner_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id,wallet_id)
    );
    CREATE TABLE permit_attestations (
      attestation_id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES protection_enrollments(enrollment_id), wallet_id TEXT NOT NULL,
      target_id TEXT NOT NULL, action_type TEXT NOT NULL, policy_version INTEGER NOT NULL CHECK(policy_version BETWEEN 1 AND 2147483647), policy_revision INTEGER NOT NULL CHECK(policy_revision BETWEEN 1 AND 2147483647), policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64), transaction_fingerprint TEXT NOT NULL CHECK(length(transaction_fingerprint)=64 AND transaction_fingerprint NOT GLOB '*[^0-9a-f]*'), network TEXT NOT NULL CHECK(length(trim(network))>0), mint TEXT NOT NULL CHECK(length(trim(mint))>0), destination TEXT NOT NULL CHECK(length(trim(destination))>0), signed_cap_raw TEXT NOT NULL CHECK(signed_cap_raw NOT GLOB '*[^0-9]*' AND signed_cap_raw NOT LIKE '0%' AND length(signed_cap_raw) BETWEEN 1 AND 78), issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, vault_attestation_id TEXT NOT NULL CHECK(length(trim(vault_attestation_id))>0), vault_attestation_source TEXT NOT NULL CHECK(length(trim(vault_attestation_source))>0), vault_attestation_version INTEGER NOT NULL CHECK(vault_attestation_version BETWEEN 1 AND 2147483647), payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'), CHECK(expires_at > issued_at), UNIQUE(enrollment_id,payload_digest)
 );
 CREATE TRIGGER permit_attestations_no_update BEFORE UPDATE ON permit_attestations BEGIN SELECT RAISE(ABORT,'append_only_permit_attestation'); END;
 CREATE TRIGGER permit_attestations_no_delete BEFORE DELETE ON permit_attestations BEGIN SELECT RAISE(ABORT,'append_only_permit_attestation'); END;
 CREATE TABLE wallet_protection_lifecycle_audit (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, audit_id TEXT NOT NULL UNIQUE, enrollment_id TEXT NOT NULL REFERENCES protection_enrollments(enrollment_id), owner_id TEXT NOT NULL CHECK(length(trim(owner_id))>0), from_state TEXT CHECK(from_state IS NULL OR from_state IN ('setup_incomplete','permit_validated','permit_stored','armed','revoked','expired','inactive_position_absent')), to_state TEXT NOT NULL CHECK(to_state IN ('setup_incomplete','permit_validated','permit_stored','armed','revoked','expired','inactive_position_absent')), payload_digest TEXT CHECK(payload_digest IS NULL OR (length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*')), reason TEXT NOT NULL CHECK(length(trim(reason))>0), occurred_at TEXT NOT NULL
 );
    CREATE TRIGGER protection_enrollments_no_update BEFORE UPDATE OF enrollment_id,wallet_id,policy_hash,owner_id,created_at ON protection_enrollments BEGIN SELECT RAISE(ABORT,'immutable_protection_binding'); END;
    CREATE TRIGGER IF NOT EXISTS wallet_protection_lifecycle_audit_no_update BEFORE UPDATE ON wallet_protection_lifecycle_audit BEGIN SELECT RAISE(ABORT,'append_only_wallet_protection_audit'); END;
    CREATE TRIGGER IF NOT EXISTS wallet_protection_lifecycle_audit_no_delete BEFORE DELETE ON wallet_protection_lifecycle_audit BEGIN SELECT RAISE(ABORT,'append_only_wallet_protection_audit'); END;
    CREATE INDEX IF NOT EXISTS permit_attestations_enrollment_idx ON permit_attestations(enrollment_id,issued_at);
    PRAGMA user_version=14;
    COMMIT;`);
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

const IMMUTABLE_TRIGGER_SQL = {
  operations_approvals_no_update: "create trigger operations_approvals_no_update before update on operations_approvals begin select raise(abort,'append_only_operations_approval'); end",
  operations_approvals_no_delete: "create trigger operations_approvals_no_delete before delete on operations_approvals begin select raise(abort,'append_only_operations_approval'); end",
  preflight_receipts_no_mutation: "create trigger preflight_receipts_no_mutation before update of receipt_id,target_id,identity,facts_json,facts_digest,issued_at,expires_at on preflight_receipts begin select raise(abort,'immutable_preflight_receipt'); end",
  rule_versions_no_update: "create trigger rule_versions_no_update before update on rule_versions begin select raise(abort,'immutable_rule_version'); end",
  rule_versions_no_delete: "create trigger rule_versions_no_delete before delete on rule_versions begin select raise(abort,'immutable_rule_version'); end",
  audit_events_no_update: "create trigger audit_events_no_update before update on audit_events begin select raise(abort,'append_only_audit'); end",
  audit_events_no_delete: "create trigger audit_events_no_delete before delete on audit_events begin select raise(abort,'append_only_audit'); end",
  operations_proposals_immutable: "create trigger operations_proposals_immutable before update of proposal_id,requester,destination_service,operation,operation_version,payload_json,resource_ids_json,idempotency_key,created_at,expires_at,risk,approval_requirements_json,payload_digest,envelope_digest,revision on operations_proposals begin select raise(abort,'immutable_operations_proposal'); end",
  protection_enrollments_no_update: "create trigger protection_enrollments_no_update before update of enrollment_id,wallet_id,policy_hash,owner_id,created_at on protection_enrollments begin select raise(abort,'immutable_protection_binding'); end",
  wallet_protection_lifecycle_audit_no_update: "create trigger wallet_protection_lifecycle_audit_no_update before update on wallet_protection_lifecycle_audit begin select raise(abort,'append_only_wallet_protection_audit'); end",
  wallet_protection_lifecycle_audit_no_delete: "create trigger wallet_protection_lifecycle_audit_no_delete before delete on wallet_protection_lifecycle_audit begin select raise(abort,'append_only_wallet_protection_audit'); end",
  permit_attestations_no_update: "create trigger permit_attestations_no_update before update on permit_attestations begin select raise(abort,'append_only_permit_attestation'); end",
  permit_attestations_no_delete: "create trigger permit_attestations_no_delete before delete on permit_attestations begin select raise(abort,'append_only_permit_attestation'); end"
};

function verifyForeignKeys(db, includeOperations = true, skipTables = []) {
  const expected = {
    targets: [['protocols', 'protocol_id', 'id', 'NO ACTION', 'NO ACTION']],
    target_capabilities: [['targets', 'target_id', 'id', 'NO ACTION', 'NO ACTION']],
    onboarding_evidence: [['targets', 'target_id', 'id', 'NO ACTION', 'NO ACTION']],
    target_aliases: [['target_registry', 'target_id', 'target_id', 'NO ACTION', 'NO ACTION']],
    rule_versions: [['rule_definitions', 'rule_id', 'id', 'NO ACTION', 'NO ACTION']],
    rule_bindings: [['rule_versions', 'rule_id', 'rule_id', 'NO ACTION', 'NO ACTION'], ['rule_versions', 'rule_version', 'version', 'NO ACTION', 'NO ACTION'], ['targets', 'target_id', 'id', 'NO ACTION', 'NO ACTION']],
    wallet_enrollments: [['wallets', 'wallet_id', 'wallet_id', 'NO ACTION', 'NO ACTION'], ['targets', 'target_id', 'id', 'NO ACTION', 'NO ACTION']],
    protection_enrollments: [['wallet_protection_policies', 'policy_hash', 'policy_hash', 'NO ACTION', 'NO ACTION']],
    permit_attestations: [['protection_enrollments', 'enrollment_id', 'enrollment_id', 'NO ACTION', 'NO ACTION']],
    wallet_protection_lifecycle_audit: [['protection_enrollments', 'enrollment_id', 'enrollment_id', 'NO ACTION', 'NO ACTION']],
    agent_access_sessions: [['agent_access_requests', 'request_id', 'id', 'NO ACTION', 'NO ACTION']],
    ...(includeOperations ? { operations_approvals: [['operations_proposals', 'proposal_id', 'proposal_id', 'NO ACTION', 'NO ACTION']] } : {})
  };
  for (const [table, wanted] of Object.entries(expected)) {
    if (skipTables.includes(table)) continue;
    const actual = db.prepare(`PRAGMA foreign_key_list(${table})`).all().map(row => [row.table, row.from, row.to, row.on_update, row.on_delete]).sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted.sort())) throw new Error(`invalid_schema_foreign_keys:${table}`);
  }
}

function verifySchemaShape(db, includeAdmin = true, legacyProtocol = false, includeOperations = true, skipTables = []) {
  const expectedTables = new Set(Object.keys(EXPECTED_COLUMNS).filter(name =>
    !skipTables.includes(name) && (includeAdmin || name !== 'admin_requests') && (includeOperations || !name.startsWith('operations_'))));
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
  const actualTables = new Set(objects.filter(row => row.type === 'table').map(row => row.name));
  const allowedTriggers = new Set(Object.keys(IMMUTABLE_TRIGGER_SQL));
  const unknown = objects.filter(row => row.type !== 'index' && !(row.type === 'table' && !includeOperations && row.name.startsWith('operations_')) && !expectedTables.has(row.name) && !(row.type === 'trigger' && allowedTriggers.has(row.name)));
  if (unknown.length) throw new Error(`invalid_schema_unknown_object:${unknown[0].name}`);
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    if (!expectedTables.has(table)) continue;
    if (!actualTables.has(table)) throw new Error(`invalid_schema_missing_table:${table}`);
    const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(row => [row.name, row.type, row.notnull, row.dflt_value, row.pk]);
    const wanted = legacyProtocol && table === 'protocols' ? expected.slice(0, 4) : expected;
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`invalid_schema_columns:${table}`);
  }
  verifyForeignKeys(db, includeOperations, skipTables);
  for (const [name, sql] of Object.entries(IMMUTABLE_TRIGGER_SQL)) {
    if (!includeOperations && name.startsWith('operations_')) continue;
    const actual = objects.find(row => row.type === 'trigger' && row.name === name);
    if (!actual || normalizeSql(actual.sql) !== sql) throw new Error(`invalid_schema_trigger:${name}`);
  }
  const revisionSql = normalizeSql(objects.find(row => row.name === 'configuration_revisions')?.sql ?? '');
  const auditSql = normalizeSql(objects.find(row => row.name === 'audit_events')?.sql ?? '');
  if (!revisionSql.includes('revision integer primary key autoincrement') || !auditSql.includes('sequence integer primary key autoincrement')) throw new Error('invalid_schema_autoincrement');
  const agentRequestSql = normalizeSql(objects.find(row => row.name === 'agent_access_requests')?.sql ?? '');
  const agentSessionSql = normalizeSql(objects.find(row => row.name === 'agent_access_sessions')?.sql ?? '');
  for (const required of [
    "status text not null check(status in ('pending','approved','denied','delivered','exchanged','revoked'))",
    'retrieval_digest text not null check(length(retrieval_digest)=64)',
    'check(duration_minutes between 1 and 60)',
    'check(expires_at > created_at)'
  ]) if (!agentRequestSql.includes(required)) throw new Error(`invalid_schema_agent_access_requests:${required}`);
  for (const required of ['token_digest text primary key check(length(token_digest)=64)', 'references agent_access_requests(id)', 'revoked integer not null default 0 check(revoked in (0,1))']) if (!agentSessionSql.includes(required)) throw new Error(`invalid_schema_agent_access_sessions:${required}`);
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('invalid_schema_foreign_key_violation');
}

function migrateSchema(db, version) {
  if (version === 14) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE wallet_enrollments RENAME TO wallet_enrollments_legacy;
      CREATE TABLE wallet_enrollments (
        wallet_id TEXT NOT NULL REFERENCES wallets(wallet_id), position_id TEXT NOT NULL, target_id TEXT NOT NULL REFERENCES targets(id),
        network TEXT NOT NULL, source TEXT NOT NULL CHECK(source='eligible-position'), subject_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','suspended','retired')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(wallet_id,position_id), UNIQUE(wallet_id,target_id)
      );
      INSERT INTO wallet_enrollments(wallet_id,position_id,target_id,network,source,subject_id,status,created_at,updated_at)
        SELECT e.wallet_id,e.target_id,e.target_id,r.network,'eligible-position',r.address,e.status,datetime('now'),datetime('now')
        FROM wallet_enrollments_legacy e JOIN target_registry r ON r.target_id=e.target_id;
      DROP TABLE wallet_enrollments_legacy;
      PRAGMA user_version=15; COMMIT;`);
    return;
  }
  if (version === 13) {
    db.exec(`BEGIN IMMEDIATE;
      UPDATE target_registry SET protocol_icon_key='steakhouse'
      WHERE address='BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5';
      PRAGMA user_version=14; COMMIT;`);
    return;
  }
  if (version === 12) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE target_registry ADD COLUMN strategy TEXT NOT NULL DEFAULT 'Yield';
      ALTER TABLE target_registry ADD COLUMN protocol_url TEXT NOT NULL DEFAULT '';
      ALTER TABLE target_registry ADD COLUMN protocol_icon_key TEXT NOT NULL DEFAULT 'kamino';
      ALTER TABLE target_registry ADD COLUMN token_icon_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE target_registry ADD COLUMN token_symbol TEXT NOT NULL DEFAULT '';
      ALTER TABLE target_registry ADD COLUMN catalog_tvl_usd TEXT NOT NULL DEFAULT '0';
      UPDATE target_registry SET protocol_url='https://app.kamino.finance/explore/vaults/'||address,
        protocol_icon_key=CASE address WHEN 'BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5' THEN 'steakhouse' ELSE 'kamino' END,
        token_icon_key=CASE address WHEN 'B5pjfZAiKjyUEuqB2694NHrsjcaM67uuJaWqjzTVtzR6' THEN 'usdc' WHEN 'BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5' THEN 'usdg' ELSE '' END,
        token_symbol=CASE address WHEN 'B5pjfZAiKjyUEuqB2694NHrsjcaM67uuJaWqjzTVtzR6' THEN 'USDC' WHEN 'BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5' THEN 'USDG' ELSE '' END,
        catalog_tvl_usd=CASE address WHEN 'B5pjfZAiKjyUEuqB2694NHrsjcaM67uuJaWqjzTVtzR6' THEN '53000000' WHEN 'BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5' THEN '46000000' ELSE '0' END;
      PRAGMA user_version=14; COMMIT;`);
    return;
  }
  if (version === 11) {
    // Validate the complete published v11 contract before BEGIN. This keeps malformed
    // stamped databases byte-for-byte unchanged when migration is rejected.
    verifySchemaShape(db, true, false, true, ['target_capabilities', 'onboarding_evidence']);
    const proposalColumns = db.prepare('PRAGMA table_info(onboarding_proposals)').all().map(row => row.name);
    const requiredProposalColumns = ['proposal_id', 'target_id', 'payload_json', 'payload_hash', 'status', 'created_at', 'updated_at'];
    if (JSON.stringify(proposalColumns) !== JSON.stringify(requiredProposalColumns)) throw new Error('invalid_schema_v11_shape:onboarding_proposals');
    const outboxForeignKeys = db.prepare('PRAGMA foreign_key_list(assignment_outbox)').all();
    if (outboxForeignKeys.length !== 1 || outboxForeignKeys[0].table !== 'onboarding_proposals' || outboxForeignKeys[0].from !== 'proposal_id') throw new Error('invalid_schema_v11_shape:assignment_outbox');
    const staleV12Objects = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('target_capabilities','onboarding_evidence')").all();
    if (staleV12Objects.length) throw new Error(`invalid_schema_v11_shape:${staleV12Objects[0].name}`);
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE target_capabilities (
        target_id TEXT PRIMARY KEY REFERENCES targets(id), token_mint TEXT NOT NULL, shares_mint TEXT NOT NULL,
        discovery_adapter_id TEXT NOT NULL, discovery_adapter_version INTEGER NOT NULL CHECK(discovery_adapter_version > 0),
        metrics_adapter_id TEXT NOT NULL, metrics_adapter_version INTEGER NOT NULL CHECK(metrics_adapter_version > 0)
      );
      CREATE TABLE IF NOT EXISTS onboarding_evidence (
        target_id TEXT PRIMARY KEY REFERENCES targets(id), cursor TEXT, first_observation_at TEXT, tvl_json TEXT,
        required_receipts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(required_receipts_json))
      );
      ALTER TABLE assignment_outbox RENAME TO assignment_outbox_legacy;
      ALTER TABLE onboarding_proposals RENAME TO onboarding_proposals_legacy;
      CREATE TABLE onboarding_proposals (
        proposal_id TEXT PRIMARY KEY, target_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        payload_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','validated','provisioning','activated','paused','retired')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO onboarding_proposals SELECT * FROM onboarding_proposals_legacy;
      CREATE TABLE assignment_outbox (
        event_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES onboarding_proposals(proposal_id),
        event_type TEXT NOT NULL CHECK(event_type IN ('assignment.activated','assignment.paused','assignment.retired')),
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), payload_hash TEXT NOT NULL,
        acknowledged_at TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO assignment_outbox SELECT * FROM assignment_outbox_legacy;
      DROP TABLE assignment_outbox_legacy;
      DROP TABLE onboarding_proposals_legacy;
      PRAGMA user_version=12; COMMIT;`);
    return;
  }
  if (version === 10) {
    const protocolColumns = db.prepare('PRAGMA table_info(protocols)').all().map(row => row.name);
    if (!protocolColumns.includes('chain')) throw new Error('invalid_schema_missing_column:protocols.chain');
    const protocols = new Map(db.prepare('SELECT id,chain FROM protocols').all().map(row => [row.id, row.chain]));
    for (const target of db.prepare('SELECT id,protocol_id,kind,address FROM targets').all()) {
      if (!String(target.id).includes(':')) continue;
      const parts = String(target.id).split(':');
      if (parts.length !== 2) throw new Error('legacy_target_id');
      const prefix = parts[0].split('-');
      if (prefix.length !== 2 || prefix[0] !== target.protocol_id || protocols.get(target.protocol_id) !== 'solana') throw new Error('legacy_target_id');
      if (parts[1] !== target.address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(target.address)) throw new Error('legacy_target_id');
      parseCanonicalTargetId(`${protocols.get(target.protocol_id)}:${prefix[1]}:${target.protocol_id}:${target.kind}:${target.address}`);
    }
    db.exec(`BEGIN IMMEDIATE;
      DROP TABLE IF EXISTS onboarding_evidence;
      DROP TABLE IF EXISTS target_capabilities;
      CREATE TABLE IF NOT EXISTS target_registry (target_id TEXT PRIMARY KEY, chain TEXT NOT NULL, network TEXT NOT NULL, protocol_id TEXT NOT NULL, resource_type TEXT NOT NULL, address TEXT NOT NULL, display_name TEXT NOT NULL, UNIQUE(chain,network,protocol_id,resource_type,address));
      CREATE TABLE IF NOT EXISTS target_aliases (alias TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES target_registry(target_id));
      CREATE INDEX IF NOT EXISTS target_aliases_target_idx ON target_aliases(target_id);
      INSERT INTO target_registry (target_id,chain,network,protocol_id,resource_type,address,display_name)
        SELECT p.chain || ':' || substr(t.id, instr(t.id, '-') + 1, instr(substr(t.id, instr(t.id, '-') + 1), ':') - 1) || ':' || substr(t.id, 1, instr(t.id, '-') - 1) || ':' || t.kind || ':' || substr(t.id, instr(t.id, ':') + 1), p.chain, substr(t.id, instr(t.id, '-') + 1, instr(substr(t.id, instr(t.id, '-') + 1), ':') - 1), substr(t.id, 1, instr(t.id, '-') - 1), t.kind, substr(t.id, instr(t.id, ':') + 1), t.name
        FROM targets t JOIN protocols p ON p.id=substr(t.id, 1, instr(t.id, '-') - 1)
        WHERE t.id GLOB '*-*:*' AND NOT EXISTS (SELECT 1 FROM target_registry r WHERE r.address=substr(t.id, instr(t.id, ':') + 1) AND r.protocol_id=substr(t.id, 1, instr(t.id, '-') - 1));
      INSERT OR IGNORE INTO target_aliases (alias,target_id)
        SELECT t.id, r.target_id FROM targets t JOIN target_registry r ON r.address=substr(t.id, instr(t.id, ':') + 1) AND r.protocol_id=substr(t.id, 1, instr(t.id, '-') - 1);
      PRAGMA user_version=11; COMMIT;`); return;
  }
  if (version === 9) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE permit_attestations RENAME TO permit_attestations_legacy;
      CREATE TABLE permit_attestations (
        attestation_id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES protection_enrollments(enrollment_id), wallet_id TEXT NOT NULL,
        target_id TEXT NOT NULL, action_type TEXT NOT NULL, policy_version INTEGER NOT NULL CHECK(policy_version BETWEEN 1 AND 2147483647), policy_revision INTEGER NOT NULL CHECK(policy_revision BETWEEN 1 AND 2147483647), policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64), transaction_fingerprint TEXT NOT NULL CHECK(length(transaction_fingerprint)=64 AND transaction_fingerprint NOT GLOB '*[^0-9a-f]*'), network TEXT NOT NULL CHECK(length(trim(network))>0), mint TEXT NOT NULL CHECK(length(trim(mint))>0), destination TEXT NOT NULL CHECK(length(trim(destination))>0), signed_cap_raw TEXT NOT NULL CHECK(signed_cap_raw NOT GLOB '*[^0-9]*' AND signed_cap_raw NOT LIKE '0%' AND length(signed_cap_raw) BETWEEN 1 AND 78), issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, vault_attestation_id TEXT NOT NULL CHECK(length(trim(vault_attestation_id))>0), vault_attestation_source TEXT NOT NULL CHECK(length(trim(vault_attestation_source))>0), vault_attestation_version INTEGER NOT NULL CHECK(vault_attestation_version BETWEEN 1 AND 2147483647), payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'), CHECK(expires_at > issued_at), UNIQUE(enrollment_id,payload_digest)
      );
      INSERT INTO permit_attestations SELECT * FROM permit_attestations_legacy;
      DROP TABLE permit_attestations_legacy;
      ALTER TABLE wallet_protection_lifecycle_audit RENAME TO wallet_protection_lifecycle_audit_legacy;
      CREATE TABLE wallet_protection_lifecycle_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, audit_id TEXT NOT NULL UNIQUE, enrollment_id TEXT NOT NULL REFERENCES protection_enrollments(enrollment_id), owner_id TEXT NOT NULL CHECK(length(trim(owner_id))>0), from_state TEXT CHECK(from_state IS NULL OR from_state IN ('setup_incomplete','permit_validated','permit_stored','armed','revoked','expired','inactive_position_absent')), to_state TEXT NOT NULL CHECK(to_state IN ('setup_incomplete','permit_validated','permit_stored','armed','revoked','expired','inactive_position_absent')), payload_digest TEXT CHECK(payload_digest IS NULL OR (length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*')), reason TEXT NOT NULL CHECK(length(trim(reason))>0), occurred_at TEXT NOT NULL
      );
      INSERT INTO wallet_protection_lifecycle_audit SELECT * FROM wallet_protection_lifecycle_audit_legacy;
      DROP TABLE wallet_protection_lifecycle_audit_legacy;
      DROP INDEX IF EXISTS permit_attestations_enrollment_idx;
      CREATE INDEX permit_attestations_enrollment_idx ON permit_attestations(enrollment_id,issued_at);
      CREATE TRIGGER wallet_protection_lifecycle_audit_no_update BEFORE UPDATE ON wallet_protection_lifecycle_audit BEGIN SELECT RAISE(ABORT,'append_only_wallet_protection_audit'); END;
      CREATE TRIGGER wallet_protection_lifecycle_audit_no_delete BEFORE DELETE ON wallet_protection_lifecycle_audit BEGIN SELECT RAISE(ABORT,'append_only_wallet_protection_audit'); END;
      CREATE TRIGGER permit_attestations_no_update BEFORE UPDATE ON permit_attestations BEGIN SELECT RAISE(ABORT,'append_only_permit_attestation'); END;
      CREATE TRIGGER permit_attestations_no_delete BEFORE DELETE ON permit_attestations BEGIN SELECT RAISE(ABORT,'append_only_permit_attestation'); END;
      PRAGMA user_version=10; COMMIT;`); return;
  }
  if (version === 8) {
    const existingEnrollment = db.prepare("PRAGMA table_info(protection_enrollments)").all();
    const enrollmentColumns = existingEnrollment.map(column => [column.name, column.type, column.notnull, column.dflt_value, column.pk]);
    const canonicalV8Columns = EXPECTED_COLUMNS.protection_enrollments;
    if (existingEnrollment.some(column => column.name === 'enrollment_id')) {
      // v7→v8 already produced the enrollment-keyed shape. Do not rename or
      // re-key it again; v9 performs the constraint-hardening rebuild.
      if (JSON.stringify(enrollmentColumns) !== JSON.stringify(canonicalV8Columns)) throw new Error('invalid_schema_v8_shape');
      db.exec(`BEGIN IMMEDIATE;
        CREATE TRIGGER IF NOT EXISTS protection_enrollments_no_update BEFORE UPDATE OF enrollment_id,wallet_id,policy_hash,owner_id,created_at ON protection_enrollments BEGIN SELECT RAISE(ABORT,'immutable_protection_binding'); END;
        CREATE TRIGGER IF NOT EXISTS wallet_protection_lifecycle_audit_no_update BEFORE UPDATE ON wallet_protection_lifecycle_audit BEGIN SELECT RAISE(ABORT,'append_only_wallet_protection_audit'); END;
        CREATE TRIGGER IF NOT EXISTS wallet_protection_lifecycle_audit_no_delete BEFORE DELETE ON wallet_protection_lifecycle_audit BEGIN SELECT RAISE(ABORT,'append_only_wallet_protection_audit'); END;
        CREATE INDEX IF NOT EXISTS permit_attestations_enrollment_idx ON permit_attestations(enrollment_id,issued_at);
        PRAGMA user_version=9; COMMIT;`); return;
    }
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE protection_enrollments RENAME TO protection_enrollments_legacy;
      CREATE TABLE protection_enrollments (enrollment_id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL, policy_hash TEXT NOT NULL REFERENCES wallet_protection_policies(policy_hash), state TEXT NOT NULL CHECK(state IN ('setup_incomplete','permit_validated','permit_stored','armed','revoked','expired','inactive_position_absent')), owner_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id,wallet_id));
      INSERT INTO protection_enrollments SELECT 'enr_'||wallet_id,wallet_id,policy_hash,state,owner_id,created_at,updated_at FROM protection_enrollments_legacy;
      DROP TABLE protection_enrollments_legacy;
      CREATE TABLE IF NOT EXISTS permit_attestations (attestation_id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES protection_enrollments(enrollment_id), wallet_id TEXT NOT NULL, target_id TEXT NOT NULL, action_type TEXT NOT NULL, policy_version INTEGER NOT NULL CHECK(policy_version BETWEEN 1 AND 2147483647), policy_revision INTEGER NOT NULL CHECK(policy_revision BETWEEN 1 AND 2147483647), policy_hash TEXT NOT NULL CHECK(length(policy_hash)=64), transaction_fingerprint TEXT NOT NULL CHECK(length(transaction_fingerprint)=64), network TEXT NOT NULL, mint TEXT NOT NULL, destination TEXT NOT NULL, signed_cap_raw TEXT NOT NULL CHECK(signed_cap_raw GLOB '[0-9]*'), issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, vault_attestation_id TEXT NOT NULL, vault_attestation_source TEXT NOT NULL, vault_attestation_version INTEGER NOT NULL CHECK(vault_attestation_version BETWEEN 1 AND 2147483647), payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64), UNIQUE(enrollment_id,payload_digest));
      CREATE TABLE IF NOT EXISTS wallet_protection_lifecycle_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, audit_id TEXT NOT NULL UNIQUE, enrollment_id TEXT NOT NULL REFERENCES protection_enrollments(enrollment_id), owner_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL, payload_digest TEXT, reason TEXT NOT NULL, occurred_at TEXT NOT NULL);
      CREATE TRIGGER protection_enrollments_no_update BEFORE UPDATE OF enrollment_id,wallet_id,policy_hash,owner_id,created_at ON protection_enrollments BEGIN SELECT RAISE(ABORT,'immutable_protection_binding'); END;
      CREATE TRIGGER IF NOT EXISTS wallet_protection_lifecycle_audit_no_update BEFORE UPDATE ON wallet_protection_lifecycle_audit BEGIN SELECT RAISE(ABORT,'append_only_wallet_protection_audit'); END;
      CREATE TRIGGER IF NOT EXISTS wallet_protection_lifecycle_audit_no_delete BEFORE DELETE ON wallet_protection_lifecycle_audit BEGIN SELECT RAISE(ABORT,'append_only_wallet_protection_audit'); END;
      CREATE INDEX IF NOT EXISTS permit_attestations_enrollment_idx ON permit_attestations(enrollment_id,issued_at);
      PRAGMA user_version=9; COMMIT;`); return;
  }
  if (version === 7) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS wallet_protection_policies (
        policy_hash TEXT PRIMARY KEY CHECK(length(policy_hash)=64), action_type TEXT NOT NULL,
        policy_version INTEGER NOT NULL CHECK(policy_version BETWEEN 1 AND 2147483647),
        combine_mode TEXT NOT NULL CHECK(combine_mode='OR'), policy_json TEXT NOT NULL CHECK(json_valid(policy_json))
      );
      CREATE TABLE IF NOT EXISTS protection_enrollments (
        wallet_id TEXT PRIMARY KEY, policy_hash TEXT NOT NULL REFERENCES wallet_protection_policies(policy_hash),
        state TEXT NOT NULL CHECK(state IN ('setup_incomplete','armed','inactive_position_absent','revoked')),
        owner_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS protection_enrollments_no_update BEFORE UPDATE OF wallet_id,policy_hash,owner_id,created_at ON protection_enrollments BEGIN SELECT RAISE(ABORT,'immutable_protection_binding'); END;
      PRAGMA user_version=8; COMMIT;`);
    return;
  }
  if (version === 5) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS agent_access_requests (id TEXT PRIMARY KEY, scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)), reason TEXT NOT NULL, duration_minutes INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','delivered','exchanged','revoked')), retrieval_digest TEXT NOT NULL CHECK(length(retrieval_digest)=64), exchange_digest TEXT CHECK(exchange_digest IS NULL OR length(exchange_digest)=64), exchange_expires_at INTEGER, delivered_at INTEGER, CHECK(duration_minutes BETWEEN 1 AND 60), CHECK(expires_at > created_at), CHECK(exchange_expires_at IS NULL OR exchange_expires_at <= expires_at));
      CREATE TABLE IF NOT EXISTS agent_access_sessions (token_digest TEXT PRIMARY KEY CHECK(length(token_digest)=64), request_id TEXT NOT NULL REFERENCES agent_access_requests(id), scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)), expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)), CHECK(expires_at > 0));
      PRAGMA user_version=6; COMMIT;`);
    return;
  }
  if (version === 6) {
    // v6 was a published schema; migrate only after complete preflight verification.
    verifySchemaShape(db, true, false, false);
    const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('operations_proposals','operations_approvals')").all();
    if (existing.length) throw new Error('invalid_schema_v6_operations_objects');
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE operations_proposals (
        proposal_id TEXT PRIMARY KEY, requester TEXT NOT NULL, destination_service TEXT NOT NULL,
        operation TEXT NOT NULL, operation_version INTEGER NOT NULL CHECK(operation_version BETWEEN 1 AND 2147483647), payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), resource_ids_json TEXT NOT NULL CHECK(json_valid(resource_ids_json)),
        idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        risk TEXT NOT NULL CHECK(risk IN ('read','mutate','critical')), approval_requirements_json TEXT NOT NULL CHECK(json_valid(approval_requirements_json)), payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64), envelope_digest TEXT NOT NULL CHECK(length(envelope_digest)=64),
        status TEXT NOT NULL CHECK(status IN ('pending_approval','approved','rejected','expired','revoked')), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 2147483647), UNIQUE(requester,idempotency_key), CHECK(expires_at > created_at)
      );
      CREATE TABLE operations_approvals (
        approval_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES operations_proposals(proposal_id), proposal_revision INTEGER NOT NULL CHECK(proposal_revision BETWEEN 1 AND 2147483647), envelope_digest TEXT NOT NULL CHECK(length(envelope_digest)=64), approver_id TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('approve','reject')), approval_kind TEXT NOT NULL CHECK(approval_kind IN ('proposal','critical')), decided_at TEXT NOT NULL, reason TEXT NOT NULL,
        UNIQUE(proposal_id,proposal_revision,approval_kind)
      );
      CREATE TRIGGER operations_proposals_immutable BEFORE UPDATE OF proposal_id,requester,destination_service,operation,operation_version,payload_json,resource_ids_json,idempotency_key,created_at,expires_at,risk,approval_requirements_json,payload_digest,envelope_digest,revision ON operations_proposals BEGIN SELECT RAISE(ABORT,'immutable_operations_proposal'); END;
      CREATE TRIGGER operations_approvals_no_update BEFORE UPDATE ON operations_approvals BEGIN SELECT RAISE(ABORT,'append_only_operations_approval'); END;
      CREATE TRIGGER operations_approvals_no_delete BEFORE DELETE ON operations_approvals BEGIN SELECT RAISE(ABORT,'append_only_operations_approval'); END;
      CREATE INDEX operations_proposals_status_idx ON operations_proposals(status,created_at);
      CREATE INDEX operations_approvals_proposal_idx ON operations_approvals(proposal_id,proposal_revision);
      PRAGMA user_version=7; COMMIT;`);
    return;
  }
  if (version === 4) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE protocols ADD COLUMN discovery_adapter_id TEXT;
      ALTER TABLE protocols ADD COLUMN discovery_adapter_version INTEGER;
      UPDATE protocols SET discovery_adapter_id='${LEGACY_DISCOVERY_ADAPTER_ID}', discovery_adapter_version=1
        WHERE discovery_adapter_id IS NULL AND discovery_adapter_version IS NULL;
      PRAGMA user_version=5; COMMIT;`);
    return;
  }
  if (version === 3) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS preflight_receipts (
        receipt_id TEXT PRIMARY KEY, target_id TEXT NOT NULL, identity TEXT NOT NULL,
        facts_json TEXT NOT NULL CHECK(json_valid(facts_json)), facts_digest TEXT NOT NULL CHECK(length(facts_digest)=64),
        issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_proposal_id TEXT UNIQUE,
        CHECK(expires_at > issued_at)
      );
      CREATE TRIGGER IF NOT EXISTS preflight_receipts_no_mutation BEFORE UPDATE OF receipt_id,target_id,identity,facts_json,facts_digest,issued_at,expires_at ON preflight_receipts BEGIN
        SELECT RAISE(ABORT,'immutable_preflight_receipt'); END;
      PRAGMA user_version=4; COMMIT;`);
    return;
  }
  if (version === 2) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS onboarding_proposals (
        proposal_id TEXT PRIMARY KEY, target_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        payload_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','validated','provisioning','activated','paused','retired')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assignment_outbox (
        event_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES onboarding_proposals(proposal_id),
        event_type TEXT NOT NULL CHECK(event_type IN ('assignment.activated','assignment.paused','assignment.retired')),
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), payload_hash TEXT NOT NULL,
        acknowledged_at TEXT, created_at TEXT NOT NULL
      );
      PRAGMA user_version=3; COMMIT;`);
    return;
  }
  if (version === 1) {
    verifySchemaShape(db, false, true);
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE admin_requests (
        idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
        status_code INTEGER NOT NULL, response_json TEXT NOT NULL CHECK(json_valid(response_json)),
        created_at TEXT NOT NULL
      );
      PRAGMA user_version=2;
      COMMIT;`);
  }
}

const EXPECTED_COLUMNS = {
  protocols: [['id', 'TEXT', 0, null, 1], ['name', 'TEXT', 1, null, 0], ['chain', 'TEXT', 1, null, 0], ['status', 'TEXT', 1, "'draft'", 0], ['discovery_adapter_id', 'TEXT', 0, null, 0], ['discovery_adapter_version', 'INTEGER', 0, null, 0]],
  targets: [['id', 'TEXT', 0, null, 1], ['protocol_id', 'TEXT', 1, null, 0], ['kind', 'TEXT', 1, null, 0], ['address', 'TEXT', 1, null, 0], ['name', 'TEXT', 1, null, 0], ['secret_ref', 'TEXT', 0, null, 0], ['status', 'TEXT', 1, "'draft'", 0]],
  target_registry: [['target_id','TEXT',0,null,1],['chain','TEXT',1,null,0],['network','TEXT',1,null,0],['protocol_id','TEXT',1,null,0],['resource_type','TEXT',1,null,0],['address','TEXT',1,null,0],['display_name','TEXT',1,null,0],['strategy','TEXT',1,"'Yield'",0],['protocol_url','TEXT',1,"''",0],['protocol_icon_key','TEXT',1,"'kamino'",0],['token_icon_key','TEXT',1,"''",0],['token_symbol','TEXT',1,"''",0],['catalog_tvl_usd','TEXT',1,"'0'",0]],
  target_capabilities: [['target_id','TEXT',0,null,1],['token_mint','TEXT',1,null,0],['shares_mint','TEXT',1,null,0],['discovery_adapter_id','TEXT',1,null,0],['discovery_adapter_version','INTEGER',1,null,0],['metrics_adapter_id','TEXT',1,null,0],['metrics_adapter_version','INTEGER',1,null,0]],
  onboarding_evidence: [['target_id','TEXT',0,null,1],['cursor','TEXT',0,null,0],['first_observation_at','TEXT',0,null,0],['tvl_json','TEXT',0,null,0],['required_receipts_json','TEXT',1,"'[]'",0]],
  target_aliases: [['alias','TEXT',0,null,1],['target_id','TEXT',1,null,0]],
  rule_definitions: [['id', 'TEXT', 0, null, 1], ['name', 'TEXT', 1, null, 0], ['evaluator_type', 'TEXT', 1, null, 0]],
  rule_versions: [['rule_id', 'TEXT', 1, null, 1], ['version', 'INTEGER', 1, null, 2], ['evaluator_version', 'TEXT', 1, null, 0], ['parameters_json', 'TEXT', 1, null, 0], ['evidence_schema', 'TEXT', 1, null, 0], ['content_hash', 'TEXT', 1, null, 0]],
  rule_bindings: [['id', 'TEXT', 0, null, 1], ['rule_id', 'TEXT', 1, null, 0], ['rule_version', 'INTEGER', 1, null, 0], ['target_id', 'TEXT', 1, null, 0], ['status', 'TEXT', 1, "'draft'", 0]],
  wallets: [['wallet_id', 'TEXT', 0, null, 1], ['status', 'TEXT', 1, "'active'", 0]],
  wallet_enrollments: [['wallet_id','TEXT',1,null,1],['position_id','TEXT',1,null,2],['target_id','TEXT',1,null,0],['network','TEXT',1,null,0],['source','TEXT',1,null,0],['subject_id','TEXT',1,null,0],['status','TEXT',1,"'active'",0],['created_at','TEXT',1,null,0],['updated_at','TEXT',1,null,0]],
  configuration_revisions: [['revision', 'INTEGER', 0, null, 1], ['snapshot_json', 'TEXT', 1, null, 0], ['content_hash', 'TEXT', 1, null, 0], ['activated_at', 'TEXT', 1, null, 0]],
  audit_events: [['sequence', 'INTEGER', 0, null, 1], ['id', 'TEXT', 1, null, 0], ['actor_id', 'TEXT', 1, null, 0], ['action', 'TEXT', 1, null, 0], ['entity_type', 'TEXT', 1, null, 0], ['entity_id', 'TEXT', 1, null, 0], ['reason', 'TEXT', 1, null, 0], ['before_hash', 'TEXT', 0, null, 0], ['after_hash', 'TEXT', 0, null, 0], ['occurred_at', 'TEXT', 1, null, 0]],
  admin_requests: [['idempotency_key', 'TEXT', 0, null, 1], ['request_hash', 'TEXT', 1, null, 0], ['status_code', 'INTEGER', 1, null, 0], ['response_json', 'TEXT', 1, null, 0], ['created_at', 'TEXT', 1, null, 0]],
  onboarding_proposals: [['proposal_id', 'TEXT', 0, null, 1], ['target_id', 'TEXT', 1, null, 0], ['payload_json', 'TEXT', 1, null, 0], ['payload_hash', 'TEXT', 1, null, 0], ['status', 'TEXT', 1, null, 0], ['created_at', 'TEXT', 1, null, 0], ['updated_at', 'TEXT', 1, null, 0]],
  assignment_outbox: [['event_id', 'TEXT', 0, null, 1], ['proposal_id', 'TEXT', 1, null, 0], ['event_type', 'TEXT', 1, null, 0], ['payload_json', 'TEXT', 1, null, 0], ['payload_hash', 'TEXT', 1, null, 0], ['acknowledged_at', 'TEXT', 0, null, 0], ['created_at', 'TEXT', 1, null, 0]],
  preflight_receipts: [['receipt_id', 'TEXT', 0, null, 1], ['target_id', 'TEXT', 1, null, 0], ['identity', 'TEXT', 1, null, 0], ['facts_json', 'TEXT', 1, null, 0], ['facts_digest', 'TEXT', 1, null, 0], ['issued_at', 'TEXT', 1, null, 0], ['expires_at', 'TEXT', 1, null, 0], ['consumed_proposal_id', 'TEXT', 0, null, 0]],
  agent_access_requests: [['id','TEXT',0,null,1],['scopes_json','TEXT',1,null,0],['reason','TEXT',1,null,0],['duration_minutes','INTEGER',1,null,0],['created_at','INTEGER',1,null,0],['expires_at','INTEGER',1,null,0],['status','TEXT',1,null,0],['retrieval_digest','TEXT',1,null,0],['exchange_digest','TEXT',0,null,0],['exchange_expires_at','INTEGER',0,null,0],['delivered_at','INTEGER',0,null,0]],
  agent_access_sessions: [['token_digest','TEXT',0,null,1],['request_id','TEXT',1,null,0],['scopes_json','TEXT',1,null,0],['expires_at','INTEGER',1,null,0],['revoked','INTEGER',1,'0',0]],
  operations_proposals: [['proposal_id','TEXT',0,null,1],['requester','TEXT',1,null,0],['destination_service','TEXT',1,null,0],['operation','TEXT',1,null,0],['operation_version','INTEGER',1,null,0],['payload_json','TEXT',1,null,0],['resource_ids_json','TEXT',1,null,0],['idempotency_key','TEXT',1,null,0],['created_at','TEXT',1,null,0],['expires_at','TEXT',1,null,0],['risk','TEXT',1,null,0],['approval_requirements_json','TEXT',1,null,0],['payload_digest','TEXT',1,null,0],['envelope_digest','TEXT',1,null,0],['status','TEXT',1,null,0],['revision','INTEGER',1,'1',0]],
  operations_approvals: [['approval_id','TEXT',0,null,1],['proposal_id','TEXT',1,null,0],['proposal_revision','INTEGER',1,null,0],['envelope_digest','TEXT',1,null,0],['approver_id','TEXT',1,null,0],['decision','TEXT',1,null,0],['approval_kind','TEXT',1,null,0],['decided_at','TEXT',1,null,0],['reason','TEXT',1,null,0]],
  wallet_protection_policies: [['policy_hash','TEXT',0,null,1],['action_type','TEXT',1,null,0],['policy_version','INTEGER',1,null,0],['combine_mode','TEXT',1,null,0],['policy_json','TEXT',1,null,0]],
  protection_enrollments: [['enrollment_id','TEXT',0,null,1],['wallet_id','TEXT',1,null,0],['policy_hash','TEXT',1,null,0],['state','TEXT',1,null,0],['owner_id','TEXT',1,null,0],['created_at','TEXT',1,null,0],['updated_at','TEXT',1,null,0]],
  permit_attestations: [['attestation_id','TEXT',0,null,1],['enrollment_id','TEXT',1,null,0],['wallet_id','TEXT',1,null,0],['target_id','TEXT',1,null,0],['action_type','TEXT',1,null,0],['policy_version','INTEGER',1,null,0],['policy_revision','INTEGER',1,null,0],['policy_hash','TEXT',1,null,0],['transaction_fingerprint','TEXT',1,null,0],['network','TEXT',1,null,0],['mint','TEXT',1,null,0],['destination','TEXT',1,null,0],['signed_cap_raw','TEXT',1,null,0],['issued_at','TEXT',1,null,0],['expires_at','TEXT',1,null,0],['vault_attestation_id','TEXT',1,null,0],['vault_attestation_source','TEXT',1,null,0],['vault_attestation_version','INTEGER',1,null,0],['payload_digest','TEXT',1,null,0]],
  wallet_protection_lifecycle_audit: [['sequence','INTEGER',0,null,1],['audit_id','TEXT',1,null,0],['enrollment_id','TEXT',1,null,0],['owner_id','TEXT',1,null,0],['from_state','TEXT',0,null,0],['to_state','TEXT',1,null,0],['payload_digest','TEXT',0,null,0],['reason','TEXT',1,null,0],['occurred_at','TEXT',1,null,0]],
};

function verifySchema(db) {
  verifySchemaShape(db, true);
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('database_integrity_check_failed');
}

function projection(row) {
  if (!row) return null;
  return { proposalId: row.proposal_id, requester: row.requester, destinationService: row.destination_service, operation: row.operation, operationVersion: row.operation_version, payload: JSON.parse(row.payload_json), resourceIds: JSON.parse(row.resource_ids_json), createdAt: row.created_at, expiresAt: row.expires_at, risk: row.risk, approvalRequirements: JSON.parse(row.approval_requirements_json), payloadDigest: row.payload_digest, envelopeDigest: row.envelope_digest, status: row.status, revision: row.revision };
}

function draftManifest(input) {
  const manifest = input?.draftManifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new TypeError('draftManifest is required');
  const ids = name => {
    if (!Array.isArray(manifest[name]) || manifest[name].length === 0 || manifest[name].some(id => typeof id !== 'string' || id.trim() === '')) throw new TypeError(`draftManifest.${name} is required`);
    const values = manifest[name].map(id => id.trim());
    if (new Set(values).size !== values.length) throw new TypeError(`draftManifest.${name} contains duplicates`);
    return values;
  };
  return { protocolIds: ids('protocolIds'), targetIds: ids('targetIds'), bindingIds: ids('bindingIds') };
}

function scopedIds(ids) { return ids.map(() => '?').join(','); }

function validateActivationGraph(db, manifest) {
  if (activeAdapterRegistry && activeAdapterRegistry.size) {
    const rows = db.prepare(`SELECT id,discovery_adapter_id,discovery_adapter_version FROM protocols WHERE id IN (${scopedIds(manifest.protocolIds)})`).all(...manifest.protocolIds);
    for (const row of rows) { if (!row.discovery_adapter_id || !row.discovery_adapter_version) throw new Error(`missing_discovery_adapter_metadata:${row.id}`); if (row.discovery_adapter_id === LEGACY_DISCOVERY_ADAPTER_ID || activeAdapterRegistry.get(row.discovery_adapter_id) !== Number(row.discovery_adapter_version)) throw new Error(`unregistered_discovery_adapter:${row.discovery_adapter_id}@${row.discovery_adapter_version}`); }
  }
  const targetIds = [...manifest.targetIds];
  const bindingIds = [...manifest.bindingIds];
  const protocolIds = [...manifest.protocolIds];
  const targetSet = scopedIds(targetIds), bindingSet = scopedIds(bindingIds), protocolSet = scopedIds(protocolIds);
  const draftRows = db.prepare(`SELECT
    (SELECT count(*) FROM protocols WHERE id IN (${protocolSet}) AND status='draft') +
    (SELECT count(*) FROM targets WHERE id IN (${targetSet}) AND status='draft') +
    (SELECT count(*) FROM rule_bindings WHERE id IN (${bindingSet}) AND status='draft') AS n`).get(...protocolIds, ...targetIds, ...bindingIds);
  if (Number(draftRows.n) === 0) throw new Error('no_draft_changes');
  const rows = db.prepare(`SELECT count(*) n FROM protocols WHERE id IN (${protocolSet}) AND status IN ('draft','active')`).get(...protocolIds);
  const targetRows = db.prepare(`SELECT count(*) n FROM targets WHERE id IN (${targetSet}) AND status IN ('draft','active')`).get(...targetIds);
  const bindingRows = db.prepare(`SELECT count(*) n FROM rule_bindings WHERE id IN (${bindingSet}) AND status IN ('draft','active')`).get(...bindingIds);
  if (Number(rows.n) !== protocolIds.length || Number(targetRows.n) !== targetIds.length || Number(bindingRows.n) !== bindingIds.length) throw new Error('draft_manifest_incomplete');
  const wrongTargetProtocol = db.prepare(`SELECT t.id FROM targets t
    WHERE t.id IN (${targetSet}) AND t.protocol_id NOT IN (${protocolSet}) LIMIT 1`).get(...targetIds, ...protocolIds);
  if (wrongTargetProtocol) throw new Error(`draft_manifest_relationship:target_protocol:${wrongTargetProtocol.id}`);
  const wrongBindingTarget = db.prepare(`SELECT b.id FROM rule_bindings b
    WHERE b.id IN (${bindingSet}) AND b.target_id NOT IN (${targetSet}) LIMIT 1`).get(...bindingIds, ...targetIds);
  if (wrongBindingTarget) throw new Error(`draft_manifest_relationship:binding_target:${wrongBindingTarget.id}`);
  const orphan = db.prepare(`SELECT t.id FROM targets t LEFT JOIN rule_bindings b
    ON b.target_id=t.id AND b.id IN (${bindingSet}) AND b.status IN ('draft','active')
    WHERE t.id IN (${targetSet}) GROUP BY t.id HAVING count(b.id)=0 LIMIT 1`).get(...targetIds, ...bindingIds);
  if (orphan) throw new Error(`target_without_binding:${orphan.id}`);
  const counts = db.prepare(`SELECT
    (SELECT count(*) FROM targets WHERE status='active' OR id IN (${targetSet})) AS targets,
    (SELECT count(*) FROM rule_bindings WHERE status='active' OR id IN (${bindingSet})) AS bindings`).get(...targetIds, ...bindingIds);
  if (Number(counts.targets) === 0 || Number(counts.bindings) === 0) throw new Error('activation_requires_target_and_binding');
  const badDependency = db.prepare(`SELECT b.id FROM rule_bindings b
    JOIN targets t ON t.id=b.target_id JOIN protocols p ON p.id=t.protocol_id
    JOIN rule_versions v ON v.rule_id=b.rule_id AND v.version=b.rule_version
    WHERE (b.status='active' OR b.id IN (${bindingSet})) AND (t.status='retired' OR p.status='retired') LIMIT 1`).get(...bindingIds);
  if (badDependency) throw new Error(`inactive_binding_dependency:${badDependency.id}`);
}

function promoteDraft(db, manifest) {
  const update = (table, column, ids) => db.prepare(`UPDATE ${table} SET status='active' WHERE status='draft' AND ${column} IN (${scopedIds(ids)})`).run(...ids);
  update('protocols', 'id', manifest.protocolIds); update('targets', 'id', manifest.targetIds); update('rule_bindings', 'id', manifest.bindingIds);
}

function readSnapshot(db) {
  const protocols = db.prepare(`SELECT id,name,chain,status,discovery_adapter_id,discovery_adapter_version FROM protocols WHERE status='active' ORDER BY id`).all().map(row => ({ id: row.id, name: row.name, chain: row.chain, status: row.status, ...(row.discovery_adapter_id === null ? {} : { discoveryAdapterId: row.discovery_adapter_id, discoveryAdapterVersion: row.discovery_adapter_version }) }));
  const targets = db.prepare(`SELECT id,protocol_id,kind,address,name,secret_ref,status FROM targets WHERE status='active' ORDER BY id`).all().map(row => ({
    id: row.id, protocolId: row.protocol_id, kind: row.kind, address: row.address,
    name: row.name, secretRef: row.secret_ref, status: row.status
  }));
  const rules = db.prepare(`SELECT DISTINCT d.id,d.name,d.evaluator_type FROM rule_definitions d
    JOIN rule_versions v ON v.rule_id=d.id JOIN rule_bindings b ON b.rule_id=v.rule_id AND b.rule_version=v.version
    WHERE b.status='active' ORDER BY d.id`).all().map(row => ({ id: row.id, name: row.name, evaluatorType: row.evaluator_type }));
  const ruleVersions = db.prepare(`SELECT DISTINCT v.rule_id,v.version,d.evaluator_type,v.evaluator_version,v.parameters_json,v.evidence_schema,v.content_hash
    FROM rule_versions v JOIN rule_definitions d ON d.id=v.rule_id
    JOIN rule_bindings b ON b.rule_id=v.rule_id AND b.rule_version=v.version
    WHERE b.status='active' ORDER BY v.rule_id,v.version`).all().map(row => ({
    ruleId: row.rule_id, version: row.version, evaluatorType: row.evaluator_type, evaluatorVersion: row.evaluator_version,
    parameters: JSON.parse(row.parameters_json), evidenceSchema: row.evidence_schema, contentHash: row.content_hash
  }));
  const bindings = db.prepare(`SELECT id,rule_id,rule_version,target_id,status FROM rule_bindings WHERE status='active' ORDER BY id`).all().map(row => ({
    id: row.id, ruleId: row.rule_id, ruleVersion: row.rule_version, targetId: row.target_id, status: row.status
  }));
  return { protocols, targets, rules, ruleVersions, bindings };
}

export function createControlPlaneStore({ path = 'var/kelvara-control-plane.sqlite', registeredDiscoveryAdapters, testHooks = {} } = {}) {
  const adapterRegistryForValidation = registeredDiscoveryAdapters === undefined ? null : new Map();
  activeAdapterRegistry = adapterRegistryForValidation;
  const adapterRegistry = registeredDiscoveryAdapters === undefined ? null : new Map((registeredDiscoveryAdapters ?? []).map(adapter => {
    const metadata = discoveryMetadata(adapter?.id, adapter?.version, { allowMissing: false });
    if (adapter?.config !== undefined || adapter?.discover !== undefined || adapter?.url !== undefined || adapter?.credential !== undefined) throw new TypeError('discovery adapter registry metadata only');
    adapterRegistryForValidation.set(metadata.id, metadata.version); return [metadata.id, metadata.version];
  }));
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  const schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
  if (schemaVersion > SCHEMA_VERSION) { db.close(); throw new Error(`unsupported_schema_version:${schemaVersion}`); }
  if (schemaVersion === 0) createSchema(db);
  else if (schemaVersion < SCHEMA_VERSION) {
    let version = schemaVersion;
    while (version < SCHEMA_VERSION) { migrateSchema(db, version); version = db.prepare('PRAGMA user_version').get().user_version; }
  }
  verifySchema(db);

  return {
    createProtocol(input) {
      const metadata = discoveryMetadata(input.discoveryAdapterId, input.discoveryAdapterVersion);
      const row = { id: required(input.id, 'id'), name: required(input.name, 'name'), chain: required(input.chain, 'chain'), status: 'draft', discoveryAdapterId: metadata.id, discoveryAdapterVersion: metadata.version };
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO protocols (id,name,chain,status,discovery_adapter_id,discovery_adapter_version) VALUES (?,?,?,?,?,?)').run(row.id, row.name, row.chain, row.status, row.discoveryAdapterId, row.discoveryAdapterVersion);
        audit(db, { ...input, action: 'protocol.created', entityType: 'protocol', entityId: row.id, after: row });
        db.exec('COMMIT'); return row;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    getProtocol(id) {
      const row = db.prepare('SELECT id,name,chain,status,discovery_adapter_id,discovery_adapter_version FROM protocols WHERE id=?').get(id);
      return row ? { id: row.id, name: row.name, chain: row.chain, status: row.status, ...(row.discovery_adapter_id === null ? {} : { discoveryAdapterId: row.discovery_adapter_id, discoveryAdapterVersion: row.discovery_adapter_version }) } : null;
    },
    createTarget(input) {
      const row = {
        id: required(input.id, 'id'), protocolId: required(input.protocolId, 'protocolId'), kind: required(input.kind, 'kind'),
        address: readerAddress(input.address), name: required(input.name, 'name'),
        secretRef: input.secretRef ? secretReference(input.secretRef) : null, status: 'draft'
      };
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`INSERT INTO targets (id,protocol_id,kind,address,name,secret_ref,status) VALUES (?,?,?,?,?,?,?)`)
          .run(row.id, row.protocolId, row.kind, row.address, row.name, row.secretRef, row.status);
        if (row.id.includes(':')) {
          const identity = parseCanonicalTargetId(row.id);
          if (identity.protocolId !== row.protocolId || identity.resourceType !== row.kind || identity.address !== row.address) throw new TypeError('canonical_target_id');
          const network = required(input.network, 'network');
          if (identity.network !== network) throw new TypeError('canonical_target_id');
          db.prepare(`INSERT INTO target_registry (target_id,chain,network,protocol_id,resource_type,address,display_name) VALUES (?,?,?,?,?,?,?)`)
            .run(row.id, identity.chain, network, row.protocolId, row.kind, row.address, row.name);
        }
        audit(db, { ...input, action: 'target.created', entityType: 'target', entityId: row.id, after: row });
        db.exec('COMMIT'); return row;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    getTarget(id) {
      const row = db.prepare(`SELECT id,protocol_id,kind,address,name,secret_ref,status FROM targets WHERE id=?`).get(id);
      return row ? { id: row.id, protocolId: row.protocol_id, kind: row.kind, address: row.address, name: row.name, secretRef: row.secret_ref, status: row.status } : null;
    },
    reconcileTargetAuthorities() {
      const targets = db.prepare(`SELECT t.id,t.protocol_id,t.kind,t.address,t.name,p.chain,p.discovery_adapter_id,p.discovery_adapter_version
        FROM targets t JOIN protocols p ON p.id=t.protocol_id
        WHERE t.status='active' AND p.status='active' ORDER BY t.id`).all();
      const created = [], unchanged = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const target of targets) {
          const identity = parseCanonicalTargetId(target.id);
          if (identity.chain !== target.chain || identity.protocolId !== target.protocol_id || identity.resourceType !== target.kind || identity.address !== target.address) throw new TypeError('canonical_target_id');
          if (!adapterRegistry || adapterRegistry.get(target.discovery_adapter_id) !== target.discovery_adapter_version) throw new Error(`discovery_adapter_not_registered:${target.discovery_adapter_id}@${target.discovery_adapter_version}`);
          const existing = db.prepare('SELECT target_id,chain,network,protocol_id,resource_type,address,display_name FROM target_registry WHERE target_id=?').get(target.id);
          if (existing) {
            if (existing.chain !== identity.chain || existing.network !== identity.network || existing.protocol_id !== identity.protocolId || existing.resource_type !== identity.resourceType || existing.address !== identity.address || existing.display_name !== target.name) throw new Error(`target_authority_conflict:${target.id}`);
            unchanged.push(target.id); continue;
          }
          db.prepare('INSERT INTO target_registry (target_id,chain,network,protocol_id,resource_type,address,display_name) VALUES (?,?,?,?,?,?,?)').run(target.id,identity.chain,identity.network,identity.protocolId,identity.resourceType,identity.address,target.name);
          audit(db,{actorId:'control-plane',action:'target_authority.reconciled',entityType:'target_authority',entityId:target.id,reason:'canonical active target reconciliation',after:{targetId:target.id,chain:identity.chain,network:identity.network,protocolId:identity.protocolId,resourceType:identity.resourceType,address:identity.address,displayName:target.name}});
          created.push(target.id);
        }
        db.exec('COMMIT'); return { created, unchanged };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    registerTarget(input) {
      const targetId = required(input.targetId, 'targetId');
      const match = CANONICAL_TARGET_ID.exec(targetId);
      if (!match || match[1] !== required(input.chain, 'chain') || match[2] !== required(input.network, 'network') || match[3] !== required(input.protocolId, 'protocolId') || match[4] !== required(input.resourceType, 'resourceType') || match[5] !== required(input.address, 'address')) throw new TypeError('canonical_target_id');
      const row = { targetId, chain: input.chain, network: input.network, protocolId: input.protocolId, resourceType: input.resourceType, address: input.address, displayName: required(input.displayName, 'displayName') };
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO target_registry (target_id,chain,network,protocol_id,resource_type,address,display_name) VALUES (?,?,?,?,?,?,?)').run(row.targetId,row.chain,row.network,row.protocolId,row.resourceType,row.address,row.displayName);
        for (const alias of input.aliases ?? []) this.addTargetAlias(alias, row.targetId);
        db.exec('COMMIT'); return row;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    addTargetAlias(alias, targetId) {
      alias = required(alias, 'alias'); targetId = required(targetId, 'targetId');
      if (alias === targetId) throw new Error('alias_canonical_collision');
      if (!db.prepare('SELECT 1 FROM target_registry WHERE target_id=?').get(targetId)) throw new Error('target_not_found');
      const existing = db.prepare('SELECT target_id FROM target_aliases WHERE alias=?').get(alias);
      if (existing && existing.target_id !== targetId) throw new Error('alias_conflict');
      db.prepare('INSERT OR IGNORE INTO target_aliases (alias,target_id) VALUES (?,?)').run(alias,targetId);
      return this.resolveTarget(targetId);
    },
    resolveTarget(identity) {
      const row = db.prepare(`SELECT target_id,chain,network,protocol_id,resource_type,address,display_name FROM target_registry WHERE target_id=? UNION ALL SELECT r.target_id,r.chain,r.network,r.protocol_id,r.resource_type,r.address,r.display_name FROM target_aliases a JOIN target_registry r ON r.target_id=a.target_id WHERE a.alias=?`).all(identity, identity);
      if (row.length > 1) throw new Error('ambiguous_target_alias');
      const value = row[0]; return value ? { targetId:value.target_id, chain:value.chain, network:value.network, protocolId:value.protocol_id, resourceType:value.resource_type, address:value.address, displayName:value.display_name } : null;
    },
    listTargetAliases(targetId) {
      const canonical = this.resolveTarget(targetId);
      if (!canonical) throw new Error('target_not_found');
      return db.prepare('SELECT alias FROM target_aliases WHERE target_id=? ORDER BY alias').all(canonical.targetId).map(row => row.alias);
    },
    projectTarget(target) {
      const canonical = this.resolveTarget(target.id);
      if (!canonical) throw new TypeError(`unresolved_target_authority:${target.id}`);
      let parsed;
      try { parsed = parseCanonicalTargetId(canonical.targetId); } catch { throw new TypeError(`unresolved_target_authority:${target.id}`); }
      if (canonical.protocolId !== target.protocolId || canonical.resourceType !== target.kind || canonical.address !== target.address || parsed.address !== canonical.address) {
        throw new TypeError(`unresolved_target_authority:${target.id}`);
      }
      return { id: canonical.targetId, chain: canonical.chain, network: canonical.network, protocolId: canonical.protocolId, resourceType: canonical.resourceType, address: readerAddress(target.address), displayName: canonical.displayName, status: target.status, legacyAliases: this.listTargetAliases(canonical.targetId) };
    },
    createRuleDefinition(input) {
      const row = { id: required(input.id, 'id'), name: required(input.name, 'name'), evaluatorType: required(input.evaluatorType, 'evaluatorType') };
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO rule_definitions (id,name,evaluator_type) VALUES (?,?,?)').run(row.id, row.name, row.evaluatorType);
        audit(db, { ...input, action: 'rule.created', entityType: 'rule', entityId: row.id, after: row });
        db.exec('COMMIT'); return row;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    createRuleVersion(input) {
      const version = Number(input.version);
      if (!Number.isInteger(version) || version < 1) throw new TypeError('version must be a positive integer');
      if (!input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters)) throw new TypeError('parameters must be a JSON-safe object');
      const parameters = jsonSafe(input.parameters);
      const content = { ruleId: required(input.ruleId, 'ruleId'), version, evaluatorVersion: required(input.evaluatorVersion, 'evaluatorVersion'), parameters, evidenceSchema: required(input.evidenceSchema, 'evidenceSchema') };
      const row = { ...content, contentHash: hash(content) };
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`INSERT INTO rule_versions (rule_id,version,evaluator_version,parameters_json,evidence_schema,content_hash) VALUES (?,?,?,?,?,?)`)
          .run(row.ruleId, row.version, row.evaluatorVersion, JSON.stringify(row.parameters), row.evidenceSchema, row.contentHash);
        audit(db, { ...input, action: 'rule_version.created', entityType: 'rule_version', entityId: `${row.ruleId}@${row.version}`, after: row });
        db.exec('COMMIT'); return row;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    createBinding(input) {
      const row = { id: required(input.id, 'id'), ruleId: required(input.ruleId, 'ruleId'), ruleVersion: Number(input.ruleVersion), targetId: required(input.targetId, 'targetId'), status: 'draft' };
      if (!Number.isInteger(row.ruleVersion) || row.ruleVersion < 1) throw new TypeError('ruleVersion must be a positive integer');
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`INSERT INTO rule_bindings (id,rule_id,rule_version,target_id,status) VALUES (?,?,?,?,?)`).run(row.id, row.ruleId, row.ruleVersion, row.targetId, row.status);
        audit(db, { ...input, action: 'binding.created', entityType: 'binding', entityId: row.id, after: row });
        db.exec('COMMIT'); return row;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    listBindings() {
      return db.prepare('SELECT id,rule_id,rule_version,target_id,status FROM rule_bindings ORDER BY id').all().map(row => ({ id: row.id, ruleId: row.rule_id, ruleVersion: row.rule_version, targetId: row.target_id, status: row.status }));
    },
    getManagerProjection() {
      const revision = db.prepare('SELECT revision,activated_at FROM configuration_revisions ORDER BY revision DESC LIMIT 1').get();
      const wallets = db.prepare('SELECT wallet_id,status FROM wallets ORDER BY wallet_id').all().map(wallet => {
        const enrollments = db.prepare(`SELECT e.target_id,e.status,t.name,t.kind FROM wallet_enrollments e LEFT JOIN targets t ON t.id=e.target_id WHERE e.wallet_id=? ORDER BY e.target_id`).all(wallet.wallet_id);
        const protection = db.prepare(`SELECT e.enrollment_id,e.state,e.owner_id,e.created_at,e.updated_at,p.policy_version,p.policy_json FROM protection_enrollments e JOIN wallet_protection_policies p ON p.policy_hash=e.policy_hash WHERE e.wallet_id=? ORDER BY e.created_at DESC`).all(wallet.wallet_id).map(row => {
          const policy = JSON.parse(row.policy_json); const custom = policy.scope === 'custom' || policy.kind === 'custom' || policy.custom === true;
          return { enrollmentId: row.enrollment_id, category: custom ? 'custom' : 'general', state: row.state, readiness: ['setup_incomplete','permit_validated','permit_stored'].includes(row.state) ? 'configured_never_fired' : row.state === 'armed' ? 'ready' : ['fired','completed','revoked','expired'].includes(row.state) ? 'terminal' : 'unknown', createdAt: row.created_at, updatedAt: row.updated_at, policyVersion: row.policy_version, policyRevision: policy.policyRevision ?? null, actor: { ownerId: row.owner_id } };
        });
        const auditRows = db.prepare(`SELECT sequence,from_state AS fromState,to_state AS toState,reason,occurred_at AS occurredAt FROM wallet_protection_lifecycle_audit a JOIN protection_enrollments e ON e.enrollment_id=a.enrollment_id WHERE e.wallet_id=? ORDER BY sequence`).all(wallet.wallet_id);
        return { walletId: wallet.wallet_id, status: wallet.status, enrollments: enrollments.map(e => ({ targetId:e.target_id, name:e.name, kind:e.kind, status:e.status })), safeguards: { general: { status: protection.some(p=>p.category==='general') ? 'configured' : 'not_configured', items: protection.filter(p=>p.category==='general') }, custom: { status: protection.some(p=>p.category==='custom') ? 'configured' : 'not_configured', items: protection.filter(p=>p.category==='custom') } }, protectionHistory: auditRows, freshness: { status: 'unknown', source: 'control_plane_has_no_position_facts' }, audit: this.listAuditEvents().filter(event => event.entityId === wallet.wallet_id || event.entityId.startsWith(`${wallet.wallet_id}:`)) };
      });
      return { activeRevision: revision ? Number(revision.revision) : null, revisionActivatedAt: revision?.activated_at ?? null, wallets };
    },
    getRulesByVault() {
      const active = db.prepare('SELECT revision FROM configuration_revisions ORDER BY revision DESC LIMIT 1').get();
      const rows = db.prepare(`SELECT t.id target_id,t.name target_name,t.address,t.kind,t.protocol_id,
        p.name protocol_name,p.chain,
        b.id binding_id,b.status binding_status,b.rule_id,b.rule_version,
        d.name rule_name,d.evaluator_type,v.evaluator_version,v.parameters_json,v.evidence_schema,v.content_hash
        FROM targets t JOIN protocols p ON p.id=t.protocol_id
        LEFT JOIN rule_bindings b ON b.target_id=t.id
        LEFT JOIN rule_definitions d ON d.id=b.rule_id
        LEFT JOIN rule_versions v ON v.rule_id=b.rule_id AND v.version=b.rule_version
        WHERE t.kind IN ('vault','kvault') ORDER BY t.id,b.id`).all();
      const vaults = new Map();
      for (const row of rows) {
        if (!vaults.has(row.target_id)) vaults.set(row.target_id, { vaultId: row.target_id, vaultName: row.target_name, address: row.address, kind: row.kind, protocol: { id: row.protocol_id, name: row.protocol_name, chain: row.chain }, rules: [] });
        if (row.binding_id) vaults.get(row.target_id).rules.push({ bindingId: row.binding_id, bindingStatus: row.binding_status, ruleId: row.rule_id, ruleName: row.rule_name, immutableVersion: row.rule_version, evaluatorType: row.evaluator_type, evaluatorVersion: row.evaluator_version, parameters: JSON.parse(row.parameters_json), evidenceSchema: row.evidence_schema, contentHash: row.content_hash, activeRevision: row.binding_status === 'active' ? Number(active?.revision ?? 0) || null : null });
      }
      return { activeRevision: active ? Number(active.revision) : null, vaults: [...vaults.values()] };
    },
    createWalletProtectionEnrollment(input) {
      if (input.withinTransaction) return this.createWalletProtectionEnrollmentWithinTransaction(input);
      return this._createWalletProtectionEnrollment(input);
    },
    _createWalletProtectionEnrollment(input) {
      const walletId = required(input.walletId, 'walletId'); const ownerId = required(input.actorId, 'actorId');
      const policy = validateWalletSafeguardPolicy({ ...input.policy, walletId }); const policyHash = required(input.policy.policyHash, 'policyHash');
      required(input.reason, 'reason'); const now = new Date().toISOString(); const enrollmentId = `enr_${randomUUID()}`;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO wallet_protection_policies (policy_hash,action_type,policy_version,combine_mode,policy_json) VALUES (?,?,?,?,?)').run(policyHash, policy.actionType, policy.policyVersion, 'OR', JSON.stringify(policy));
        db.prepare('INSERT INTO protection_enrollments (enrollment_id,wallet_id,policy_hash,state,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(enrollmentId, walletId, policyHash, 'setup_incomplete', ownerId, now, now);
        audit(db, { actorId: ownerId, action: 'wallet_protection.enrolled', entityType: 'protection_enrollment', entityId: walletId, reason: input.reason, after: { walletId, policyHash, state: 'setup_incomplete' } });
        lifecycleAudit(db, { enrollmentId, ownerId, toState: 'setup_incomplete', reason: input.reason });
        db.exec('COMMIT'); return { enrollmentId, walletId, policy: JSON.parse(JSON.stringify(policy)), state: 'setup_incomplete' };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    createWalletProtectionEnrollmentWithinTransaction(input) {
      const walletId = required(input.walletId, 'walletId'); const ownerId = required(input.actorId, 'actorId');
      const policy = validateWalletSafeguardPolicy({ ...input.policy, walletId }); const policyHash = required(input.policy.policyHash, 'policyHash');
      required(input.reason, 'reason'); const now = new Date().toISOString(); const enrollmentId = `enr_${randomUUID()}`;
      db.prepare('INSERT INTO wallet_protection_policies (policy_hash,action_type,policy_version,combine_mode,policy_json) VALUES (?,?,?,?,?)').run(policyHash, policy.actionType, policy.policyVersion, 'OR', JSON.stringify(policy));
      db.prepare('INSERT INTO protection_enrollments (enrollment_id,wallet_id,policy_hash,state,owner_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(enrollmentId, walletId, policyHash, 'setup_incomplete', ownerId, now, now);
      audit(db, { actorId: ownerId, action: 'wallet_protection.enrolled', entityType: 'protection_enrollment', entityId: walletId, reason: input.reason, after: { walletId, policyHash, state: 'setup_incomplete' } });
      lifecycleAudit(db, { enrollmentId, ownerId, toState: 'setup_incomplete', reason: input.reason });
      return { enrollmentId, walletId, policy: JSON.parse(JSON.stringify(policy)), state: 'setup_incomplete' };
    },
    getWalletProtectionEnrollment(walletId, ownerId) {
      const row = db.prepare(`SELECT e.enrollment_id,e.wallet_id,e.policy_hash,e.state,e.owner_id,p.policy_json FROM protection_enrollments e JOIN wallet_protection_policies p ON p.policy_hash=e.policy_hash WHERE e.wallet_id=? AND e.owner_id=?`).get(walletId, ownerId);
      if (!row) return null;
      return { enrollmentId: row.enrollment_id, walletId: row.wallet_id, policy: JSON.parse(row.policy_json), state: row.state };
    },
    getWalletProtectionOwnerProjection(walletId, ownerId) {
      const enrollment = this.getWalletProtectionEnrollment(walletId, ownerId);
      if (!enrollment) return null;
      const attestation = db.prepare(`SELECT attestation_id,target_id,action_type,policy_version,policy_revision,policy_hash,transaction_fingerprint,network,mint,destination,issued_at,expires_at,vault_attestation_id,vault_attestation_source,vault_attestation_version FROM permit_attestations WHERE enrollment_id=? ORDER BY issued_at DESC LIMIT 1`).get(enrollment.enrollmentId);
      return { ...enrollment, permit: attestation ? { attestationId: attestation.attestation_id, targetId: attestation.target_id, actionType: attestation.action_type, policyVersion: attestation.policy_version, policyRevision: attestation.policy_revision, policyHash: attestation.policy_hash, transactionFingerprint: attestation.transaction_fingerprint, network: attestation.network, mint: attestation.mint, destination: attestation.destination, issuedAt: attestation.issued_at, expiresAt: attestation.expires_at, vaultAttestationId: attestation.vault_attestation_id, vaultAttestationSource: attestation.vault_attestation_source, vaultAttestationVersion: attestation.vault_attestation_version } : null };
    },
    listWalletProtectionLifecycleAuditForOwner(walletId, ownerId) {
      const enrollment = this.getWalletProtectionEnrollment(walletId, ownerId);
      if (!enrollment) return null;
      return db.prepare(`SELECT sequence,audit_id AS auditId,from_state AS fromState,to_state AS toState,payload_digest AS payloadDigest,reason,occurred_at AS occurredAt FROM wallet_protection_lifecycle_audit WHERE enrollment_id=? AND owner_id=? ORDER BY sequence`).all(enrollment.enrollmentId, ownerId);
    },
    getWalletSafeguardIdentity(identityRef) {
      if (typeof identityRef !== 'string' || !/^enr_[0-9a-f-]{36}$/.test(identityRef)) return null;
      const row = db.prepare(`SELECT e.enrollment_id,e.state,p.policy_json,p.policy_version FROM protection_enrollments e JOIN wallet_protection_policies p ON p.policy_hash=e.policy_hash WHERE e.enrollment_id=? AND e.state='armed'`).get(identityRef);
      if (!row) return null;
      const policy = JSON.parse(row.policy_json);
      return { policy, enrollmentId: row.enrollment_id, bindingId: policy.targetId, ruleId: policy.actionType, ruleVersion: Number(row.policy_version) };
    },
    getWalletProtectionEnrollmentByOwner(walletId, ownerId) {
      return this.getWalletProtectionOwnerProjection(walletId, ownerId);
    },
    getWalletProtectionLifecycleAudit(walletId, ownerId) {
      return this.listWalletProtectionLifecycleAuditForOwner(walletId, ownerId);
    },
    validateWalletProtectionPermit(permit, { actorId, withinTransaction = false }) {
      const ownerId = required(actorId, 'actorId');
      const enrollment = db.prepare('SELECT * FROM protection_enrollments WHERE enrollment_id=? AND owner_id=?').get(required(permit.enrollmentId, 'enrollmentId'), ownerId);
      if (!enrollment) throw new Error('enrollment_not_found');
      if (!['setup_incomplete','permit_validated','permit_stored','armed'].includes(enrollment.state)) throw new Error('illegal_lifecycle_transition');
      const policy = JSON.parse(db.prepare('SELECT policy_json FROM wallet_protection_policies WHERE policy_hash=?').get(enrollment.policy_hash).policy_json);
      for (const [key, expected] of Object.entries({ walletId: enrollment.wallet_id, targetId: policy.targetId, actionType: policy.actionType, policyVersion: policy.policyVersion, policyRevision: policy.policyRevision, policyHash: enrollment.policy_hash, network: policy.network, mint: policy.mint, destination: policy.destination })) if (permit[key] !== expected) throw new Error(`permit_binding_mismatch:${key}`);
      for (const key of ['transactionFingerprint','policyHash']) if (!/^[a-f0-9]{64}$/.test(permit[key])) throw new TypeError(`${key} is invalid`);
      for (const key of Object.keys(permit)) if (!PERMIT_FIELDS.has(key)) throw new TypeError(`unknown permit field: ${key}`);
      uint256(permit.signedCapRaw);
      const issuedAt = canonicalUtc(permit.issuedAt, 'issuedAt'); const expiresAt = canonicalUtc(permit.expiresAt, 'expiresAt');
      if (expiresAt <= issuedAt) throw new TypeError('permit temporal fields are invalid');
      for (const key of ['vaultAttestationId','vaultAttestationSource']) required(permit[key], key);
      if (!Number.isInteger(permit.vaultAttestationVersion) || permit.vaultAttestationVersion < 1) throw new TypeError('vaultAttestationVersion is invalid');
      const digest = permitDigest(permit);
      if (!withinTransaction) db.exec('BEGIN IMMEDIATE');
      try {
        const prior = db.prepare('SELECT payload_digest FROM permit_attestations WHERE attestation_id=?').get(permit.vaultAttestationId);
        const bound = db.prepare('SELECT payload_digest FROM permit_attestations WHERE enrollment_id=? ORDER BY issued_at DESC LIMIT 1').get(enrollment.enrollment_id);
        if ((prior && prior.payload_digest !== digest) || (bound && bound.payload_digest !== digest)) throw new Error('attestation_conflict');
        if (!prior) db.prepare('INSERT INTO permit_attestations (attestation_id,enrollment_id,wallet_id,target_id,action_type,policy_version,policy_revision,policy_hash,transaction_fingerprint,network,mint,destination,signed_cap_raw,issued_at,expires_at,vault_attestation_id,vault_attestation_source,vault_attestation_version,payload_digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(permit.vaultAttestationId, enrollment.enrollment_id, permit.walletId, permit.targetId, permit.actionType, permit.policyVersion, permit.policyRevision, permit.policyHash, permit.transactionFingerprint, permit.network, permit.mint, permit.destination, permit.signedCapRaw, issuedAt, expiresAt, permit.vaultAttestationId, permit.vaultAttestationSource, permit.vaultAttestationVersion, digest);
        if (enrollment.state === 'permit_stored') {
          if (!withinTransaction) db.exec('COMMIT'); return { enrollmentId: enrollment.enrollment_id, walletId: enrollment.wallet_id, state: 'permit_stored' };
        }
        const changed = enrollment.state === 'permit_validated' ? { changes: 0 } : db.prepare("UPDATE protection_enrollments SET state='permit_validated',updated_at=? WHERE enrollment_id=? AND state='setup_incomplete'").run(new Date().toISOString(), enrollment.enrollment_id);
        if (enrollment.state === 'setup_incomplete' && Number(changed.changes) !== 1) throw new Error('lifecycle_state_not_persisted');
        if (enrollment.state === 'setup_incomplete') lifecycleAudit(db, { enrollmentId: enrollment.enrollment_id, ownerId, fromState: enrollment.state, toState: 'permit_validated', payloadDigest: digest, reason: 'permit validated' });
        if (!withinTransaction) db.exec('COMMIT'); return { enrollmentId: enrollment.enrollment_id, walletId: enrollment.wallet_id, state: 'permit_validated' };
      } catch (error) { if (!withinTransaction) db.exec('ROLLBACK'); throw error; }
    },
    storeWalletProtectionPermit(permit, { actorId, reason, withinTransaction = false }) {
      const result = this.validateWalletProtectionPermit(permit, { actorId, withinTransaction }); required(reason, 'reason');
      if (result.state === 'permit_stored') return result;
      if (!withinTransaction) db.exec('BEGIN IMMEDIATE');
      try {
        const changed = db.prepare("UPDATE protection_enrollments SET state='permit_stored',updated_at=? WHERE enrollment_id=? AND state='permit_validated'").run(new Date().toISOString(), result.enrollmentId);
        if (Number(changed.changes) !== 1) throw new Error('lifecycle_state_not_persisted');
        lifecycleAudit(db, { enrollmentId: result.enrollmentId, ownerId: actorId, fromState: 'permit_validated', toState: 'permit_stored', reason });
        if (!withinTransaction) db.exec('COMMIT'); return { ...result, state: 'permit_stored' };
      } catch (error) { if (!withinTransaction) db.exec('ROLLBACK'); throw error; }
    },
    armWalletProtectionEnrollment(permit, { actorId, reason, now = new Date().toISOString(), withinTransaction = false }) {
      const ownerId = required(actorId, 'actorId'); required(reason, 'reason');
      const row = db.prepare('SELECT state,enrollment_id,wallet_id FROM protection_enrollments WHERE enrollment_id=? AND owner_id=?').get(permit.enrollmentId, ownerId);
      if (!row) throw new Error('enrollment_not_found');
      if (row.state === 'armed') {
        this.validateWalletProtectionPermit(permit, { actorId: ownerId, withinTransaction });
        return { enrollmentId: row.enrollment_id, walletId: row.wallet_id, state: 'armed' };
      }
      if (row.state !== 'permit_stored') throw new Error('attestation_required');
      if (typeof permit.expiresAt !== 'string' || permit.expiresAt <= now) throw new Error('permit_expired');
      this.validateWalletProtectionPermit(permit, { actorId: ownerId, withinTransaction });
      if (!withinTransaction) db.exec('BEGIN IMMEDIATE');
      try {
        const changed = db.prepare("UPDATE protection_enrollments SET state='armed',updated_at=? WHERE enrollment_id=? AND owner_id=? AND state='permit_stored'").run(now, row.enrollment_id, ownerId);
        if (Number(changed.changes) !== 1) throw new Error('concurrent_lifecycle_conflict');
        lifecycleAudit(db, { enrollmentId: row.enrollment_id, ownerId, fromState: 'permit_stored', toState: 'armed', reason });
        audit(db, { actorId: ownerId, action: 'wallet_protection.armed', entityType: 'protection_enrollment', entityId: row.enrollment_id, reason, before: { state: 'permit_stored' }, after: { state: 'armed' } });
        if (testHooks.afterLifecycleMutation) testHooks.afterLifecycleMutation();
        if (!withinTransaction) db.exec('COMMIT');
        return { enrollmentId: row.enrollment_id, walletId: row.wallet_id, state: 'armed' };
      } catch (error) { if (!withinTransaction) db.exec('ROLLBACK'); throw error; }
    },
    transitionWalletProtectionEnrollment(enrollmentId, { actorId, toState, reason, withinTransaction = false }) {
      const ownerId = required(actorId, 'actorId'); required(reason, 'reason'); required(enrollmentId, 'enrollmentId');
      const legal = { setup_incomplete: new Set(['revoked']), permit_validated: new Set(['revoked']), permit_stored: new Set(['revoked']), armed: new Set(['revoked','expired','inactive_position_absent']) };
      if (!withinTransaction) db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT enrollment_id,wallet_id,owner_id,state FROM protection_enrollments WHERE (enrollment_id=? OR wallet_id=?) AND owner_id=?').get(enrollmentId, enrollmentId, ownerId);
        if (!row) throw new Error('enrollment_not_found');
        if (!legal[row.state]?.has(toState)) throw new Error('illegal_lifecycle_transition');
        const changed = db.prepare('UPDATE protection_enrollments SET state=?,updated_at=? WHERE enrollment_id=? AND owner_id=? AND state=?').run(toState, new Date().toISOString(), row.enrollment_id, ownerId, row.state);
        if (Number(changed.changes) !== 1) throw new Error('lifecycle_state_not_persisted');
        db.prepare('INSERT INTO wallet_protection_lifecycle_audit (audit_id,enrollment_id,owner_id,from_state,to_state,reason,occurred_at) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), row.enrollment_id, ownerId, row.state, toState, reason, new Date().toISOString());
        if (!withinTransaction) db.exec('COMMIT'); return { enrollmentId: row.enrollment_id, walletId: row.wallet_id, state: toState };
      } catch (error) { if (!withinTransaction) db.exec('ROLLBACK'); throw error; }
    },
    createWallet(input) {
      const row = { walletId: required(input.walletId, 'walletId'), status: 'active' };
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`INSERT INTO wallets (wallet_id,status) VALUES (?,?)`).run(row.walletId, row.status);
        audit(db, { ...input, action: 'wallet.created', entityType: 'wallet', entityId: row.walletId, after: row });
        db.exec('COMMIT'); return row;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    enrollWallet() { throw new Error('canonical eligible-position reconciliation required'); },
    listWalletEnrollments(walletId) {
      return db.prepare(`SELECT wallet_id,position_id,target_id,network,source,subject_id,status,created_at,updated_at FROM wallet_enrollments WHERE wallet_id=? ORDER BY target_id`).all(walletId)
        .map(row => ({ walletId:row.wallet_id,positionId:row.position_id,targetId:row.target_id,network:row.network,source:row.source,subjectId:row.subject_id,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at }));
    },
    reconcileEligiblePositionEnrollments(input) {
      const walletId=required(input.walletId,'walletId'),network=required(input.network,'network'),actorId=required(input.actorId,'actorId');
      if(input.source!=='eligible-position'||!Array.isArray(input.positions))throw new TypeError('eligible position reconciliation invalid');
      const now=new Date().toISOString(),seen=new Set();
      const normalized=input.positions.map(position=>{const positionId=required(position?.positionId,'positionId'),targetId=required(position?.targetId,'targetId'),positionNetwork=required(position?.network,'network'),subjectId=required(position?.subjectId,'subjectId');if(positionId!==targetId||positionNetwork!==network||seen.has(positionId))throw new TypeError('eligible position mapping invalid');seen.add(positionId);const target=db.prepare(`SELECT t.status,r.network FROM targets t JOIN target_registry r ON r.target_id=t.id WHERE t.id=?`).get(targetId);if(!target||target.network!==network)throw new Error('verified_target_not_active');return{positionId,targetId,subjectId}});
      db.exec('BEGIN IMMEDIATE');try{db.prepare(`INSERT INTO wallets(wallet_id,status) VALUES(?,'active') ON CONFLICT(wallet_id) DO UPDATE SET status='active'`).run(walletId);for(const row of normalized)db.prepare(`INSERT INTO wallet_enrollments(wallet_id,position_id,target_id,network,source,subject_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'active',?,?) ON CONFLICT(wallet_id,position_id) DO UPDATE SET target_id=excluded.target_id,network=excluded.network,source=excluded.source,subject_id=excluded.subject_id,status='active',updated_at=excluded.updated_at`).run(walletId,row.positionId,row.targetId,network,'eligible-position',row.subjectId,now,now);const active=[...seen];if(active.length)db.prepare(`UPDATE wallet_enrollments SET status='inactive',updated_at=? WHERE wallet_id=? AND network=? AND source='eligible-position' AND position_id NOT IN (${active.map(()=>'?').join(',')}) AND status='active'`).run(now,walletId,network,...active);else db.prepare(`UPDATE wallet_enrollments SET status='inactive',updated_at=? WHERE wallet_id=? AND network=? AND source='eligible-position' AND status='active'`).run(now,walletId,network);db.exec('COMMIT');return this.listWalletEnrollments(walletId)}catch(error){db.exec('ROLLBACK');throw error}
    },
    getTargetPolicy(targetId) {
      const active = db.prepare(`SELECT revision,snapshot_json FROM configuration_revisions ORDER BY revision DESC LIMIT 1`).get();
      if (!active) return null;
      const snapshot = JSON.parse(active.snapshot_json);
      const target = snapshot.targets.find(item => item.id === targetId);
      if (!target) return null;
      const bindings = snapshot.bindings.filter(binding => binding.targetId === targetId).map(binding => {
        const ruleVersion = snapshot.ruleVersions.find(version => version.ruleId === binding.ruleId && version.version === binding.ruleVersion);
        if (!ruleVersion) throw new Error(`invalid_snapshot_missing_rule_version:${binding.ruleId}@${binding.ruleVersion}`);
        return { ...binding, ruleVersion };
      });
      return { revision: Number(active.revision), target, bindings };
    },
    validateDraftWithinTransaction(input) {
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      const manifest = draftManifest(input);
      validateActivationGraph(db, manifest);
      audit(db, { ...input, action: 'configuration.validated', entityType: 'configuration_draft', entityId: hash(manifest), after: { valid: true, manifest } });
      return { valid: true };
    },
    suspendWalletWithinTransaction(input) {
      const walletId = required(input.walletId, 'walletId');
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      const wallet = db.prepare('SELECT wallet_id,status FROM wallets WHERE wallet_id=?').get(walletId);
      if (!wallet) throw new Error('wallet_not_found');
      if (wallet.status !== 'active') throw new Error('wallet_not_active');
      db.prepare("UPDATE wallets SET status='suspended' WHERE wallet_id=? AND status='active'").run(walletId);
      db.prepare("UPDATE wallet_enrollments SET status='suspended' WHERE wallet_id=? AND status='active'").run(walletId);
      const row = { walletId, status: 'suspended' };
      audit(db, { ...input, action: 'wallet.suspended', entityType: 'wallet', entityId: walletId, before: wallet, after: row });
      return row;
    },
    activateDraft(input) {
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      const manifest = draftManifest(input);
      db.exec('BEGIN IMMEDIATE');
      try {
        validateActivationGraph(db, manifest);
        promoteDraft(db, manifest);
        const snapshot = readSnapshot(db);
        const snapshotJson = JSON.stringify(snapshot);
        const result = db.prepare(`INSERT INTO configuration_revisions (snapshot_json,content_hash,activated_at) VALUES (?,?,?)`)
          .run(snapshotJson, hash(snapshot), new Date().toISOString());
        const revision = Number(result.lastInsertRowid);
        audit(db, { ...input, action: 'configuration.activated', entityType: 'configuration_revision', entityId: String(revision), after: { revision, snapshot } });
        db.exec('COMMIT'); return { revision, snapshot };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    activateDraftReplacing(input) {
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      const manifest = draftManifest(input);
      const retiredTargetIds = input.retiredTargetIds ?? [], retiredBindingIds = input.retiredBindingIds ?? [];
      for (const [name, values] of Object.entries({ retiredTargetIds, retiredBindingIds })) if (!Array.isArray(values) || new Set(values).size !== values.length || values.some(value => typeof value !== 'string' || value.trim() === '')) throw new TypeError(`${name} is invalid`);
      db.exec('BEGIN IMMEDIATE');
      try {
        validateActivationGraph(db, manifest);
        promoteDraft(db, manifest);
        for (const bindingId of retiredBindingIds) {
          const changed = db.prepare("UPDATE rule_bindings SET status='retired' WHERE id=? AND status='active'").run(bindingId);
          if (Number(changed.changes) !== 1) throw new Error(`replacement_binding_not_active:${bindingId}`);
        }
        for (const targetId of retiredTargetIds) {
          const stillActive = db.prepare("SELECT id FROM rule_bindings WHERE target_id=? AND status='active' LIMIT 1").get(targetId);
          if (stillActive) throw new Error(`replacement_target_still_bound:${targetId}`);
          const changed = db.prepare("UPDATE targets SET status='retired' WHERE id=? AND status='active'").run(targetId);
          if (Number(changed.changes) !== 1) throw new Error(`replacement_target_not_active:${targetId}`);
        }
        const snapshot = readSnapshot(db), snapshotJson = JSON.stringify(snapshot);
        const result = db.prepare(`INSERT INTO configuration_revisions (snapshot_json,content_hash,activated_at) VALUES (?,?,?)`).run(snapshotJson, hash(snapshot), new Date().toISOString());
        const revision = Number(result.lastInsertRowid);
        audit(db, { ...input, action: 'configuration.replaced', entityType: 'configuration_revision', entityId: String(revision), after: { revision, snapshot, retiredTargetIds, retiredBindingIds } });
        db.exec('COMMIT'); return { revision, snapshot };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    getActiveSnapshot() {
      const row = db.prepare(`SELECT revision,snapshot_json FROM configuration_revisions ORDER BY revision DESC LIMIT 1`).get();
      return row ? { revision: Number(row.revision), snapshot: JSON.parse(row.snapshot_json) } : null;
    },
    getDiscoveryManifest() {
      const active = this.getActiveSnapshot();
      if (!active) return null;
      const usableProtocols = active.snapshot.protocols.filter(protocol =>
        protocol.status === 'active' && protocol.discoveryAdapterId !== LEGACY_DISCOVERY_ADAPTER_ID &&
        adapterRegistry !== null && adapterRegistry.get(protocol.discoveryAdapterId) === protocol.discoveryAdapterVersion
      );
      const protocolIds = new Set(usableProtocols.map(protocol => protocol.id));
      return {
        policyRevision: active.revision,
        protocols: usableProtocols.map(({ id, name, chain, status, discoveryAdapterId, discoveryAdapterVersion }) => ({ id, name, chain, status, discoveryAdapterId, discoveryAdapterVersion })),
        targets: active.snapshot.targets
          .filter(target => target.status === 'active' && protocolIds.has(target.protocolId))
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(target => this.projectTarget(target))
      };
    },
    getBatchPolicy(targetIds) {
      const active = this.getActiveSnapshot();
      if (!active) return null;
      const requested = new Set(targetIds);
      const requestedCanonical = new Set(targetIds.map(targetId => this.resolveTarget(targetId)?.targetId ?? targetId));
      const targets = active.snapshot.targets
        .filter(target => requested.has(target.id) || requestedCanonical.has(this.resolveTarget(target.id)?.targetId))
        .sort((a, b) => a.id.localeCompare(b.id));
      if (targets.length !== requested.size || targets.some(target => target.status !== 'active')) return null;
      const targetSet = new Set(targets.map(target => target.id));
      const rawBindings = active.snapshot.bindings
        .filter(binding => targetSet.has(binding.targetId) && binding.status === 'active')
        .sort((a, b) => a.id.localeCompare(b.id));
      const protocolSet = new Set(targets.map(target => target.protocolId));
      const protocols = active.snapshot.protocols
        .filter(protocol => protocolSet.has(protocol.id) && protocol.status === 'active')
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(protocol => ({
          id: protocol.id, name: protocol.name, chain: protocol.chain, status: protocol.status,
          discoveryAdapterId: protocol.discoveryAdapterId,
          discoveryAdapterVersion: protocol.discoveryAdapterVersion,
          targetIds: targets.filter(target => target.protocolId === protocol.id).map(target => this.projectTarget(target).id)
        }));
      if (protocols.length !== protocolSet.size || protocols.some(protocol => typeof protocol.discoveryAdapterId !== 'string' || !Number.isInteger(protocol.discoveryAdapterVersion))) return null;
      const ruleSet = new Set(rawBindings.map(binding => `${binding.ruleId}:${binding.ruleVersion}`));
      const ruleVersions = active.snapshot.ruleVersions
        .filter(version => ruleSet.has(`${version.ruleId}:${version.version}`))
        .sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.version - b.version)
        .map(({ ruleId, version, evaluatorType, evaluatorVersion, evidenceSchema, contentHash }) => ({ ruleId, version, evaluatorType, evaluatorVersion, evidenceSchema, contentHash }));
      const ruleNames = new Map(active.snapshot.rules.map(rule => [rule.id, rule.name]));
      const bindings = rawBindings.map(binding => ({ bindingId: binding.id, targetId: this.projectTarget(targets.find(target => target.id === binding.targetId)).id, ruleId: binding.ruleId, ruleVersion: binding.ruleVersion, display: { name: ruleNames.get(binding.ruleId) } }));
      return { policyRevision: active.revision, protocols, targets: targets.map(target => this.projectTarget(target)), bindings, ruleVersions };
    },
    getIdempotentRequest(idempotencyKey, request) {
      const key = required(idempotencyKey, 'idempotencyKey');
      const requestHash = hash(request);
      const existing = db.prepare('SELECT request_hash,status_code,response_json FROM admin_requests WHERE idempotency_key=?').get(key);
      if (!existing) return null;
      if (existing.request_hash !== requestHash) throw new Error('idempotency_conflict');
      return { replay: true, statusCode: Number(existing.status_code), response: JSON.parse(existing.response_json) };
    },
    recordIdempotentRequest(idempotencyKey, request, result) {
      const key = required(idempotencyKey, 'idempotencyKey');
      const requestHash = hash(request);
      const responseJson = JSON.stringify(jsonSafe(result.response, 'response'));
      db.prepare('INSERT INTO admin_requests (idempotency_key,request_hash,status_code,response_json,created_at) VALUES (?,?,?,?,?)').run(key, requestHash, result.statusCode, responseJson, new Date().toISOString());
      return { replay: false, statusCode: result.statusCode, response: result.response };
    },
    executeAdminRequest({ idempotencyKey, request, execute }) {
      const key = required(idempotencyKey, 'idempotencyKey');
      if (key.length > 128) throw new TypeError('idempotencyKey is too long');
      const requestHash = hash(request);
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.prepare(`SELECT request_hash,status_code,response_json FROM admin_requests WHERE idempotency_key=?`).get(key);
        if (existing) {
          if (existing.request_hash !== requestHash) throw new Error('idempotency_conflict');
          db.exec('COMMIT');
          return { replay: true, statusCode: Number(existing.status_code), response: JSON.parse(existing.response_json) };
        }
        const result = execute();
        const responseJson = JSON.stringify(jsonSafe(result.response, 'response'));
        db.prepare(`INSERT INTO admin_requests (idempotency_key,request_hash,status_code,response_json,created_at) VALUES (?,?,?,?,?)`)
          .run(key, requestHash, result.statusCode, responseJson, new Date().toISOString());
        db.exec('COMMIT');
        return { replay: false, statusCode: result.statusCode, response: result.response };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    createProtocolWithinTransaction(input) {
      const metadata = discoveryMetadata(input.discoveryAdapterId, input.discoveryAdapterVersion);
      const row = { id: required(input.id, 'id'), name: required(input.name, 'name'), chain: required(input.chain, 'chain'), status: 'draft', discoveryAdapterId: metadata.id, discoveryAdapterVersion: metadata.version };
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      db.prepare('INSERT INTO protocols (id,name,chain,status,discovery_adapter_id,discovery_adapter_version) VALUES (?,?,?,?,?,?)').run(row.id, row.name, row.chain, row.status, row.discoveryAdapterId, row.discoveryAdapterVersion);
      audit(db, { ...input, action: 'protocol.created', entityType: 'protocol', entityId: row.id, after: row });
      return { id: row.id, name: row.name, chain: row.chain, status: row.status, ...(row.discoveryAdapterId === null ? {} : { discoveryAdapterId: row.discoveryAdapterId, discoveryAdapterVersion: row.discoveryAdapterVersion }) };
    },
    createTargetWithinTransaction(input) {
      const row = {
        id: required(input.id, 'id'), protocolId: required(input.protocolId, 'protocolId'), kind: required(input.kind, 'kind'),
        address: readerAddress(input.address), name: required(input.name, 'name'),
        secretRef: input.secretRef ? secretReference(input.secretRef) : null, status: 'draft'
      };
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      db.prepare(`INSERT INTO targets (id,protocol_id,kind,address,name,secret_ref,status) VALUES (?,?,?,?,?,?,?)`)
        .run(row.id, row.protocolId, row.kind, row.address, row.name, row.secretRef, row.status);
      if (row.id.includes(':')) {
        const identity = parseCanonicalTargetId(row.id);
        if (identity.protocolId !== row.protocolId || identity.resourceType !== row.kind || identity.address !== row.address) throw new TypeError('canonical_target_id');
        const network = required(input.network, 'network');
        if (identity.network !== network) throw new TypeError('canonical_target_id');
        db.prepare(`INSERT INTO target_registry (target_id,chain,network,protocol_id,resource_type,address,display_name) VALUES (?,?,?,?,?,?,?)`)
          .run(row.id, identity.chain, network, row.protocolId, row.kind, row.address, row.name);
      }
      audit(db, { ...input, action: 'target.created', entityType: 'target', entityId: row.id, after: row });
      return row;
    },
    createRuleDefinitionWithinTransaction(input) {
      const row = { id: required(input.id, 'id'), name: required(input.name, 'name'), evaluatorType: required(input.evaluatorType, 'evaluatorType') };
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      db.prepare('INSERT INTO rule_definitions (id,name,evaluator_type) VALUES (?,?,?)').run(row.id, row.name, row.evaluatorType);
      audit(db, { ...input, action: 'rule.created', entityType: 'rule', entityId: row.id, after: row });
      return row;
    },
    createRuleVersionWithinTransaction(input) {
      const version = Number(input.version);
      if (!Number.isInteger(version) || version < 1) throw new TypeError('version must be a positive integer');
      if (!input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters)) throw new TypeError('parameters must be a JSON-safe object');
      const content = {
        ruleId: required(input.ruleId, 'ruleId'), version,
        evaluatorVersion: required(input.evaluatorVersion, 'evaluatorVersion'),
        parameters: jsonSafe(input.parameters), evidenceSchema: required(input.evidenceSchema, 'evidenceSchema')
      };
      const row = { ...content, contentHash: hash(content) };
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      db.prepare(`INSERT INTO rule_versions (rule_id,version,evaluator_version,parameters_json,evidence_schema,content_hash) VALUES (?,?,?,?,?,?)`)
        .run(row.ruleId, row.version, row.evaluatorVersion, JSON.stringify(row.parameters), row.evidenceSchema, row.contentHash);
      audit(db, { ...input, action: 'rule_version.created', entityType: 'rule_version', entityId: `${row.ruleId}@${row.version}`, after: row });
      return row;
    },
    createBindingWithinTransaction(input) {
      const row = { id: required(input.id, 'id'), ruleId: required(input.ruleId, 'ruleId'), ruleVersion: Number(input.ruleVersion), targetId: required(input.targetId, 'targetId'), status: 'draft' };
      if (!Number.isInteger(row.ruleVersion) || row.ruleVersion < 1) throw new TypeError('ruleVersion must be a positive integer');
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      db.prepare(`INSERT INTO rule_bindings (id,rule_id,rule_version,target_id,status) VALUES (?,?,?,?,?)`).run(row.id, row.ruleId, row.ruleVersion, row.targetId, row.status);
      audit(db, { ...input, action: 'binding.created', entityType: 'binding', entityId: row.id, after: row });
      return row;
    },
    createPolicyRuleWithinTransaction(input) {
      const rootKeys = ['protocol', 'target', 'rule', 'ruleVersion', 'binding', 'actorId', 'reason'];
      const shape = (value, name, keys) => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError(`${name} fields are invalid`);
        return value;
      };
      if (!input || typeof input !== 'object' || Object.keys(input).some(key => !rootKeys.includes(key))) throw new TypeError('policy slice fields are invalid');
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      const protocol = shape(input.protocol, 'protocol', ['id', 'name', 'chain', 'discoveryAdapterId', 'discoveryAdapterVersion']);
      const target = shape(input.target, 'target', ['id', 'protocolId', 'kind', 'address', 'name', 'secretRef']);
      const rule = shape(input.rule, 'rule', ['id', 'name', 'evaluatorType']);
      const ruleVersion = shape(input.ruleVersion, 'ruleVersion', ['ruleId', 'version', 'evaluatorVersion', 'parameters', 'evidenceSchema']);
      const binding = shape(input.binding, 'binding', ['id', 'ruleId', 'ruleVersion', 'targetId']);
      if (target.protocolId !== protocol.id || ruleVersion.ruleId !== rule.id || binding.ruleId !== rule.id || Number(binding.ruleVersion) !== Number(ruleVersion.version) || binding.targetId !== target.id) throw new TypeError('policy_slice_reference_mismatch');
      db.exec('SAVEPOINT policy_rule_slice');
      try {
        const shared = { actorId: input.actorId, reason: input.reason };
        const result = {
          protocol: this.createProtocolWithinTransaction({ ...protocol, ...shared }),
          target: this.createTargetWithinTransaction({ ...target, ...shared }),
          rule: this.createRuleDefinitionWithinTransaction({ ...rule, ...shared }),
          ruleVersion: this.createRuleVersionWithinTransaction({ ...ruleVersion, ...shared }),
          binding: this.createBindingWithinTransaction({ ...binding, ...shared })
        };
        db.exec('RELEASE SAVEPOINT policy_rule_slice');
        return result;
      } catch (error) {
        db.exec('ROLLBACK TO SAVEPOINT policy_rule_slice');
        db.exec('RELEASE SAVEPOINT policy_rule_slice');
        throw error;
      }
    },
    createWalletWithinTransaction(input) {
      const row = { walletId: required(input.walletId, 'walletId'), status: 'active' };
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      db.prepare(`INSERT INTO wallets (wallet_id,status) VALUES (?,?)`).run(row.walletId, row.status);
      audit(db, { ...input, action: 'wallet.created', entityType: 'wallet', entityId: row.walletId, after: row });
      return row;
    },
    activateDraftWithinTransaction(input) {
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      const manifest = draftManifest(input);
      validateActivationGraph(db, manifest);
      promoteDraft(db, manifest);
      const snapshot = readSnapshot(db);
      const result = db.prepare(`INSERT INTO configuration_revisions (snapshot_json,content_hash,activated_at) VALUES (?,?,?)`)
        .run(JSON.stringify(snapshot), hash(snapshot), new Date().toISOString());
      const revision = Number(result.lastInsertRowid);
      audit(db, { ...input, action: 'configuration.activated', entityType: 'configuration_revision', entityId: String(revision), after: { revision, snapshot } });
      return { revision, snapshot };
    },
    enrollWalletWithinTransaction() { throw new Error('canonical eligible-position reconciliation required'); },
    storePreflightReceipt(receipt) {
      if (!receipt?.receiptId || receipt.valid !== true) throw new TypeError('valid preflight receipt is required');
      const facts = receipt.provenance?.facts ?? {};
      const digest = receipt.provenance?.digest ?? hash(facts);
      if (typeof digest !== 'string' || hash(facts) !== digest) throw new Error('preflight_receipt_facts_invalid');
      const issuedAt = receipt.issuedAt ?? new Date(Date.now() - 1).toISOString();
      const row = { receiptId: receipt.receiptId, targetId: receipt.targetId, identity: receipt.identity, factsJson: JSON.stringify(jsonSafe(facts)), factsDigest: digest, issuedAt, expiresAt: receipt.expiresAt };
      const existing = db.prepare('SELECT target_id,identity,facts_json,facts_digest,issued_at,expires_at FROM preflight_receipts WHERE receipt_id=?').get(row.receiptId);
      if (existing) {
        const same = existing.target_id === row.targetId && existing.identity === row.identity && existing.facts_json === row.factsJson && existing.facts_digest === row.factsDigest && existing.issued_at === row.issuedAt && existing.expires_at === row.expiresAt;
        if (!same) throw new Error('preflight_receipt_conflict');
        return { receiptId: row.receiptId, targetId: row.targetId, valid: true, expiresAt: row.expiresAt };
      }
      db.prepare('INSERT INTO preflight_receipts(receipt_id,target_id,identity,facts_json,facts_digest,issued_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(row.receiptId,row.targetId,row.identity,row.factsJson,row.factsDigest,row.issuedAt,row.expiresAt);
      return { receiptId: row.receiptId, targetId: row.targetId, valid: true, expiresAt: row.expiresAt };
    },
    createOnboardingProposal(input) {
      const fields = ['proposalId','targetId','indexerId','chain','network','protocol','kind','address','display','ruleBindings','preflightReceiptId'];
      for (const field of fields) if (input[field] === undefined) throw new TypeError(`${field} is required`);
      const metadataFields = ['tokenMint','sharesMint','discoveryAdapter','metricsAdapter'];
      if (input.protocol === 'kamino' && input.kind === 'kvault') for (const field of metadataFields) if (input[field] === undefined) throw new TypeError(`${field} is required`);
      const allowedFields = new Set(['proposalId','targetId','indexerId','chain','network','protocol','kind','address','display','tokenMint','sharesMint','discoveryAdapter','metricsAdapter','ruleBindings','preflightReceiptId','actorId','reason']);
      if (Object.keys(input).some(field => !allowedFields.has(field))) throw new TypeError('onboarding fields are invalid');
      if (Object.hasOwn(input, 'preflight') || Object.hasOwn(input, 'expectedOwner') || Object.hasOwn(input, 'decoderFamily') || Object.hasOwn(input, 'decoderVersion')) throw new TypeError('client preflight facts are forbidden');
      const receipt = db.prepare('SELECT * FROM preflight_receipts WHERE receipt_id=?').get(input.preflightReceiptId);
      if (!receipt || Date.parse(receipt.expires_at) <= Date.now()) throw new Error('preflight_receipt_invalid_or_stale');
      if (receipt.target_id !== input.targetId || receipt.identity !== [input.chain,input.network,input.protocol,input.kind,input.address].join(':')) throw new Error('preflight_receipt_identity_mismatch');
      if (hash(JSON.parse(receipt.facts_json)) !== receipt.facts_digest) throw new Error('preflight_receipt_tampered');
      if (receipt.consumed_proposal_id && receipt.consumed_proposal_id !== input.proposalId) throw new Error('preflight_receipt_reused');
      if (input.protocol === 'kamino' && input.kind === 'kvault') {
        const facts = JSON.parse(receipt.facts_json);
        if (input.network !== 'mainnet-beta') throw new Error('unsupported_kamino_network');
        let canonical;
        try { canonical = parseCanonicalTargetId(input.targetId); } catch { throw new Error('canonical_target_id'); }
        if (canonical.chain !== input.chain || canonical.network !== input.network || canonical.protocolId !== input.protocol || canonical.resourceType !== input.kind || canonical.address !== input.address) throw new Error('canonical_target_components_mismatch');
        try { parseCanonicalTargetId(`solana:mainnet-beta:mint:token:${input.tokenMint}`); parseCanonicalTargetId(`solana:mainnet-beta:mint:share:${input.sharesMint}`); } catch { throw new Error('kamino_mint_address_invalid'); }
        validateKaminoKvaultProfile(input);
        if (typeof input.tokenMint !== 'string' || input.tokenMint !== facts.tokenMint) throw new Error('kamino_token_mint_invalid');
        if (typeof input.sharesMint !== 'string' || input.sharesMint.trim() === '' || facts.sharesMint !== input.sharesMint) throw new Error('kamino_shares_mint_invalid');
        for (const [name, expected] of [['discoveryAdapter', 'kamino-kvault-discovery@1'], ['metricsAdapter', 'kamino-kvault-metrics@1']]) {
          const value = input[name];
          if (!value || `${value.id}@${value.version}` !== expected) throw new Error(`${name}_reference_invalid`);
        }
      }
      const fieldsWithoutReceipt = ['proposalId','targetId','indexerId','chain','network','protocol','kind','address','display','ruleBindings'];
      for (const field of fieldsWithoutReceipt) if (input[field] === undefined) throw new TypeError(`${field} is required`);
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      if (!Array.isArray(input.ruleBindings) || input.ruleBindings.length === 0) throw new TypeError('ruleBindings is required');
      const payloadFields = input.protocol === 'kamino' && input.kind === 'kvault' ? [...fields, ...metadataFields] : fields;
      const payload = Object.fromEntries(payloadFields.map(field => [field, jsonSafe(input[field], field)]));
      const payloadHash = hash(payload); const now = new Date().toISOString();
      const existing = db.prepare('SELECT payload_hash,payload_json,status FROM onboarding_proposals WHERE proposal_id=?').get(payload.proposalId);
      if (existing) { if (existing.payload_hash !== payloadHash) throw new Error('onboarding_proposal_conflict'); return { ...payload, status: existing.status }; }
      db.exec('SAVEPOINT onboarding_proposal');
      try {
        db.prepare('INSERT INTO onboarding_proposals(proposal_id,target_id,payload_json,payload_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(payload.proposalId, payload.targetId, JSON.stringify(payload), payloadHash, 'draft', now, now);
        const consumed = db.prepare('UPDATE preflight_receipts SET consumed_proposal_id=? WHERE receipt_id=? AND consumed_proposal_id IS NULL').run(payload.proposalId, payload.preflightReceiptId);
        if (Number(consumed.changes) !== 1) throw new Error('preflight_receipt_concurrent_conflict');
        if (testHooks.afterOnboardingProposalInsert) testHooks.afterOnboardingProposalInsert();
        audit(db, { ...input, action: 'onboarding_proposal.created', entityType: 'onboarding_proposal', entityId: payload.proposalId, after: payload });
        db.exec('RELEASE SAVEPOINT onboarding_proposal');
        return { ...payload, status: 'draft' };
      } catch (error) { db.exec('ROLLBACK TO SAVEPOINT onboarding_proposal'); db.exec('RELEASE SAVEPOINT onboarding_proposal'); throw error; }
    },
    validateOnboardingProposal(proposalId, input) {
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      const row = db.prepare('SELECT payload_json,status FROM onboarding_proposals WHERE proposal_id=?').get(required(proposalId, 'proposalId'));
      if (!row) throw new Error('onboarding_proposal_not_found');
      const payload = JSON.parse(row.payload_json);
      const receipt = db.prepare('SELECT * FROM preflight_receipts WHERE receipt_id=?').get(payload.preflightReceiptId);
      if (!receipt || Date.parse(receipt.expires_at) <= Date.now() || receipt.consumed_proposal_id !== proposalId) throw new Error('preflight_receipt_invalid_or_stale');
      if (hash(JSON.parse(receipt.facts_json)) !== receipt.facts_digest) throw new Error('preflight_receipt_tampered');
      db.prepare("UPDATE onboarding_proposals SET status='validated',updated_at=? WHERE proposal_id=? AND status='draft'").run(new Date().toISOString(), proposalId);
      audit(db, { ...input, action: 'onboarding_proposal.validated', entityType: 'onboarding_proposal', entityId: proposalId, after: { valid: true } });
      return { valid: true, proposalId };
    },
    getOnboardingProjection(targetId) {
      const target = db.prepare(`SELECT t.id,t.protocol_id,t.kind,t.address,t.name,t.status,p.id protocol_id,p.name protocol_name,p.chain,p.status protocol_status FROM targets t JOIN protocols p ON p.id=t.protocol_id WHERE t.id=?`).get(targetId);
      if (!target) return null;
      const bindings = db.prepare(`SELECT id,rule_id,rule_version,status FROM rule_bindings WHERE target_id=? ORDER BY id`).all(targetId).map(row => ({ id: row.id, ruleId: row.rule_id, version: row.rule_version, status: row.status }));
      const assignment = db.prepare(`SELECT acknowledged_at FROM assignment_outbox WHERE proposal_id=(SELECT proposal_id FROM onboarding_proposals WHERE target_id=? ) ORDER BY created_at DESC LIMIT 1`).get(targetId);
      const evidence = db.prepare('SELECT cursor,first_observation_at,tvl_json,required_receipts_json FROM onboarding_evidence WHERE target_id=?').get(targetId);
      const receipts = evidence ? JSON.parse(evidence.required_receipts_json) : [];
      const assignmentAccepted = Boolean(assignment?.acknowledged_at);
      const firstObservation = Boolean(evidence?.cursor && evidence?.first_observation_at);
      const tvl = evidence?.tvl_json ? JSON.parse(evidence.tvl_json) : null;
      const activeBindingIds = bindings.filter(binding => binding.status === 'active').map(binding => binding.id);
      const requiredReceipts = receipts.length > 0 && receipts.every(receipt => receipt && typeof receipt === 'object' && typeof receipt.receiptId === 'string' && typeof receipt.bindingId === 'string') && activeBindingIds.every(bindingId => receipts.some(receipt => receipt.bindingId === bindingId));
      const ready = assignmentAccepted && firstObservation && tvl !== null && requiredReceipts;
      const capabilities = db.prepare('SELECT token_mint,shares_mint,discovery_adapter_id,discovery_adapter_version,metrics_adapter_id,metrics_adapter_version FROM target_capabilities WHERE target_id=?').get(targetId);
      return { protocol: { id: target.protocol_id, name: target.protocol_name, chain: target.chain, status: target.protocol_status }, target: { id: target.id, kind: target.kind, address: target.address, name: target.name, status: target.status }, capabilities: capabilities ? { tokenMint: capabilities.token_mint, sharesMint: capabilities.shares_mint, discoveryAdapter: { id: capabilities.discovery_adapter_id, version: capabilities.discovery_adapter_version }, metricsAdapter: { id: capabilities.metrics_adapter_id, version: capabilities.metrics_adapter_version } } : null, ruleBindings: bindings, readiness: { status: ready ? 'ready' : 'provisioning', assignmentAccepted, firstObservation, tvl, requiredReceipts } };
    },
    getSupportedPositions(network) {
      if (!['mainnet-beta', 'devnet'].includes(network)) throw new Error('unsupported_network');
      const rows = db.prepare(`SELECT t.id target_id,r.chain,r.network,r.protocol_id,r.resource_type,r.address,r.display_name,r.strategy,r.protocol_url,r.protocol_icon_key,r.token_icon_key,r.token_symbol,r.catalog_tvl_usd,
        c.token_mint,c.shares_mint,c.discovery_adapter_id,c.discovery_adapter_version,c.metrics_adapter_id,c.metrics_adapter_version,
        p.status proposal_status
        FROM onboarding_proposals p JOIN targets t ON t.id=p.target_id
        JOIN target_registry r ON r.target_id=t.id JOIN target_capabilities c ON c.target_id=t.id
        WHERE r.network=? AND p.status IN ('provisioning','activated') AND t.status='active'
        ORDER BY t.id`).all(network);
      return { network, positions: rows.map(row => {
        const projection = this.getOnboardingProjection(row.target_id);
        const readiness = projection?.readiness ?? {};
        const monitoringState = readiness.status === 'ready' ? 'ready' : readiness.firstObservation || readiness.tvl !== null ? 'degraded' : 'provisioning';
        const activeRuleCount = projection?.ruleBindings.filter(binding => binding.status === 'active').length ?? 0;
        const tvl = readiness.tvl;
        let serializedTvl = { state: 'unavailable', value: null, currency: 'USD', observedAt: null, source: `${row.metrics_adapter_id}@${row.metrics_adapter_version}` };
        if (tvl !== null) {
          const age = Date.now() - Date.parse(tvl.observedAt);
          const stale = projection.ruleBindings.some(binding => {
            const rule = db.prepare('SELECT parameters_json FROM rule_versions WHERE rule_id=? AND version=?').get(binding.ruleId, binding.version);
            return rule && Date.now() - Date.parse(tvl.observedAt) > JSON.parse(rule.parameters_json).maximumAgeMs;
          });
          serializedTvl = { state: stale ? 'stale' : 'current', value: tvl.value, currency: 'USD', observedAt: tvl.observedAt, source: `${row.metrics_adapter_id}@${row.metrics_adapter_version}` };
        }
        return {
          targetId: row.target_id, chain: row.chain, network: row.network, protocolId: row.protocol_id,
          resourceType: row.resource_type, address: row.address, displayName: row.display_name,
          strategy: row.strategy, protocolUrl: row.protocol_url, protocolIconKey: row.protocol_icon_key,
          token: { mint: row.token_mint, symbol: row.token_symbol, iconKey: row.token_icon_key }, shareMint: row.shares_mint,
          metricsAdapter: { id: row.metrics_adapter_id, version: row.metrics_adapter_version },
          monitoring: { state: monitoringState, activeRuleCount }, tvl: { state: 'current', value: row.catalog_tvl_usd, currency: 'USD', observedAt: '2026-10-10T00:00:00.000Z', source: 'catalog-fixed' }
        };
      }) };
    },
    recordOnboardingEvidence(targetId, input, { actorId = 'evidence-ingest', reason = 'onboarding evidence received' } = {}) {
      required(targetId, 'targetId');
      if (!input || typeof input !== 'object') throw new TypeError('evidence is required');
      const allowedFields = ['cursor', 'firstObservationAt', 'tvl', 'requiredReceipts'];
      if (Object.keys(input).some(key => !allowedFields.includes(key))) throw new TypeError('evidence fields are invalid');
      const target = db.prepare(`SELECT t.status,c.metrics_adapter_id,c.metrics_adapter_version FROM targets t LEFT JOIN target_capabilities c ON c.target_id=t.id WHERE t.id=?`).get(targetId);
      if (!target) throw new Error('target_not_found');
      if (target.status !== 'active') throw new Error('target_not_active');
      const existing = db.prepare('SELECT cursor,first_observation_at,tvl_json,required_receipts_json FROM onboarding_evidence WHERE target_id=?').get(targetId);
      const prior = existing ? { cursor: existing.cursor, firstObservationAt: existing.first_observation_at, tvl: existing.tvl_json ? JSON.parse(existing.tvl_json) : null, requiredReceipts: JSON.parse(existing.required_receipts_json) } : { cursor: null, firstObservationAt: null, tvl: null, requiredReceipts: [] };
      const row = { cursor: input.cursor === undefined ? prior.cursor : input.cursor, firstObservationAt: input.firstObservationAt === undefined ? prior.firstObservationAt : input.firstObservationAt, tvl: input.tvl === undefined ? prior.tvl : jsonSafe(input.tvl), requiredReceipts: input.requiredReceipts === undefined ? prior.requiredReceipts : input.requiredReceipts };
      if (row.cursor !== null && (typeof row.cursor !== 'string' || row.cursor.length < 1 || row.cursor.length > 256)) throw new TypeError('cursor is invalid');
      if (prior.cursor !== null && input.cursor !== undefined && row.cursor < prior.cursor) throw new Error('cursor_regression');
      if (row.firstObservationAt !== null) {
        canonicalUtc(row.firstObservationAt, 'firstObservationAt');
        if (Date.parse(row.firstObservationAt) > Date.now()) throw new TypeError('firstObservationAt is in the future');
        if (prior.firstObservationAt && Date.parse(row.firstObservationAt) < Date.parse(prior.firstObservationAt)) throw new Error('firstObservationAt_regression');
        if (prior.tvl?.observedAt && Date.parse(row.firstObservationAt) < Date.parse(prior.tvl.observedAt)) throw new Error('tvl_observation_order');
      }
      if (!Array.isArray(row.requiredReceipts) || row.requiredReceipts.some(receipt => !receipt || typeof receipt !== 'object' || Array.isArray(receipt) || typeof receipt.receiptId !== 'string' || typeof receipt.bindingId !== 'string')) throw new TypeError('requiredReceipts are invalid');
      const activeBindingIds = db.prepare("SELECT id FROM rule_bindings WHERE target_id=? AND status='active' ORDER BY id").all(targetId).map(row => row.id);
      if (row.requiredReceipts.length !== new Set(row.requiredReceipts.map(receipt => receipt.receiptId)).size) throw new Error('receipt_id_reused');
      if (row.requiredReceipts.some(receipt => !activeBindingIds.includes(receipt.bindingId))) throw new Error('binding_mismatch');
      if (activeBindingIds.some(bindingId => !row.requiredReceipts.some(receipt => receipt.bindingId === bindingId))) throw new Error('missing_required_receipt');
      const submittedReceiptIds = new Set(row.requiredReceipts.map(receipt => receipt.receiptId));
      const priorSameTargetReceipts = prior.requiredReceipts;
      if (row.requiredReceipts.some(receipt => priorSameTargetReceipts.some(priorReceipt => priorReceipt.receiptId === receipt.receiptId && priorReceipt.bindingId !== receipt.bindingId))) throw new Error('receipt_id_reused');
      const priorReceiptOwner = db.prepare('SELECT target_id,required_receipts_json FROM onboarding_evidence WHERE target_id<>?').all(targetId).find(owner => JSON.parse(owner.required_receipts_json).some(receipt => submittedReceiptIds.has(receipt.receiptId)));
      if (priorReceiptOwner) throw new Error('receipt_id_reused');
      if (row.cursor === null && row.firstObservationAt !== null) throw new TypeError('observation cursor is required');
      if (row.tvl !== null) {
        if (!row.tvl || typeof row.tvl !== 'object' || Array.isArray(row.tvl) || Object.keys(row.tvl).some(key => !['value', 'currency', 'observedAt', 'source'].includes(key)) || typeof row.tvl.value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(row.tvl.value) || row.tvl.value === '0' || row.tvl.currency !== 'USD' || typeof row.tvl.source !== 'string' || row.tvl.source !== 'kamino-kvault-metrics@1') throw new TypeError('tvl is invalid');
        canonicalUtc(row.tvl.observedAt, 'tvl.observedAt');
        if (Date.parse(row.tvl.observedAt) > Date.now()) throw new TypeError('tvl.observedAt is in the future');
        if (target.metrics_adapter_id && row.tvl.source !== `${target.metrics_adapter_id}@${target.metrics_adapter_version}`) throw new TypeError('tvl source does not match target adapter');
        if (prior.tvl?.observedAt && Date.parse(row.tvl.observedAt) < Date.parse(prior.tvl.observedAt)) throw new Error('tvl_observedAt_regression');
      }
      db.exec('SAVEPOINT onboarding_evidence');
      try {
        db.prepare(`INSERT INTO onboarding_evidence(target_id,cursor,first_observation_at,tvl_json,required_receipts_json) VALUES(?,?,?,?,?) ON CONFLICT(target_id) DO UPDATE SET cursor=excluded.cursor,first_observation_at=excluded.first_observation_at,tvl_json=excluded.tvl_json,required_receipts_json=excluded.required_receipts_json`).run(targetId, row.cursor, row.firstObservationAt, row.tvl === null ? null : JSON.stringify(row.tvl), JSON.stringify(row.requiredReceipts));
        audit(db, { actorId, action: 'onboarding_evidence.recorded', entityType: 'onboarding_evidence', entityId: targetId, reason, after: row });
        db.exec('RELEASE SAVEPOINT onboarding_evidence');
      } catch (error) { db.exec('ROLLBACK TO SAVEPOINT onboarding_evidence'); db.exec('RELEASE SAVEPOINT onboarding_evidence'); throw error; }
      return this.getOnboardingProjection(targetId);
    },
    transitionOnboardingProposal(proposalId, status, eventType, input) {
      required(input.actorId, 'actorId'); required(input.reason, 'reason');
      db.exec('SAVEPOINT onboarding_transition');
      try {
        const row = db.prepare('SELECT payload_json,status FROM onboarding_proposals WHERE proposal_id=?').get(required(proposalId, 'proposalId'));
        if (!row) throw new Error('onboarding_proposal_not_found');
        if ((status === 'activated' && row.status === 'provisioning') || row.status === status) { db.exec('RELEASE SAVEPOINT onboarding_transition'); const payload = JSON.parse(row.payload_json); return { ...payload, status: row.status, readiness: this.getOnboardingProjection(payload.targetId)?.readiness ?? null }; }
        if (status === 'activated' && row.status !== 'validated') throw new Error('onboarding_proposal_not_validated');
        if (status !== 'activated' && !['activated','provisioning','paused'].includes(row.status)) throw new Error('invalid_onboarding_transition');
        const payload = JSON.parse(row.payload_json);
        if (status === 'activated' && payload.protocol === 'kamino' && payload.kind === 'kvault') {
          for (const binding of payload.ruleBindings) {
            const reviewed = db.prepare(`SELECT d.id,d.name,d.evaluator_type,v.evaluator_version,v.parameters_json,v.evidence_schema FROM rule_definitions d JOIN rule_versions v ON v.rule_id=d.id AND v.version=? WHERE d.id=?`).get(binding.version, binding.ruleId);
            const expected = KAMINO_KVAULT_PROFILE.mandatoryRules.find(rule => rule.ruleId === binding.ruleId && rule.version === Number(binding.version));
            const exact = reviewed && expected && reviewed.name === expected.name && reviewed.evaluator_type === expected.evaluatorType && reviewed.evaluator_version === expected.evaluatorVersion && reviewed.evidence_schema === expected.evidenceSchema && hash(JSON.parse(reviewed.parameters_json)) === hash(expected.parameters);
            if (!exact || binding.enabled !== true || binding.targetId !== payload.targetId) throw new Error('onboarding_rule_version_not_reviewed');
          }
          const protocolId = payload.protocol;
          db.prepare(`INSERT INTO protocols (id,name,chain,status,discovery_adapter_id,discovery_adapter_version) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status='active'`).run(protocolId, payload.protocol, payload.chain, 'active', payload.discoveryAdapter?.id ?? null, payload.discoveryAdapter?.version ?? null);
          db.prepare(`INSERT INTO targets (id,protocol_id,kind,address,name,status) VALUES (?,?,?,?,?,'active') ON CONFLICT(id) DO UPDATE SET status='active'`).run(payload.targetId, protocolId, payload.kind, payload.address, payload.display.name);
          db.prepare(`INSERT INTO target_registry (target_id,chain,network,protocol_id,resource_type,address,display_name) VALUES (?,?,?,?,?,?,?) ON CONFLICT(target_id) DO UPDATE SET display_name=excluded.display_name`).run(payload.targetId, payload.chain, payload.network, protocolId, payload.kind, payload.address, payload.display.name);
          db.prepare(`INSERT INTO target_capabilities (target_id,token_mint,shares_mint,discovery_adapter_id,discovery_adapter_version,metrics_adapter_id,metrics_adapter_version) VALUES (?,?,?,?,?,?,?) ON CONFLICT(target_id) DO UPDATE SET token_mint=excluded.token_mint,shares_mint=excluded.shares_mint,discovery_adapter_id=excluded.discovery_adapter_id,discovery_adapter_version=excluded.discovery_adapter_version,metrics_adapter_id=excluded.metrics_adapter_id,metrics_adapter_version=excluded.metrics_adapter_version`).run(payload.targetId, payload.tokenMint, payload.sharesMint, payload.discoveryAdapter.id, payload.discoveryAdapter.version, payload.metricsAdapter.id, payload.metricsAdapter.version);
          for (const binding of payload.ruleBindings) db.prepare(`INSERT INTO rule_bindings (id,rule_id,rule_version,target_id,status) VALUES (?,?,?,?, 'active') ON CONFLICT(id) DO UPDATE SET status='active'`).run(binding.id, binding.ruleId, binding.version, payload.targetId);
          if (testHooks.afterOnboardingGraphInsert) testHooks.afterOnboardingGraphInsert();
          const snapshot = readSnapshot(db);
          db.prepare(`INSERT INTO configuration_revisions (snapshot_json,content_hash,activated_at) VALUES (?,?,?)`).run(JSON.stringify(snapshot), hash(snapshot), new Date().toISOString());
          status = 'provisioning';
        }
        db.prepare('UPDATE onboarding_proposals SET status=?,updated_at=? WHERE proposal_id=?').run(status, new Date().toISOString(), proposalId);
        const payloadHash = hash(payload);
        db.prepare('INSERT INTO assignment_outbox(event_id,proposal_id,event_type,payload_json,payload_hash,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), proposalId, eventType, JSON.stringify(payload), payloadHash, new Date().toISOString());
        audit(db, { ...input, action: `onboarding_proposal.${status}`, entityType: 'onboarding_proposal', entityId: proposalId, after: { status } });
        db.exec('RELEASE SAVEPOINT onboarding_transition'); return { ...payload, status, readiness: this.getOnboardingProjection(payload.targetId)?.readiness ?? null };
      } catch (error) { db.exec('ROLLBACK TO SAVEPOINT onboarding_transition'); db.exec('RELEASE SAVEPOINT onboarding_transition'); throw error; }
    },
    activateOnboardingProposal(proposalId, input) { return this.transitionOnboardingProposal(proposalId, 'activated', 'assignment.activated', input); },
    pauseOnboardingProposal(proposalId, input) { return this.transitionOnboardingProposal(proposalId, 'paused', 'assignment.paused', input); },
    retireOnboardingProposal(proposalId, input) { return this.transitionOnboardingProposal(proposalId, 'retired', 'assignment.retired', input); },
    listAssignmentOutbox() { return db.prepare('SELECT event_id,proposal_id,event_type,payload_json,payload_hash,acknowledged_at,created_at FROM assignment_outbox ORDER BY created_at').all().map(row => ({ eventId: row.event_id, proposalId: row.proposal_id, eventType: row.event_type, payload: JSON.parse(row.payload_json), payloadHash: row.payload_hash, acknowledgedAt: row.acknowledged_at, createdAt: row.created_at })); },
    ackAssignmentOutbox(eventId) { const result = db.prepare('UPDATE assignment_outbox SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE event_id=?').run(new Date().toISOString(), eventId); return { acknowledged: result.changes === 1 }; },
    listWalletProtectionLifecycleAudit() {
      return db.prepare('SELECT enrollment_id,owner_id,from_state,to_state,payload_digest,reason,occurred_at FROM wallet_protection_lifecycle_audit ORDER BY sequence').all();
    },
    listAuditEvents() {
      return db.prepare(`SELECT id,actor_id,action,entity_type,entity_id,reason,before_hash,after_hash,occurred_at FROM audit_events ORDER BY sequence`).all().map(row => ({
        id: row.id, actorId: row.actor_id, action: row.action, entityType: row.entity_type, entityId: row.entity_id,
        reason: row.reason, beforeHash: row.before_hash, afterHash: row.after_hash, occurredAt: row.occurred_at
      }));
    },
    createAgentAccessRequest(input) {
      db.prepare(`INSERT INTO agent_access_requests (id,scopes_json,reason,duration_minutes,created_at,expires_at,status,retrieval_digest,exchange_digest,exchange_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.id, JSON.stringify(input.scopes), input.reason, input.durationMinutes, input.createdAt, input.expiresAt, 'pending', input.retrievalDigest, input.exchangeDigest, input.exchangeExpiresAt);
      audit(db, { actorId: input.actorId ?? 'agent', action: 'agent_access.requested', entityType: 'agent_access_request', entityId: input.id, reason: input.reason });
    },
    getAgentAccessRequest(id) { const row=db.prepare('SELECT * FROM agent_access_requests WHERE id=?').get(id); return row ? {...row, scopes:JSON.parse(row.scopes_json)} : null; },
    listAgentAccessRequests(now=Date.now()) { return db.prepare('SELECT id,scopes_json,reason,duration_minutes,created_at,expires_at,status,delivered_at FROM agent_access_requests WHERE expires_at>? ORDER BY created_at').all(now).map(row=>({requestId:row.id,scopes:JSON.parse(row.scopes_json),reason:row.reason,durationMinutes:row.duration_minutes,createdAt:row.created_at,expiresAt:row.expires_at,status:row.status,deliveredAt:row.delivered_at})); },
    approveAgentAccessRequest(id,input) { db.exec('BEGIN IMMEDIATE'); try { const at=input.now ?? Date.now(); const row=db.prepare("SELECT * FROM agent_access_requests WHERE id=? AND status='pending'").get(id); if(!row||row.expires_at<=at) throw new Error('request_unavailable'); db.prepare("UPDATE agent_access_requests SET status='approved' WHERE id=? AND status='pending'").run(id); audit(db,{actorId:input.actorId,action:'agent_access.approved',entityType:'agent_access_request',entityId:id,reason:'administrator approval'}); db.exec('COMMIT'); return {requestId:id,status:'approved',scopes:JSON.parse(row.scopes_json),reason:row.reason,durationMinutes:row.duration_minutes,expiresAt:new Date(row.expires_at).toISOString()}; } catch(e){db.exec('ROLLBACK');throw e;} },
    deliverAgentAccessExchange(id,retrievalDigest,now=Date.now()) { db.exec('BEGIN IMMEDIATE'); try { const row=db.prepare("SELECT * FROM agent_access_requests WHERE id=? AND status='approved' AND retrieval_digest=? AND expires_at>? AND exchange_expires_at>?").get(id,retrievalDigest,now,now); if(!row){db.exec('ROLLBACK');return null;} const exchangeSecret=row.exchange_digest; db.prepare("UPDATE agent_access_requests SET status='delivered',delivered_at=? WHERE id=? AND status='approved'").run(now,id); audit(db,{actorId:`agent:${id}`,action:'agent_access.delivered',entityType:'agent_access_request',entityId:id,reason:'one-time exchange delivery'}); db.exec('COMMIT'); return {requestId:id,scopes:JSON.parse(row.scopes_json),expiresAt:row.expires_at,exchangeSecret}; } catch(e){db.exec('ROLLBACK');throw e;} },
    exchangeAgentAccess(exchangeDigest,input) { db.exec('BEGIN IMMEDIATE'); try { const row=db.prepare("SELECT * FROM agent_access_requests WHERE status='delivered' AND exchange_digest=? AND exchange_expires_at>? AND expires_at>?").get(exchangeDigest,input.now,input.now); if(!row){db.exec('ROLLBACK');return null;} db.prepare("UPDATE agent_access_requests SET status='exchanged' WHERE id=? AND status='delivered'").run(row.id); db.prepare('INSERT INTO agent_access_sessions (token_digest,request_id,scopes_json,expires_at) VALUES (?,?,?,?)').run(input.tokenDigest,row.id,row.scopes_json,Math.min(row.expires_at,input.expiresAt)); audit(db,{actorId:`agent:${row.id}`,action:'agent_access.exchanged',entityType:'agent_access_request',entityId:row.id,reason:'one-time exchange consumed'}); db.exec('COMMIT'); return {requestId:row.id,scopes:JSON.parse(row.scopes_json),expiresAt:row.expires_at}; } catch(e){db.exec('ROLLBACK');throw e;} },
    recordAgentAccessScopedAction(requestId, scope, method, pathname) { db.exec('BEGIN IMMEDIATE'); try { audit(db,{actorId:`agent:${requestId}`,action:'agent_access.scoped_action',entityType:'agent_access_request',entityId:requestId,reason:`scope=${scope};method=${method};path=${pathname}`}); db.exec('COMMIT'); } catch(error) { db.exec('ROLLBACK'); throw error; } },
    getAgentAccessSession(digest) { const row=db.prepare('SELECT * FROM agent_access_sessions WHERE token_digest=?').get(digest); return row ? {...row,requestId:row.request_id,scopes:JSON.parse(row.scopes_json),expiresAt:row.expires_at} : null; },
    denyAgentAccessRequest(id,actorId) { db.exec('BEGIN IMMEDIATE'); try { const r=db.prepare("UPDATE agent_access_requests SET status='denied' WHERE id=? AND status='pending'").run(id); if(!r.changes) throw new Error('request_unavailable'); audit(db,{actorId,action:'agent_access.denied',entityType:'agent_access_request',entityId:id,reason:'administrator denial'}); db.exec('COMMIT'); return {requestId:id,status:'denied'}; } catch(e){db.exec('ROLLBACK');throw e;} },
    revokeAgentAccessRequest(id,actorId) { db.exec('BEGIN IMMEDIATE'); try { const r=db.prepare("UPDATE agent_access_requests SET status='revoked' WHERE id=? AND status IN ('pending','approved','delivered','exchanged')").run(id); if(!r.changes) throw new Error('request_unavailable'); db.prepare('UPDATE agent_access_sessions SET revoked=1 WHERE request_id=?').run(id); audit(db,{actorId,action:'agent_access.revoked',entityType:'agent_access_request',entityId:id,reason:'administrator revocation'}); db.exec('COMMIT'); return {requestId:id,status:'revoked'}; } catch(e){db.exec('ROLLBACK');throw e;} },
    submitOperationsProposal(input, { now = () => Date.now() } = {}) {
      const validated = validateProposal(input, { now });
      const existing = db.prepare('SELECT * FROM operations_proposals WHERE requester=? AND idempotency_key=?').get(validated.requester, validated.idempotencyKey);
      if (existing) {
        if (existing.envelope_digest !== validated.envelopeDigest) throw new Error('idempotency_conflict');
        return projection(existing);
      }
      const row = {
        ...validated, status: validated.risk === 'read' ? 'approved' : 'pending_approval', revision: 1,
        payloadJson: JSON.stringify(validated.payload), resourceIdsJson: JSON.stringify(validated.resourceIds), approvalRequirementsJson: JSON.stringify(validated.approvalRequirements)
      };
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`INSERT INTO operations_proposals (proposal_id,requester,destination_service,operation,operation_version,payload_json,resource_ids_json,idempotency_key,created_at,expires_at,risk,approval_requirements_json,payload_digest,envelope_digest,status,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.proposalId,row.requester,row.destinationService,row.operation,row.operationVersion,row.payloadJson,row.resourceIdsJson,row.idempotencyKey,row.createdAt,row.expiresAt,row.risk,row.approvalRequirementsJson,row.payloadDigest,row.envelopeDigest,row.status,row.revision);
        audit(db, { actorId: row.requester, action: 'operations_proposal.submitted', entityType: 'operations_proposal', entityId: row.proposalId, reason: 'validated requester proposal', after: { envelopeDigest: row.envelopeDigest, payloadDigest: row.payloadDigest } });
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); if (String(error.message).includes('UNIQUE')) { const replay = db.prepare('SELECT * FROM operations_proposals WHERE requester=? AND idempotency_key=?').get(row.requester,row.idempotencyKey); if (replay?.envelope_digest === row.envelopeDigest) return projection(replay); if (replay) throw new Error('idempotency_conflict'); } throw error; }
      return projection(db.prepare('SELECT * FROM operations_proposals WHERE proposal_id=?').get(row.proposalId));
    },
    getOperationsProposal(proposalId, { requester, admin = false, requireApproved = false, now = Date.now } = {}) {
      const row = db.prepare('SELECT * FROM operations_proposals WHERE proposal_id=?').get(required(proposalId, 'proposalId'));
      if (!row) return null;
      if (!admin && (typeof requester !== 'string' || row.requester !== requester)) return null;
      const expired = Date.parse(row.expires_at) <= now();
      if (expired && !admin) return null;
      if (requireApproved && row.status !== 'approved') return null;
      return projection(expired && row.status === 'pending_approval' ? { ...row, status: 'expired' } : row);
    },
    listOperationsProposals({ now = Date.now } = {}) { return db.prepare('SELECT proposal_id FROM operations_proposals ORDER BY created_at DESC').all().map(row => this.getOperationsProposal(row.proposal_id, { now })); },
    decideOperationsProposal(proposalId, input, { now = Date.now } = {}) {
      required(input.approverId, 'approverId'); required(input.reason, 'reason');
      if (!['approve', 'reject'].includes(input.decision)) throw new TypeError('decision must be approve or reject');
      if (input.approverId === (db.prepare('SELECT requester FROM operations_proposals WHERE proposal_id=?').get(proposalId)?.requester)) throw new Error('self_approval');
      const row = db.prepare('SELECT * FROM operations_proposals WHERE proposal_id=?').get(proposalId);
      if (!row) throw new Error('proposal_not_found');
      if (Date.parse(row.expires_at) <= now()) throw new Error('proposal_expired');
      const kind = input.approvalKind ?? (row.risk === 'critical' ? 'critical' : 'proposal');
      if (row.risk === 'critical' && kind !== 'critical') throw new Error('critical_approval_required');
      if (row.risk !== 'critical' && kind === 'critical') throw new Error('invalid_approval_kind');
      if (input.envelopeDigest !== row.envelope_digest || input.proposalRevision !== row.revision) throw new Error('approval_binding_mismatch');
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = db.prepare('INSERT INTO operations_approvals (approval_id,proposal_id,proposal_revision,envelope_digest,approver_id,decision,approval_kind,decided_at,reason) VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(), proposalId, row.revision, row.envelope_digest, input.approverId, input.decision, kind, new Date(now()).toISOString(), input.reason);
        if (!result.changes) throw new Error('approval_unavailable');
        const status = input.decision === 'approve' ? 'approved' : 'rejected';
        db.prepare('UPDATE operations_proposals SET status=? WHERE proposal_id=? AND status=?').run(status, proposalId, row.status);
        audit(db, { actorId: input.approverId, action: `operations_proposal.${status}`, entityType: 'operations_proposal', entityId: proposalId, reason: input.reason, after: { envelopeDigest: row.envelope_digest } });
        db.exec('COMMIT'); return this.getOperationsProposal(proposalId, { now });
      } catch (error) { db.exec('ROLLBACK'); if (String(error.message).includes('UNIQUE')) throw new Error('approval_already_decided'); throw error; }
    },
    authorizeControlBaseline({walletId,positionId,network,subjectAddress}) {
      const row=db.prepare(`SELECT 1 ok FROM wallet_enrollments e JOIN wallets w ON w.wallet_id=e.wallet_id JOIN targets t ON t.id=e.target_id WHERE e.wallet_id=? AND e.target_id=? AND w.status='active' AND e.status='active' AND t.status='active' AND t.id=? AND e.subject_id=?`).get(walletId,positionId,positionId,subjectAddress);
      if (!row) return false;
      try { return parseCanonicalTargetId(positionId).network===network; } catch { return false; }
    },
    authorizeGovernanceBindingsRead({walletId,network}) {
      const rows=db.prepare(`SELECT t.id FROM wallet_enrollments e JOIN wallets w ON w.wallet_id=e.wallet_id JOIN targets t ON t.id=e.target_id WHERE e.wallet_id=? AND w.status='active' AND e.status='active' AND t.status='active'`).all(walletId);
      return rows.some(row=>{try{return parseCanonicalTargetId(row.id).network===network}catch{return false}});
    },
    close() { db.close(); }
  };
}
