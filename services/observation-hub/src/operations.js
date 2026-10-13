function plain(row) { return row ? { ...row } : null; }

export function getOperationsOverview(db, now = new Date()) {
  const indexers = plain(db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) AS healthy,
      SUM(CASE WHEN status <> 'healthy' THEN 1 ELSE 0 END) AS attention
    FROM indexers
  `).get());
  const targets = plain(db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled
    FROM indexer_targets
  `).get());
  const evidence = plain(db.prepare(`
    SELECT COUNT(*) AS snapshotCount, MAX(observed_at) AS latestObservedAt FROM vault_snapshots
  `).get());
  const evacuations = plain(db.prepare(`
    SELECT COUNT(*) AS total, MAX(observed_at) AS latestObservedAt,
      SUM(CASE WHEN status = 'BROADCAST_PENDING' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'EVACUATED' THEN 1 ELSE 0 END) AS evacuated,
      SUM(CASE WHEN status = 'ERROR' THEN 1 ELSE 0 END) AS errors
    FROM evacuation_events
  `).get());
  return {
    generatedAt: now.toISOString(),
    indexers: { total: indexers.total, healthy: indexers.healthy || 0, attention: indexers.attention || 0 },
    targets: { total: targets.total, enabled: targets.enabled || 0 },
    evidence: { snapshotCount: evidence.snapshotCount, latestObservedAt: evidence.latestObservedAt },
    evacuations: {
      total: evacuations.total,
      latestObservedAt: evacuations.latestObservedAt,
      statuses: {
        BROADCAST_PENDING: evacuations.pending || 0,
        EVACUATED: evacuations.evacuated || 0,
        ERROR: evacuations.errors || 0
      }
    }
  };
}

export function getOperationsIndexers(db) {
  const rows = db.prepare(`
    SELECT i.*,
      (SELECT COUNT(*) FROM indexer_targets t WHERE t.indexer_id = i.id) AS target_count,
      (SELECT COUNT(*) FROM vault_snapshots s JOIN indexer_targets t ON t.id = s.target_id WHERE t.indexer_id = i.id) AS snapshot_count
    FROM indexers i ORDER BY i.id
  `).all();
  const cursor = db.prepare(`
    SELECT slot, signature, updated_at FROM indexer_cursors
    WHERE indexer_id = ? AND stream = 'account_snapshot'
    ORDER BY updated_at DESC LIMIT 1
  `);
  return { indexers: rows.map((raw) => {
    const row = plain(raw);
    const latest = plain(cursor.get(row.id));
    return {
      id: row.id, protocol: row.protocol, network: row.network, version: row.version,
      status: row.status, capabilities: JSON.parse(row.capabilities_json),
      registeredAt: row.registered_at, lastHeartbeatAt: row.last_heartbeat_at,
      lastSuccessAt: row.last_success_at, lastErrorCode: row.last_error_code,
      lastErrorMessage: row.last_error_message, targetCount: row.target_count,
      snapshotCount: row.snapshot_count,
      snapshotCursor: latest ? { slot: latest.slot, signature: latest.signature, updatedAt: latest.updated_at } : null
    };
  }) };
}

export function getOperationsEvacuations(db, limit = 50) {
  const rows = db.prepare(`
    SELECT event_id, wallet_address, network, status, trigger_reason, signature,
      confirmation_status, confirmation_slot, observed_at
    FROM evacuation_events ORDER BY observed_at DESC, id DESC LIMIT ?
  `).all(limit);
  return { evacuations: rows.map((raw) => {
    const row = plain(raw);
    return {
      eventId: row.event_id,
      walletAddress: row.wallet_address,
      network: row.network,
      status: row.status,
      triggerReason: row.trigger_reason,
      signature: row.signature,
      confirmationStatus: row.confirmation_status,
      confirmationSlot: row.confirmation_slot,
      observedAt: row.observed_at
    };
  }) };
}

export function getOperationsTargets(db) {
  const rows = db.prepare('SELECT * FROM indexer_targets ORDER BY display_name, id').all();
  const snapshot = db.prepare(`
    SELECT slot, observed_at, account_hash, source, decoder_version
    FROM vault_snapshots WHERE target_id = ? ORDER BY slot DESC, id DESC LIMIT 1
  `);
  const cursor = db.prepare(`
    SELECT slot, signature, updated_at FROM indexer_cursors
    WHERE target_id = ? AND stream = 'account_snapshot'
  `);
  return { targets: rows.map((raw) => {
    const row = plain(raw);
    const latest = plain(snapshot.get(row.id));
    const committed = plain(cursor.get(row.id));
    return {
      id: row.id, indexerId: row.indexer_id, protocol: row.protocol, network: row.network,
      kind: row.kind, address: row.address, displayName: row.display_name, curator: row.curator,
      enabled: Boolean(row.enabled), updatedAt: row.updated_at,
      latestSnapshot: latest ? { slot: latest.slot, observedAt: latest.observed_at, accountHash: latest.account_hash, source: latest.source, decoderVersion: latest.decoder_version } : null,
      snapshotCursor: committed ? { slot: committed.slot, signature: committed.signature, updatedAt: committed.updated_at } : null
    };
  }) };
}
