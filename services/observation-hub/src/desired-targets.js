import { createHash } from 'node:crypto';
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function registerDesiredTarget(db, target, now = new Date()) {
  if (!target?.targetId || !target.chain || !target.network || !target.protocol || !target.kind || !target.address) throw new TypeError('complete target identity required');
  const existing = db.prepare('SELECT target_id,chain,network,protocol,kind,address FROM desired_targets WHERE target_id=?').get(target.targetId);
  const identity = [target.chain, target.network, target.protocol, target.kind, target.address];
  if (existing) {
    const prior = [existing.chain, existing.network, existing.protocol, existing.kind, existing.address];
    if (JSON.stringify(prior) !== JSON.stringify(identity)) throw new Error('target_identity_conflict');
    const columns = db.prepare('PRAGMA table_info(desired_targets)').all().map(row => row.name);
    if (columns.includes('decoder_family')) db.prepare('UPDATE desired_targets SET status=?,revision=?,decoder_family=?,decoder_version=?,expected_owner=?,expected_data_length=?,updated_at=? WHERE target_id=?').run(target.status ?? 'draft', target.revision ?? 1, target.decoderFamily ?? null, target.decoderVersion ?? null, target.expectedOwner ?? null, target.expectedDataLength ?? null, now.toISOString(), target.targetId);
    else db.prepare('UPDATE desired_targets SET status=?,revision=?,updated_at=? WHERE target_id=?').run(target.status ?? 'draft', target.revision ?? 1, now.toISOString(), target.targetId);
    return { targetId: target.targetId, created: false };
  }
  const duplicate = db.prepare('SELECT target_id FROM desired_targets WHERE chain=? AND network=? AND protocol=? AND kind=? AND address=?').get(...identity);
  if (duplicate) throw new Error('target_identity_conflict');
  const columns = db.prepare('PRAGMA table_info(desired_targets)').all().map(row => row.name);
  if (columns.includes('decoder_family')) db.prepare(`INSERT INTO desired_targets(target_id,chain,network,protocol,kind,address,status,revision,decoder_family,decoder_version,expected_owner,expected_data_length,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(target.targetId,target.chain,target.network,target.protocol,target.kind,target.address,target.status ?? 'draft',target.revision ?? 1,target.decoderFamily ?? null,target.decoderVersion ?? null,target.expectedOwner ?? null,target.expectedDataLength ?? null,now.toISOString());
  else db.prepare(`INSERT INTO desired_targets(target_id,chain,network,protocol,kind,address,status,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(target.targetId,target.chain,target.network,target.protocol,target.kind,target.address,target.status ?? 'draft',target.revision ?? 1,now.toISOString());
  return { targetId: target.targetId, created: true };
}
export function assignDesiredTarget(db, assignment, now = new Date()) {
  const target = db.prepare('SELECT protocol,network FROM desired_targets WHERE target_id=?').get(assignment.targetId);
  if (!target) throw new Error('target_not_found');
  if (target.protocol !== assignment.protocol) throw new RangeError('assignment protocol mismatch');
  if (target.network !== assignment.network) throw new RangeError('assignment network mismatch');
  const result = db.prepare(`INSERT OR IGNORE INTO target_assignments(target_id,indexer_id,protocol,network,assignment_hash,created_at) VALUES(?,?,?,?,?,?)`).run(assignment.targetId,assignment.indexerId,assignment.protocol,assignment.network,hash(assignment),now.toISOString());
  return { created: result.changes === 1 };
}
export function listDesiredTargets(db, indexerId) {
  return db.prepare(`SELECT d.*, d.revision AS assignment_revision FROM desired_targets d JOIN target_assignments a ON a.target_id=d.target_id WHERE a.indexer_id=? AND d.status NOT IN ('retired','paused') ORDER BY d.target_id`).all(indexerId);
}
export function recordReconciliationStatus(db, indexerId, status, now = new Date()) {
  if (!['accepted','unsupported','provisioning','observing','degraded','paused','retired'].includes(status.status)) throw new RangeError('reconciliation status is unsupported');
  const assignment = db.prepare('SELECT 1 FROM target_assignments WHERE target_id=? AND indexer_id=?').get(status.targetId, indexerId);
  if (!assignment) throw new Error('assignment_not_owned');
  const at = now.toISOString();
  const cursorJson = JSON.stringify(status.cursor ?? null); const errorJson = JSON.stringify(status.error ?? null);
  db.prepare('INSERT INTO reconciliation_history(indexer_id,target_id,status,cursor_json,error_json,observed_at) VALUES(?,?,?,?,?,?)').run(indexerId,status.targetId,status.status,cursorJson,errorJson,at);
  db.prepare('INSERT INTO reconciliation_latest(indexer_id,target_id,status,cursor_json,error_json,observed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(indexer_id,target_id) DO UPDATE SET status=excluded.status,cursor_json=excluded.cursor_json,error_json=excluded.error_json,observed_at=excluded.observed_at').run(indexerId,status.targetId,status.status,cursorJson,errorJson,at);
  return { indexerId, targetId: status.targetId, status: status.status, observedAt: at };
}
export function listReconciliationHistory(db, indexerId, targetId) { return db.prepare('SELECT * FROM reconciliation_history WHERE indexer_id=? AND target_id=? ORDER BY id').all(indexerId,targetId); }
