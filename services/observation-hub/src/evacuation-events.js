const STATUSES = new Set(['BROADCAST_PENDING', 'EVACUATED', 'ERROR']);
const CONFIRMATIONS = new Set(['submitted', 'confirmed', 'finalized', 'failed']);

function requiredString(event, field) {
  if (typeof event[field] !== 'string' || event[field].length === 0) throw new TypeError(`${field} required`);
}

export function listEvacuationEvents(db, { limit = 50, cursor = null } = {}) {
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) throw new RangeError('limit must be an integer from 1 to 100');

  let boundary = null;
  if (cursor != null) {
    try {
      boundary = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw new RangeError('cursor is invalid');
    }
    if (!Array.isArray(boundary) || typeof boundary[0] !== 'string' || !Number.isInteger(boundary[1])) {
      throw new RangeError('cursor is invalid');
    }
  }

  const sql = `SELECT * FROM evacuation_events
    ${boundary ? 'WHERE observed_at < ? OR (observed_at = ? AND id < ?)' : ''}
    ORDER BY observed_at DESC, id DESC LIMIT ?`;
  const rows = boundary
    ? db.prepare(sql).all(boundary[0], boundary[0], boundary[1], parsedLimit + 1)
    : db.prepare(sql).all(parsedLimit + 1);
  const hasMore = rows.length > parsedLimit;
  const pageRows = rows.slice(0, parsedLimit);
  const last = pageRows.at(-1);
  return {
    events: pageRows.map((row) => ({
      eventId: row.event_id,
      idempotencyKey: row.idempotency_key,
      fingerprint: row.fingerprint,
      walletAddress: row.wallet_address,
      network: row.network,
      status: row.status,
      triggerReason: row.trigger_reason,
      signature: row.signature,
      confirmationStatus: row.confirmation_status,
      confirmationSlot: row.confirmation_slot,
      observedAt: row.observed_at
    })),
    page: {
      limit: parsedLimit,
      nextCursor: hasMore && last
        ? Buffer.from(JSON.stringify([last.observed_at, last.id]), 'utf8').toString('base64url')
        : null
    }
  };
}

export function recordEvacuationEvent(db, event, now = new Date()) {
  if (!event || typeof event !== 'object') throw new TypeError('event must be an object');
  for (const field of ['eventId', 'idempotencyKey', 'fingerprint', 'walletAddress', 'network', 'status', 'triggerReason']) {
    requiredString(event, field);
  }
  if (!STATUSES.has(event.status)) throw new RangeError('unsupported evacuation status');
  if (event.confirmationStatus != null && !CONFIRMATIONS.has(event.confirmationStatus)) throw new RangeError('unsupported confirmation status');

  const existing = db.prepare(`
    SELECT event_id, idempotency_key, observed_at
    FROM evacuation_events WHERE event_id = ? OR idempotency_key = ?
  `).all(event.eventId, event.idempotencyKey);
  if (existing.length) {
    const exact = existing.find((row) => row.event_id === event.eventId && row.idempotency_key === event.idempotencyKey);
    if (exact) return { inserted: false, duplicate: true, eventId: exact.event_id, observedAt: exact.observed_at };
    if (existing.some((row) => row.idempotency_key === event.idempotencyKey)) throw new RangeError('idempotencyKey already belongs to another event');
    throw new RangeError('eventId already belongs to another idempotency key');
  }

  const observedAt = now.toISOString();
  db.prepare(`INSERT INTO evacuation_events
    (event_id, idempotency_key, fingerprint, wallet_address, network, status, trigger_reason,
      signature, confirmation_status, confirmation_slot, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(event.eventId, event.idempotencyKey, event.fingerprint, event.walletAddress, event.network,
      event.status, event.triggerReason, event.signature ?? null, event.confirmationStatus ?? null,
      event.confirmationSlot ?? null, observedAt);
  return { inserted: true, duplicate: false, eventId: event.eventId, observedAt };
}
