import { validateVelocityObservation } from '@kelvara/contracts/velocity-observation-v1';
export function recordVelocityObservation(db, input) {
  const item = validateVelocityObservation(input);
  const payload = JSON.stringify(item);
  const existing = db.prepare('SELECT payload_digest FROM velocity_observations WHERE observation_id=?').get(item.observationId);
  if (existing) { if (existing.payload_digest !== item.payloadDigest) throw new Error('velocity_observation_conflict'); return { inserted:false, observationId:item.observationId }; }
  try {
    db.prepare(`INSERT INTO velocity_observations(observation_id,kind,network,program_id,address,slot,owner,executable,data_length,data_hash,observed_at,provenance,status,unknown_reason,payload_json,payload_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(item.observationId,item.kind,item.network,item.programId,item.address,Number(item.slot),item.owner??null,item.executable===undefined?null:item.executable?1:0,item.dataLength??null,item.dataHash??null,item.observedAt,JSON.stringify(item.provenance),item.status,item.unknownReason??null,payload,item.payloadDigest);
  } catch (error) {
    if (error?.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/.test(error?.message ?? '')) {
      const winner = db.prepare('SELECT payload_digest FROM velocity_observations WHERE observation_id=?').get(item.observationId);
      if (winner?.payload_digest === item.payloadDigest) return { inserted:false, observationId:item.observationId };
      throw new Error('velocity_observation_conflict');
    }
    throw error;
  }
  return { inserted:true, observationId:item.observationId };
}
export function listVelocityObservations(db, query={}) {
  const rawLimit = query.limit ?? '50';
  if (!/^\d{1,3}$/.test(String(rawLimit))) throw new RangeError('limit must be an integer from 1 to 100');
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be an integer from 1 to 100');
  const address = query.address ?? '';
  if (address && (typeof address !== 'string' || address.length > 128 || /[\u0000-\u001f\u007f]/.test(address))) throw new RangeError('address is invalid');
  const rows = db.prepare(`SELECT payload_json FROM velocity_observations WHERE (?='' OR address=?) ORDER BY slot DESC, observation_id DESC LIMIT ?`).all(query.address??'',query.address??'',limit);
  return { observations: rows.map(r=>JSON.parse(r.payload_json)), limit };
}
