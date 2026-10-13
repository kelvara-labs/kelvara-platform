import { createHash } from 'node:crypto';
import { validateObservationBatch } from '@kelvara/contracts/ingestion-contract';
import { validateGovernanceControl, governanceControlDigest } from '@kelvara/contracts/governance-control-v1';
import { validateGovernanceAction, governanceActionDigest, governanceActionIdentity, governanceActionObservationIdentity } from '@kelvara/contracts/governance-action-v1';

const ALLOWED_STREAMS = new Set(['account_snapshot', 'transactions', 'governance_control', 'governance_action']);

function cursorsEqual(committed, expected) {
  if (!committed) return expected.slot === 0 && expected.signature === null;
  return committed.slot === expected.slot && committed.signature === expected.signature;
}

const SNAPSHOT_FIELDS = [
  'accountHash', 'source', 'decoderVersion', 'vaultAdminAuthority', 'pendingAdmin',
  'tokenMint', 'sharesMint', 'tokenAvailable', 'sharesIssued', 'previousAumScaled',
  'pendingFeesScaled', 'performanceFeeBps', 'managementFeeBps'
];
const ALLOCATION_FIELDS = [
  'reserve', 'targetAllocationWeight', 'ctokenAllocation', 'tokenAllocationCap',
  'ctokenAllocationCap', 'tokenTargetAllocationScaled'
];

