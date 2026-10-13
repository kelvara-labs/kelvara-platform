const REQUIRED_STRING_FIELDS = ['batchId', 'indexerId', 'targetId', 'network', 'observedAt'];
function requireObject(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`); }
function validateCursor(cursor, name) { requireObject(cursor, name); if (!Number.isSafeInteger(cursor.slot) || cursor.slot < 0) throw new TypeError(`${name}.slot must be a non-negative safe integer`); if (cursor.signature !== null && (typeof cursor.signature !== 'string' || cursor.signature.length === 0)) throw new TypeError(`${name}.signature must be null or a non-empty string`); }
export function validateObservationBatch(batch) {
  requireObject(batch, 'batch');
  if (batch.schemaVersion !== 1) throw new RangeError(`unsupported schemaVersion: ${batch.schemaVersion}`);
  for (const field of REQUIRED_STRING_FIELDS) if (typeof batch[field] !== 'string' || batch[field].length === 0) throw new TypeError(`${field} must be a non-empty string`);
  if (!Number.isFinite(Date.parse(batch.observedAt))) throw new TypeError('observedAt must be a valid ISO-8601 timestamp');
  validateCursor(batch.cursorBefore, 'cursorBefore'); validateCursor(batch.cursorAfter, 'cursorAfter');
  if (!Array.isArray(batch.records)) throw new TypeError('records must be an array');
  if (batch.records.some(record => record?.type === 'raw_account')) {
    for (const [index, record] of batch.records.entries()) {
      if (record.type !== 'raw_account' || typeof record.address !== 'string' || typeof record.accountHash !== 'string' || !Number.isSafeInteger(record.slot)) throw new TypeError(`records[${index}] raw account is invalid`);
      if (!Number.isSafeInteger(record.dataLength) || typeof record.owner !== 'string' || typeof record.dataHash !== 'string') throw new TypeError(`records[${index}] raw account facts are invalid`);
    }
  }
  return batch;
}
