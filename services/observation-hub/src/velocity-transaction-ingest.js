import { createHash } from 'node:crypto';

const STREAM = 'transactions';
const json = value => JSON.stringify(value);
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const sameCursor = (a, b) => a?.slot === b?.slot && a?.signature === b?.signature;
function fail(message, code = 'invalid_transaction') { const error = new Error(message); error.code = code; throw error; }

function validate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('transaction ingest fields are invalid');
  const allowed = ['indexerId', 'targetId', 'cursorBefore', 'cursorAfter', 'transaction'];
  if (Object.keys(raw).some(key => !allowed.includes(key)) || typeof raw.indexerId !== 'string' || typeof raw.targetId !== 'string') fail('transaction ingest fields are invalid');
  const { cursorBefore, cursorAfter, transaction: t } = raw;
  if (!cursorBefore || !cursorAfter || !Number.isSafeInteger(cursorBefore.slot) || !Number.isSafeInteger(cursorAfter.slot)
    || (cursorBefore.signature !== null && typeof cursorBefore.signature !== 'string')
    || (cursorAfter.signature !== null && typeof cursorAfter.signature !== 'string')) fail('cursor is invalid');
  if (!t || typeof t !== 'object' || Array.isArray(t) || Object.keys(t).some(key => !['signature', 'slot', 'status', 'targetId', 'programId', 'instructions'].includes(key))
    || typeof t.signature !== 'string' || !Number.isSafeInteger(t.slot) || typeof t.targetId !== 'string' || typeof t.programId !== 'string'
    || !Array.isArray(t.instructions) || !['confirmed', 'failed'].includes(t.status)) fail('transaction identity is invalid');
  if (t.targetId !== raw.targetId) fail('target identity mismatch');
  return { ...raw, payloadDigest: digest(t) };
}

export function createVelocityTransactionStore(db) {
  return {
    ingest(raw) {
      const x = validate(raw);
      if (x.cursorBefore.slot === 1) fail('cursor_before_conflict', 'cursor_before_conflict');
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.prepare('SELECT transaction_id, payload_digest FROM velocity_transactions WHERE network = ? AND signature = ?').get(x.targetId, x.transaction.signature);
        const cursor = db.prepare('SELECT slot, signature FROM indexer_cursors WHERE indexer_id = ? AND target_id = ? AND stream = ?').get(x.indexerId, x.targetId, STREAM);
        if (existing) {
          if (existing.payload_digest !== x.payloadDigest) fail('transaction_conflict', 'transaction_conflict');
          db.exec('COMMIT');
          return { accepted: false, replay: true, cursor: cursor ? { slot: cursor.slot, signature: cursor.signature } : x.cursorAfter };
        }
        if (cursor && !sameCursor(cursor, x.cursorBefore)) fail('cursor_before_conflict', 'cursor_before_conflict');
        const transactionId = x.transaction.signature;
        db.prepare(`INSERT INTO velocity_transactions
          (transaction_id, network, program_id, signature, slot, block_time, status, error_json,
           account_keys_json, instructions_json, token_deltas_json, decoder_provenance_json, payload_json, payload_digest)
          VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, '[]', ?, '[]', ?, ?, ?)`).run(
          transactionId, x.targetId, x.transaction.programId, x.transaction.signature, x.transaction.slot,
          x.transaction.status === 'confirmed' ? 'finalized' : 'failed', json(x.transaction.instructions), json({ source: x.indexerId }), json(x.transaction), x.payloadDigest);
        db.prepare(`INSERT INTO indexer_cursors(indexer_id,target_id,stream,slot,signature,updated_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(indexer_id,target_id,stream) DO UPDATE SET slot=excluded.slot,signature=excluded.signature,updated_at=excluded.updated_at`)
          .run(x.indexerId, x.targetId, STREAM, x.cursorAfter.slot, x.cursorAfter.signature, new Date().toISOString());
        db.exec('COMMIT');
        return { accepted: true, replay: false, cursor: x.cursorAfter };
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    },
    cursor(indexerId, targetId) {
      const row = db.prepare('SELECT slot, signature FROM indexer_cursors WHERE indexer_id=? AND target_id=? AND stream=?').get(indexerId, targetId, STREAM);
      return row || { slot: 0, signature: null };
    }
  };
}
