import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CLUSTERS = new Set(["mainnet-beta", "devnet", "fixture"]);
function id(parts) {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
function requiredId(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new TypeError(`invalid_${name}`);
  return value;
}
function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid_${name}`);
  return value;
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function immutablePayload(evidence, valueJson) {
  return {
    targetId: evidence.targetId,
    observedAt: evidence.observedAt,
    fetchedAt: evidence.fetchedAt,
    value: JSON.parse(valueJson),
    availability: evidence.availability,
    source: evidence.source ?? null,
    slot: evidence.slot ?? null,
    timeout: Boolean(evidence.timeout),
    latencyMs: evidence.latencyMs ?? null,
    sourceLagMs: evidence.sourceLagMs ?? null,
    disagreement: Boolean(evidence.disagreement),
    backlog: evidence.backlog ?? null,
    processingLagMs: evidence.processingLagMs ?? null,
  };
}
function payloadHash(payload) { return id([stableJson(payload)]); }
function compareCurrent(evidence, current) {
  if (evidence.observedAt !== current.observed_at) return evidence.observedAt - current.observed_at;
  if (evidence.slot != null && current.slot != null && evidence.slot !== current.slot) return evidence.slot - current.slot;
  if (evidence.fetchedAt !== current.fetched_at) return evidence.fetchedAt - current.fetched_at;
  return evidence.id.localeCompare(current.evidence_id);
}

export function createConsumerStore({ path = "var/kelvara.sqlite" } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  const schemaVersion = db.prepare("PRAGMA user_version").get().user_version;
  if (schemaVersion > 5) {
    db.close();
    throw new TypeError("unsupported_schema_version");
  }
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS watch_targets (
      id TEXT PRIMARY KEY, cluster TEXT NOT NULL, protocol TEXT NOT NULL,
      kind TEXT NOT NULL, address TEXT NOT NULL,
      UNIQUE(cluster, protocol, kind, address)
    );
    CREATE TABLE IF NOT EXISTS position_targets (
      position_id TEXT NOT NULL, target_id TEXT NOT NULL REFERENCES watch_targets(id),
      PRIMARY KEY(position_id, target_id)
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES watch_targets(id),
      observed_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL, value_json TEXT,
      value_hash TEXT NOT NULL, availability TEXT NOT NULL, source TEXT, slot INTEGER
    );
    CREATE TABLE IF NOT EXISTS current_target_state (
      target_id TEXT PRIMARY KEY REFERENCES watch_targets(id), evidence_id TEXT NOT NULL,
      observed_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL, value_json TEXT,
      value_hash TEXT NOT NULL, availability TEXT NOT NULL, source TEXT, slot INTEGER
    );
    CREATE TABLE IF NOT EXISTS material_events (
      id TEXT PRIMARY KEY, target_id TEXT NOT NULL, evidence_id TEXT NOT NULL UNIQUE,
      previous_hash TEXT, value_hash TEXT NOT NULL, occurred_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telemetry_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT, evidence_id TEXT UNIQUE,
      sampled_at INTEGER NOT NULL, success INTEGER NOT NULL, timeout INTEGER NOT NULL DEFAULT 0,
      latency_ms REAL, source_lag_ms REAL, slot INTEGER, disagreement INTEGER NOT NULL DEFAULT 0,
      provider TEXT, backlog INTEGER, processing_lag_ms REAL
    );
    CREATE TABLE IF NOT EXISTS telemetry_rollups (
      tier TEXT NOT NULL, bucket_start INTEGER NOT NULL, provider TEXT NOT NULL DEFAULT '',
      count INTEGER NOT NULL, successes INTEGER NOT NULL, failures INTEGER NOT NULL,
      timeouts INTEGER NOT NULL, min_latency_ms REAL, max_latency_ms REAL, latency_sum_ms REAL NOT NULL,
      latency_count INTEGER NOT NULL DEFAULT 0,
      max_source_lag_ms REAL, min_slot INTEGER, max_slot INTEGER, disagreements INTEGER NOT NULL,
      first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
      PRIMARY KEY(tier,bucket_start,provider)
    );
    CREATE TABLE IF NOT EXISTS service_incidents (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at INTEGER NOT NULL,
      resolved_at INTEGER, detail_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cursors (
      name TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS monitored_wallets (
      wallet_id TEXT PRIMARY KEY, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_observations (
      id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL REFERENCES monitored_wallets(wallet_id),
      target_id TEXT REFERENCES watch_targets(id), event TEXT NOT NULL, status TEXT NOT NULL,
      observed_at INTEGER NOT NULL, detail_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clients (
      wallet_id TEXT PRIMARY KEY, enrolled_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS client_activity (
      id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL REFERENCES clients(wallet_id),
      event TEXT NOT NULL, status TEXT NOT NULL, observed_at INTEGER NOT NULL, detail_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evacuation_transactions (
      wallet_id TEXT NOT NULL REFERENCES clients(wallet_id), signature TEXT NOT NULL,
      status TEXT NOT NULL, observed_at INTEGER NOT NULL, PRIMARY KEY(wallet_id,signature)
    );
    CREATE TABLE IF NOT EXISTS client_payments (
      id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL REFERENCES clients(wallet_id),
      amount TEXT NOT NULL, asset TEXT NOT NULL, status TEXT NOT NULL,
      paid_at INTEGER NOT NULL, signature TEXT
    );
    CREATE TABLE IF NOT EXISTS inspection_observations (
      id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL, target_id TEXT REFERENCES watch_targets(id),
      event TEXT NOT NULL, status TEXT NOT NULL, observed_at INTEGER NOT NULL, detail_json TEXT NOT NULL
    );
  `);
  const rollupColumns = db.prepare("PRAGMA table_info(telemetry_rollups)").all();
  if (!rollupColumns.some(column => column.name === "latency_count")) {
    db.exec("ALTER TABLE telemetry_rollups ADD COLUMN latency_count INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE telemetry_rollups SET latency_count = CASE WHEN min_latency_ms IS NULL THEN 0 ELSE count END");
  }
  const evidenceColumns = db.prepare("PRAGMA table_info(evidence)").all();
  if (!evidenceColumns.some(column => column.name === "payload_hash")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("ALTER TABLE evidence ADD COLUMN payload_hash TEXT");
      const telemetryByEvidence = db.prepare("SELECT * FROM telemetry_samples WHERE evidence_id=?");
      const setPayloadHash = db.prepare("UPDATE evidence SET payload_hash=? WHERE id=?");
      for (const row of db.prepare("SELECT * FROM evidence").all()) {
        const telemetry = telemetryByEvidence.get(row.id);
        setPayloadHash.run(payloadHash({
          targetId: row.target_id, observedAt: row.observed_at, fetchedAt: row.fetched_at,
          value: JSON.parse(row.value_json), availability: row.availability,
          source: row.source, slot: row.slot, timeout: Boolean(telemetry?.timeout),
          latencyMs: telemetry?.latency_ms ?? null, sourceLagMs: telemetry?.source_lag_ms ?? null,
          disagreement: Boolean(telemetry?.disagreement), backlog: telemetry?.backlog ?? null,
          processingLagMs: telemetry?.processing_lag_ms ?? null,
        }), row.id);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  db.exec("PRAGMA user_version=5");
  const insertTarget = db.prepare("INSERT OR IGNORE INTO watch_targets(id,cluster,protocol,kind,address) VALUES(?,?,?,?,?)");
  const insertLink = db.prepare("INSERT OR IGNORE INTO position_targets(position_id,target_id) VALUES(?,?)");
  const currentState = db.prepare("SELECT * FROM current_target_state WHERE target_id=?");
  function parseState(row) {
    return row ? { targetId: row.target_id, evidenceId: row.evidence_id, observedAt: row.observed_at, fetchedAt: row.fetched_at, value: JSON.parse(row.value_json), valueHash: row.value_hash, availability: row.availability, source: row.source, slot: row.slot } : null;
  }
  function rebuildMaterialEvents(targetId) {
    const evidenceRows = db.prepare("SELECT * FROM evidence WHERE target_id=?").all(targetId)
      .map(row => ({ id: row.id, targetId: row.target_id, observedAt: row.observed_at, fetchedAt: row.fetched_at, valueHash: row.value_hash, slot: row.slot }))
      .sort(compareCurrent);
    db.prepare("DELETE FROM material_events WHERE target_id=?").run(targetId);
    const insertEvent = db.prepare("INSERT INTO material_events(id,target_id,evidence_id,previous_hash,value_hash,occurred_at) VALUES(?,?,?,?,?,?)");
    let previousHash = null;
    for (const row of evidenceRows) {
      if (row.valueHash === previousHash) continue;
      insertEvent.run(id([row.targetId, row.id, row.valueHash]), row.targetId, row.id, previousHash, row.valueHash, row.observedAt);
      previousHash = row.valueHash;
    }
  }
  return {
    linkPosition(positionId, target) {
      requiredId(positionId, "position_id");
      if (!CLUSTERS.has(target.cluster)) throw new TypeError("invalid_cluster");
      requiredId(target.protocol, "protocol"); requiredId(target.kind, "kind"); requiredId(target.address, "address");
      const targetId = id([target.cluster, target.protocol, target.kind, target.address]);
      insertTarget.run(targetId, target.cluster, target.protocol, target.kind, target.address);
      insertLink.run(positionId, targetId);
      return { targetId };
    },
    listTargets() {
      return db.prepare(`SELECT t.id, t.cluster, t.protocol, t.kind, t.address,
        count(p.position_id) AS position_count,
        count(w.wallet_id) AS wallet_count FROM watch_targets t
        LEFT JOIN position_targets p ON p.target_id=t.id
        LEFT JOIN clients w ON w.wallet_id=p.position_id
        GROUP BY t.id ORDER BY t.id`).all()
        .map(row => ({ id: row.id, cluster: row.cluster, protocol: row.protocol, kind: row.kind, address: row.address, positionCount: Number(row.position_count), walletCount: Number(row.wallet_count) }));
    },
    getCoverage() {
      const row = db.prepare(`SELECT count(*) AS wallet_target_links,
        count(DISTINCT p.position_id) AS distinct_wallets FROM position_targets p
        INNER JOIN clients c ON c.wallet_id=p.position_id`).get();
      return { walletTargetLinks: Number(row.wallet_target_links), distinctWallets: Number(row.distinct_wallets) };
    },
    recordInspectionObservation(observation) {
      requiredId(observation.id, "inspection_observation_id"); requiredId(observation.walletId, "wallet_id");
      requiredId(observation.event, "inspection_event"); requiredId(observation.status, "inspection_status");
      timestamp(observation.observedAt, "inspection_observed_at");
      db.prepare(`INSERT OR IGNORE INTO inspection_observations(id,wallet_id,target_id,event,status,observed_at,detail_json)
        VALUES(?,?,?,?,?,?,?)`).run(observation.id, observation.walletId, observation.targetId ?? null, observation.event, observation.status, observation.observedAt, stableJson(observation.detail ?? {}));
    },
    recordClientActivity(activity) {
      requiredId(activity.id, "client_activity_id"); requiredId(activity.walletId, "wallet_id");
      requiredId(activity.event, "client_event"); requiredId(activity.status, "client_status");
      timestamp(activity.observedAt, "client_observed_at");
      db.prepare(`INSERT INTO clients(wallet_id,enrolled_at,last_activity_at,status) VALUES(?,?,?,?)
        ON CONFLICT(wallet_id) DO UPDATE SET last_activity_at=max(last_activity_at,excluded.last_activity_at),status=excluded.status`)
        .run(activity.walletId, activity.observedAt, activity.observedAt, activity.status);
      db.prepare(`INSERT OR IGNORE INTO client_activity(id,wallet_id,event,status,observed_at,detail_json)
        VALUES(?,?,?,?,?,?)`).run(activity.id, activity.walletId, activity.event, activity.status, activity.observedAt, stableJson(activity.detail ?? {}));
    },
    recordEvacuationTransaction(transaction) {
      requiredId(transaction.walletId, "wallet_id"); requiredId(transaction.signature, "transaction_signature");
      requiredId(transaction.status, "transaction_status"); timestamp(transaction.observedAt, "transaction_observed_at");
      db.prepare(`INSERT INTO evacuation_transactions(wallet_id,signature,status,observed_at) VALUES(?,?,?,?)
        ON CONFLICT(wallet_id,signature) DO UPDATE SET status=excluded.status,observed_at=max(observed_at,excluded.observed_at)`)
        .run(transaction.walletId, transaction.signature, transaction.status, transaction.observedAt);
      db.prepare("UPDATE clients SET last_activity_at=max(last_activity_at,?) WHERE wallet_id=?").run(transaction.observedAt, transaction.walletId);
    },
    recordPayment(payment) {
      requiredId(payment.id, "payment_id"); requiredId(payment.walletId, "wallet_id");
      requiredId(payment.amount, "payment_amount"); requiredId(payment.asset, "payment_asset"); requiredId(payment.status, "payment_status");
      timestamp(payment.paidAt, "payment_paid_at");
      db.prepare(`INSERT OR IGNORE INTO client_payments(id,wallet_id,amount,asset,status,paid_at,signature) VALUES(?,?,?,?,?,?,?)`)
        .run(payment.id, payment.walletId, payment.amount, payment.asset, payment.status, payment.paidAt, payment.signature ?? null);
      db.prepare("UPDATE clients SET last_activity_at=max(last_activity_at,?) WHERE wallet_id=?").run(payment.paidAt, payment.walletId);
    },
    listClients() {
      return db.prepare(`SELECT c.wallet_id,c.enrolled_at,c.last_activity_at,c.status,
        count(DISTINCT a.id) AS activity_count,count(DISTINCT e.signature) AS evacuation_count,
        count(DISTINCT p.id) AS payment_count FROM clients c
        LEFT JOIN client_activity a ON a.wallet_id=c.wallet_id
        LEFT JOIN evacuation_transactions e ON e.wallet_id=c.wallet_id
        LEFT JOIN client_payments p ON p.wallet_id=c.wallet_id
        GROUP BY c.wallet_id ORDER BY c.last_activity_at DESC`).all().map(row => ({
          walletId: row.wallet_id, enrolledAt: row.enrolled_at, lastActivityAt: row.last_activity_at,
          status: row.status, activityCount: Number(row.activity_count), evacuationCount: Number(row.evacuation_count),
          paymentCount: Number(row.payment_count), paidAmount: null,
        }));
    },
    getClient(walletId) {
      requiredId(walletId, "wallet_id");
      const row = db.prepare("SELECT * FROM clients WHERE wallet_id=?").get(walletId);
      if (!row) return null;
      const activity = db.prepare("SELECT * FROM client_activity WHERE wallet_id=? ORDER BY observed_at DESC,id DESC").all(walletId)
        .map(item => ({ id: item.id, event: item.event, status: item.status, observedAt: item.observed_at, detail: JSON.parse(item.detail_json) }));
      const evacuationTransactions = db.prepare("SELECT signature,status,observed_at FROM evacuation_transactions WHERE wallet_id=? ORDER BY signature").all(walletId)
        .map(item => ({ signature: item.signature, status: item.status, observedAt: item.observed_at }));
      const payments = db.prepare("SELECT id,amount,asset,status,paid_at,signature FROM client_payments WHERE wallet_id=? ORDER BY paid_at DESC,id DESC").all(walletId)
        .map(item => ({ id: item.id, amount: item.amount, asset: item.asset, status: item.status, paidAt: item.paid_at, signature: item.signature }));
      const lastActivityAt = Math.max(row.last_activity_at, ...payments.map(item => item.paidAt));
      return { walletId: row.wallet_id, enrolledAt: row.enrolled_at, lastActivityAt, status: row.status, activity, evacuationTransactions, payments };
    },
    listWallets() { return this.listClients(); },
    getWallet(walletId) { return this.getClient(walletId); },
    setSetting(key, value, updatedAt) {
      requiredId(key, "setting_key"); timestamp(updatedAt, "setting_updated_at");
      db.prepare(`INSERT INTO admin_settings(key,value_json,updated_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(key, stableJson(value), updatedAt);
    },
    getSetting(key) {
      const row = db.prepare("SELECT value_json,updated_at FROM admin_settings WHERE key=?").get(key);
      return row ? { value: JSON.parse(row.value_json), updatedAt: row.updated_at } : null;
    },
    recordEvidence(evidence) {
      requiredId(evidence.id, "evidence_id"); requiredId(evidence.targetId, "target_id");
      timestamp(evidence.observedAt, "observed_at"); timestamp(evidence.fetchedAt, "fetched_at");
      const valueJson = stableJson(evidence.value ?? null);
      const valueHash = id([valueJson]);
      const evidencePayloadHash = payloadHash(immutablePayload(evidence, valueJson));
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db.prepare("SELECT payload_hash FROM evidence WHERE id=?").get(evidence.id);
        if (existing && existing.payload_hash !== evidencePayloadHash) throw new TypeError("conflicting_evidence_id");
        const previous = currentState.get(evidence.targetId);
        const result = db.prepare(`INSERT OR IGNORE INTO evidence
          (id,target_id,observed_at,fetched_at,value_json,value_hash,availability,source,slot,payload_hash)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(evidence.id, evidence.targetId, evidence.observedAt, evidence.fetchedAt, valueJson, valueHash, evidence.availability, evidence.source ?? null, evidence.slot ?? null, evidencePayloadHash);
        if (!result.changes) { db.exec("COMMIT"); return { inserted: false, changed: false, eventCreated: false }; }
        const isCurrent = !previous || compareCurrent(evidence, previous) > 0;
        const changed = isCurrent && (!previous || previous.value_hash !== valueHash);
        if (isCurrent) db.prepare(`INSERT INTO current_target_state
          (target_id,evidence_id,observed_at,fetched_at,value_json,value_hash,availability,source,slot)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(target_id) DO UPDATE SET
          evidence_id=excluded.evidence_id,observed_at=excluded.observed_at,fetched_at=excluded.fetched_at,
          value_json=excluded.value_json,value_hash=excluded.value_hash,availability=excluded.availability,
          source=excluded.source,slot=excluded.slot`).run(evidence.targetId, evidence.id, evidence.observedAt, evidence.fetchedAt, valueJson, valueHash, evidence.availability, evidence.source ?? null, evidence.slot ?? null);
        db.prepare(`INSERT INTO telemetry_samples(target_id,evidence_id,sampled_at,success,timeout,latency_ms,source_lag_ms,slot,disagreement,provider,backlog,processing_lag_ms)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(evidence.targetId, evidence.id, evidence.fetchedAt, evidence.availability === "available" ? 1 : 0, evidence.timeout ? 1 : 0, evidence.latencyMs ?? null, evidence.sourceLagMs ?? null, evidence.slot ?? null, evidence.disagreement ? 1 : 0, evidence.source ?? null, evidence.backlog ?? null, evidence.processingLagMs ?? null);
        const priorEventCount = Number(db.prepare("SELECT count(*) AS n FROM material_events WHERE target_id=?").get(evidence.targetId).n);
        rebuildMaterialEvents(evidence.targetId);
        const eventCount = Number(db.prepare("SELECT count(*) AS n FROM material_events WHERE target_id=?").get(evidence.targetId).n);
        const eventCreated = eventCount > priorEventCount;
        db.exec("COMMIT");
        return { inserted: true, changed, eventCreated };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    getCurrentState(targetId) { return parseState(currentState.get(targetId)); },
    setCursor(name, value, updatedAt) {
      db.prepare(`INSERT INTO cursors(name,value_json,updated_at) VALUES(?,?,?)
        ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(name, JSON.stringify(value), updatedAt);
    },
    getCursor(name) {
      const row = db.prepare("SELECT value_json,updated_at FROM cursors WHERE name=?").get(name);
      return row ? { value: JSON.parse(row.value_json), updatedAt: row.updated_at } : null;
    },
    recordIncident(incident) {
      db.prepare("INSERT OR IGNORE INTO service_incidents(id,kind,started_at,resolved_at,detail_json) VALUES(?,?,?,?,?)")
        .run(incident.id, incident.kind, incident.startedAt, incident.resolvedAt ?? null, JSON.stringify(incident.detail ?? {}));
    },
    listIncidents() {
      return db.prepare("SELECT * FROM service_incidents ORDER BY started_at DESC").all().map(row => ({ id: row.id, kind: row.kind, startedAt: row.started_at, resolvedAt: row.resolved_at, detail: JSON.parse(row.detail_json) }));
    },
    checkpoint(mode = "PASSIVE") {
      if (!["PASSIVE", "FULL", "RESTART", "TRUNCATE"].includes(mode)) throw new TypeError("invalid_checkpoint_mode");
      return db.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
    },
    recordTelemetry(sample) {
      db.prepare(`INSERT INTO telemetry_samples(target_id,evidence_id,sampled_at,success,timeout,latency_ms,source_lag_ms,slot,disagreement,provider,backlog,processing_lag_ms)
        VALUES(NULL,NULL,?,?,?,?,?,?,?,?,?,?)`).run(sample.sampledAt, sample.success ? 1 : 0, sample.timeout ? 1 : 0, sample.latencyMs ?? null, sample.sourceLagMs ?? null, sample.slot ?? null, sample.disagreement ? 1 : 0, sample.provider ?? null, sample.backlog ?? null, sample.processingLagMs ?? null);
    },
    listTelemetry({ tier = "raw" } = {}) {
      if (tier === "raw") return db.prepare("SELECT * FROM telemetry_samples ORDER BY sampled_at").all().map(row => ({ sampledAt: row.sampled_at, success: Boolean(row.success), timeout: Boolean(row.timeout), latencyMs: row.latency_ms, sourceLagMs: row.source_lag_ms, slot: row.slot, disagreement: Boolean(row.disagreement), provider: row.provider, backlog: row.backlog, processingLagMs: row.processing_lag_ms }));
      return db.prepare("SELECT * FROM telemetry_rollups WHERE tier=? ORDER BY bucket_start,provider").all(tier).map(row => ({ tier: row.tier, bucketStart: row.bucket_start, provider: row.provider || null, count: Number(row.count), successes: Number(row.successes), failures: Number(row.failures), timeouts: Number(row.timeouts), minLatencyMs: row.min_latency_ms, maxLatencyMs: row.max_latency_ms, averageLatencyMs: row.latency_count ? row.latency_sum_ms / row.latency_count : null, maxSourceLagMs: row.max_source_lag_ms, minSlot: row.min_slot, maxSlot: row.max_slot, disagreements: Number(row.disagreements), firstAt: row.first_at, lastAt: row.last_at }));
    },
    compactRaw({ before, bucketSeconds = 60, tier = "1m" }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const rows = db.prepare("SELECT * FROM telemetry_samples WHERE sampled_at < ? ORDER BY sampled_at").all(before);
        const groups = new Map();
        for (const row of rows) {
          const bucket = Math.floor(row.sampled_at / bucketSeconds) * bucketSeconds;
          const provider = row.provider ?? "";
          const key = `${bucket}\0${provider}`;
          const g = groups.get(key) ?? { bucket, provider, rows: [] };
          g.rows.push(row); groups.set(key, g);
        }
        const insert = db.prepare(`INSERT INTO telemetry_rollups(tier,bucket_start,provider,count,successes,failures,timeouts,min_latency_ms,max_latency_ms,latency_sum_ms,latency_count,max_source_lag_ms,min_slot,max_slot,disagreements,first_at,last_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(tier,bucket_start,provider) DO UPDATE SET
          count=count+excluded.count,successes=successes+excluded.successes,failures=failures+excluded.failures,
          timeouts=timeouts+excluded.timeouts,
          min_latency_ms=CASE WHEN min_latency_ms IS NULL THEN excluded.min_latency_ms WHEN excluded.min_latency_ms IS NULL THEN min_latency_ms ELSE min(min_latency_ms,excluded.min_latency_ms) END,
          max_latency_ms=CASE WHEN max_latency_ms IS NULL THEN excluded.max_latency_ms WHEN excluded.max_latency_ms IS NULL THEN max_latency_ms ELSE max(max_latency_ms,excluded.max_latency_ms) END,
          latency_sum_ms=latency_sum_ms+excluded.latency_sum_ms,latency_count=latency_count+excluded.latency_count,
          max_source_lag_ms=CASE WHEN max_source_lag_ms IS NULL THEN excluded.max_source_lag_ms WHEN excluded.max_source_lag_ms IS NULL THEN max_source_lag_ms ELSE max(max_source_lag_ms,excluded.max_source_lag_ms) END,
          min_slot=CASE WHEN min_slot IS NULL THEN excluded.min_slot WHEN excluded.min_slot IS NULL THEN min_slot ELSE min(min_slot,excluded.min_slot) END,
          max_slot=CASE WHEN max_slot IS NULL THEN excluded.max_slot WHEN excluded.max_slot IS NULL THEN max_slot ELSE max(max_slot,excluded.max_slot) END,
          disagreements=disagreements+excluded.disagreements,first_at=min(first_at,excluded.first_at),last_at=max(last_at,excluded.last_at)`);
        for (const { bucket, provider, rows: group } of groups.values()) {
          const values = key => group.map(row => row[key]).filter(value => value !== null);
          const latencies = values("latency_ms"), lags = values("source_lag_ms"), slots = values("slot");
          insert.run(tier, bucket, provider, group.length, group.reduce((n,r)=>n+r.success,0), group.reduce((n,r)=>n+(r.success?0:1),0), group.reduce((n,r)=>n+r.timeout,0), latencies.length ? Math.min(...latencies) : null, latencies.length ? Math.max(...latencies) : null, latencies.reduce((a,b)=>a+b,0), latencies.length, lags.length ? Math.max(...lags) : null, slots.length ? Math.min(...slots) : null, slots.length ? Math.max(...slots) : null, group.reduce((n,r)=>n+r.disagreement,0), group[0].sampled_at, group.at(-1).sampled_at);
        }
        const deleted = db.prepare("DELETE FROM telemetry_samples WHERE sampled_at < ?").run(before).changes;
        db.exec("COMMIT"); return Number(deleted);
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    compactRollups({ fromTier, toTier, before, bucketSeconds }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const rows = db.prepare("SELECT * FROM telemetry_rollups WHERE tier=? AND last_at < ? ORDER BY first_at").all(fromTier, before);
        const groups = new Map();
        for (const row of rows) { const bucket=Math.floor(row.bucket_start/bucketSeconds)*bucketSeconds; const key=`${bucket}\0${row.provider}`; const g=groups.get(key)??{bucket,provider:row.provider,rows:[]}; g.rows.push(row); groups.set(key,g); }
        const insert=db.prepare(`INSERT INTO telemetry_rollups(tier,bucket_start,provider,count,successes,failures,timeouts,min_latency_ms,max_latency_ms,latency_sum_ms,latency_count,max_source_lag_ms,min_slot,max_slot,disagreements,first_at,last_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(tier,bucket_start,provider) DO UPDATE SET
          count=count+excluded.count,successes=successes+excluded.successes,failures=failures+excluded.failures,
          timeouts=timeouts+excluded.timeouts,
          min_latency_ms=CASE WHEN min_latency_ms IS NULL THEN excluded.min_latency_ms WHEN excluded.min_latency_ms IS NULL THEN min_latency_ms ELSE min(min_latency_ms,excluded.min_latency_ms) END,
          max_latency_ms=CASE WHEN max_latency_ms IS NULL THEN excluded.max_latency_ms WHEN excluded.max_latency_ms IS NULL THEN max_latency_ms ELSE max(max_latency_ms,excluded.max_latency_ms) END,
          latency_sum_ms=latency_sum_ms+excluded.latency_sum_ms,latency_count=latency_count+excluded.latency_count,
          max_source_lag_ms=CASE WHEN max_source_lag_ms IS NULL THEN excluded.max_source_lag_ms WHEN excluded.max_source_lag_ms IS NULL THEN max_source_lag_ms ELSE max(max_source_lag_ms,excluded.max_source_lag_ms) END,
          min_slot=CASE WHEN min_slot IS NULL THEN excluded.min_slot WHEN excluded.min_slot IS NULL THEN min_slot ELSE min(min_slot,excluded.min_slot) END,
          max_slot=CASE WHEN max_slot IS NULL THEN excluded.max_slot WHEN excluded.max_slot IS NULL THEN max_slot ELSE max(max_slot,excluded.max_slot) END,
          disagreements=disagreements+excluded.disagreements,first_at=min(first_at,excluded.first_at),last_at=max(last_at,excluded.last_at)`);
        const vals=(rows,key)=>rows.map(r=>r[key]).filter(v=>v!==null);
        for(const g of groups.values()){const n=vals(g.rows,"count"),lat=vals(g.rows,"min_latency_ms"),maxlat=vals(g.rows,"max_latency_ms"),lags=vals(g.rows,"max_source_lag_ms"),slots1=vals(g.rows,"min_slot"),slots2=vals(g.rows,"max_slot");insert.run(toTier,g.bucket,g.provider,n.reduce((a,b)=>a+b,0),vals(g.rows,"successes").reduce((a,b)=>a+b,0),vals(g.rows,"failures").reduce((a,b)=>a+b,0),vals(g.rows,"timeouts").reduce((a,b)=>a+b,0),lat.length?Math.min(...lat):null,maxlat.length?Math.max(...maxlat):null,vals(g.rows,"latency_sum_ms").reduce((a,b)=>a+b,0),vals(g.rows,"latency_count").reduce((a,b)=>a+b,0),lags.length?Math.max(...lags):null,slots1.length?Math.min(...slots1):null,slots2.length?Math.max(...slots2):null,vals(g.rows,"disagreements").reduce((a,b)=>a+b,0),Math.min(...vals(g.rows,"first_at")),Math.max(...vals(g.rows,"last_at")));}
        const deleted=Number(db.prepare("DELETE FROM telemetry_rollups WHERE tier=? AND last_at < ?").run(fromTier,before).changes); db.exec("COMMIT"); return deleted;
      } catch(error){db.exec("ROLLBACK");throw error;}
    },
    pruneRollups({ tier, before }) {
      return Number(db.prepare("DELETE FROM telemetry_rollups WHERE tier=? AND last_at < ?").run(tier, before).changes);
    },
    counts() {
      const count = table => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
      return { targets: count("watch_targets"), evidence: count("evidence"), events: count("material_events"), telemetry: count("telemetry_samples"), incidents: count("service_incidents") };
    },
    close() { db.close(); },
  };
}