function requireString(record, field, context) {
  if (typeof record[field] !== 'string' || record[field].length === 0) {
    throw new TypeError(`${context}.${field} must be a non-empty string`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}
function batchDigest(batch, stream) {
  return createHash('sha256').update(JSON.stringify(canonicalize({ ...batch, stream }))).digest('hex');
}

function insertGovernanceControl(db, batch, record, serializedBatchHash) {
  const evidence = validateGovernanceControl(record.evidence, { now: new Date(`${batch.observedAt.slice(0, 10)}T23:59:59.999Z`) });
  const canonicalJson = JSON.stringify(evidence, (key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((entry) => [entry, value[entry]]));
  });
  const payloadHash = governanceControlDigest(evidence);
  const observationId = `${batch.indexerId}:${batch.batchId}`;
  const existing = db.prepare('SELECT payload_hash FROM governance_control_observations WHERE idempotency_key = ?').get(observationId);
  if (existing) {
    if (existing.payload_hash !== payloadHash) throw new Error('governance payload conflict');
    return;
  }
  db.prepare(`INSERT INTO governance_control_observations
    (observation_id,idempotency_key,payload_hash,batch_hash,subject_address,network,provider,generation,status,program_id,multisig_address,authority_address,authority_index,threshold,time_lock_seconds,canonical_json,finalized_slot,observed_at,decoder_family,decoder_version,artifact_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    observationId, observationId, payloadHash, serializedBatchHash, evidence.subjectAddress, evidence.network, evidence.provider, evidence.generation, evidence.status, evidence.programId,
    evidence.multisigAddress, evidence.authorityAddress, evidence.authorityIndex, evidence.threshold, evidence.timeLockSeconds,
    canonicalJson, evidence.slot, evidence.observedAt, evidence.decoderFamily, evidence.decoderVersion, evidence.artifactHash, new Date().toISOString());
}

function insertGovernanceAction(db,batch,record,serializedBatchHash){
  const evidence=validateGovernanceAction(record.evidence,{now:new Date(`${batch.observedAt.slice(0,10)}T23:59:59.999Z`)}),actionId=governanceActionIdentity(evidence),payloadHash=governanceActionDigest(evidence,{now:new Date(`${batch.observedAt.slice(0,10)}T23:59:59.999Z`)}),observationId=governanceActionObservationIdentity(evidence,{now:new Date(`${batch.observedAt.slice(0,10)}T23:59:59.999Z`)}),canonicalJson=JSON.stringify(canonicalize(evidence));
  const latest=db.prepare('SELECT observed_slot FROM governance_action_observations WHERE action_id=? ORDER BY observed_slot DESC LIMIT 1').get(actionId);if(latest&&evidence.observedSlot<latest.observed_slot)throw new RangeError('governance action slot regressed');
  db.prepare(`INSERT INTO governance_actions(action_id,network,program_id,multisig_address,vault_address,action_type,transaction_index,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(action_id) DO NOTHING`).run(actionId,evidence.network,evidence.programId,evidence.multisigAddress,evidence.vaultAddress,evidence.actionType,evidence.transactionIndex,new Date().toISOString());
  const existing=db.prepare('SELECT payload_hash FROM governance_action_observations WHERE observation_id=?').get(observationId);if(existing){if(existing.payload_hash!==payloadHash)throw new Error('governance action conflict');return}
  db.prepare(`INSERT INTO governance_action_observations(observation_id,action_id,payload_hash,batch_hash,state,observed_slot,observed_at,canonical_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(observationId,actionId,payloadHash,serializedBatchHash,evidence.state,evidence.observedSlot,evidence.observedAt,canonicalJson,new Date().toISOString());
}

function validateRecords(records, stream) {
  for (const [index, record] of records.entries()) {
    if (record.type === 'governance_control' || record.type === 'governance_action') {
      if (stream !== record.type) throw new RangeError(`${record.type} requires ${record.type} stream`);
      if (!record.evidence || typeof record.evidence !== 'object') throw new TypeError(`records[${index}].evidence is invalid`);
      continue;
    }
    if (record.type === 'raw_account') {
      if (stream !== 'account_snapshot') throw new RangeError('raw_account requires account_snapshot stream');
      for (const field of ['address', 'accountHash', 'owner', 'dataHash', 'decoderFamily', 'decoderVersion']) requireString(record, field, `records[${index}]`);
      if (!Number.isSafeInteger(record.slot) || record.slot < 0 || !Number.isSafeInteger(record.dataLength) || record.dataLength < 0) throw new TypeError(`records[${index}] raw account facts are invalid`);
      if (typeof record.executable !== 'boolean') throw new TypeError(`records[${index}].executable is invalid`);
      continue;
    }
    if (record.type !== 'vault_snapshot') throw new RangeError(`unsupported record type: ${record.type}`);
    if (stream !== 'account_snapshot') throw new RangeError('vault_snapshot requires account_snapshot stream');
    if (!Number.isSafeInteger(record.slot) || record.slot < 0) throw new TypeError(`records[${index}].slot is invalid`);
    for (const field of SNAPSHOT_FIELDS) requireString(record, field, `records[${index}]`);
    if (!Array.isArray(record.allocations)) throw new TypeError(`records[${index}].allocations must be an array`);
    for (const [allocationIndex, allocation] of record.allocations.entries()) {
      for (const field of ALLOCATION_FIELDS) {
        requireString(allocation, field, `records[${index}].allocations[${allocationIndex}]`);
      }
    }
  }
}

function insertRawAccount(db, batch, record) {
  db.prepare(`INSERT INTO raw_accounts
    (target_id,slot,observed_at,address,account_hash,owner,data_length,data_hash,executable,decoder_family,decoder_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(target_id,slot,data_hash) DO NOTHING`)
    .run(batch.targetId, record.slot, batch.observedAt, record.address, record.accountHash, record.owner,
      record.dataLength, record.dataHash, record.executable ? 1 : 0, record.decoderFamily, record.decoderVersion);
}

function insertVaultSnapshot(db, batch, record) {
  const result = db.prepare(`
    INSERT INTO vault_snapshots
      (target_id, slot, observed_at, account_hash, source, decoder_version,
       vault_admin_authority, allocation_admin, pending_admin, token_mint, shares_mint,
       token_available, shares_issued, previous_aum_scaled, pending_fees_scaled,
       performance_fee_bps, management_fee_bps)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    batch.targetId, record.slot, batch.observedAt, record.accountHash, record.source,
    record.decoderVersion, record.vaultAdminAuthority, record.allocationAdmin,
    record.pendingAdmin, record.tokenMint, record.sharesMint, record.tokenAvailable,
    record.sharesIssued, record.previousAumScaled, record.pendingFeesScaled,
    record.performanceFeeBps, record.managementFeeBps
  );
  const statement = db.prepare(`
    INSERT INTO vault_allocations
      (snapshot_id, reserve, target_allocation_weight, ctoken_allocation,
       token_allocation_cap, ctoken_allocation_cap, token_target_allocation_scaled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const allocation of record.allocations) {
    statement.run(
      result.lastInsertRowid, allocation.reserve, allocation.targetAllocationWeight,
      allocation.ctokenAllocation, allocation.tokenAllocationCap,
      allocation.ctokenAllocationCap, allocation.tokenTargetAllocationScaled
    );
  }
}

export function ingestObservationBatch(db, input, stream) {
  const batch = validateObservationBatch(input);
  if (!ALLOWED_STREAMS.has(stream)) throw new RangeError(`unsupported stream: ${stream}`);
  if (batch.stream && batch.stream !== stream) throw new RangeError('batch stream does not match route stream');
  if (stream === 'governance_control' && (batch.records.length !== 1 || batch.records[0]?.type !== stream)) throw new RangeError('governance_control stream requires exactly one matching governance record');
  if (stream === 'governance_action' && batch.records.some((record) => record?.type !== stream)) throw new RangeError('governance_action stream requires matching governance records');
  validateRecords(batch.records, stream);
  const serializedBatchHash = batchDigest(batch, stream);

  db.exec('BEGIN IMMEDIATE');
  try {
    const duplicate = db.prepare(`
      SELECT 1 FROM ingestion_batches WHERE indexer_id = ? AND batch_id = ?
    `).get(batch.indexerId, batch.batchId);

    if (duplicate) {
      if (stream === 'governance_control') {
        const existingGovernance = db.prepare('SELECT batch_hash FROM governance_control_observations WHERE idempotency_key = ?').get(`${batch.indexerId}:${batch.batchId}`);
        if (!existingGovernance || existingGovernance.batch_hash !== serializedBatchHash) throw new Error('governance payload conflict');
      } else if(stream==='governance_action'){
        const existingAction=db.prepare('SELECT batch_hash FROM governance_action_observations WHERE batch_hash=?').get(serializedBatchHash);
        if(!existingAction)throw new Error('governance action conflict');
      }
      db.exec('COMMIT');
      return { duplicate: true, committedCursor: batch.cursorAfter };
    }

    const committed = db.prepare(`
      SELECT signature, slot FROM indexer_cursors
      WHERE indexer_id = ? AND target_id = ? AND stream = ?
    `).get(batch.indexerId, batch.targetId, stream);

    if (!cursorsEqual(committed, batch.cursorBefore)) {
      throw new Error('cursorBefore does not match committed cursor');
    }

    const now = new Date().toISOString();
    for (const record of batch.records) {
      if (record.type === 'raw_account') insertRawAccount(db, batch, record);
      else if (record.type === 'governance_control') insertGovernanceControl(db, batch, record, serializedBatchHash);
      else if (record.type === 'governance_action') insertGovernanceAction(db,batch,record,serializedBatchHash);
      else insertVaultSnapshot(db, batch, record);
    }

    db.prepare(`
      INSERT INTO ingestion_batches
        (indexer_id, batch_id, target_id, stream, observed_at, committed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(batch.indexerId, batch.batchId, batch.targetId, stream, batch.observedAt, now);

    db.prepare(`
      INSERT INTO indexer_cursors
        (indexer_id, target_id, stream, slot, signature, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(indexer_id, target_id, stream) DO UPDATE SET
        slot = excluded.slot,
        signature = excluded.signature,
        updated_at = excluded.updated_at
    `).run(
      batch.indexerId,
      batch.targetId,
      stream,
      batch.cursorAfter.slot,
      batch.cursorAfter.signature,
      now
    );

    db.exec('COMMIT');
    return { duplicate: false, committedCursor: batch.cursorAfter };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
