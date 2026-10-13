CREATE TABLE IF NOT EXISTS indexers (
  id TEXT PRIMARY KEY,
  protocol TEXT NOT NULL,
  network TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT
);

CREATE TABLE IF NOT EXISTS indexer_targets (
  id TEXT PRIMARY KEY,
  indexer_id TEXT NOT NULL REFERENCES indexers(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  network TEXT NOT NULL,
  kind TEXT NOT NULL,
  address TEXT NOT NULL,
  display_name TEXT NOT NULL,
  curator TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  UNIQUE (indexer_id, network, address)
);

CREATE TABLE IF NOT EXISTS ingestion_batches (
  indexer_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (indexer_id, batch_id)
);

CREATE TABLE IF NOT EXISTS indexer_cursors (
  indexer_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  slot INTEGER NOT NULL,
  signature TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (indexer_id, target_id, stream)
);

CREATE TABLE IF NOT EXISTS raw_accounts (
  id INTEGER PRIMARY KEY,
  target_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  address TEXT NOT NULL,
  account_hash TEXT NOT NULL,
  owner TEXT NOT NULL,
  data_length INTEGER NOT NULL,
  data_hash TEXT NOT NULL,
  executable INTEGER NOT NULL CHECK (executable IN (0, 1)),
  decoder_family TEXT NOT NULL,
  decoder_version TEXT NOT NULL,
  UNIQUE (target_id, slot, data_hash)
);

CREATE TABLE IF NOT EXISTS vault_snapshots (
  id INTEGER PRIMARY KEY,
  target_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  account_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  decoder_version TEXT NOT NULL,
  vault_admin_authority TEXT NOT NULL,
  allocation_admin TEXT,
  pending_admin TEXT NOT NULL,
  token_mint TEXT NOT NULL,
  shares_mint TEXT NOT NULL,
  token_available TEXT NOT NULL,
  shares_issued TEXT NOT NULL,
  previous_aum_scaled TEXT NOT NULL,
  pending_fees_scaled TEXT NOT NULL,
  performance_fee_bps TEXT NOT NULL,
  management_fee_bps TEXT NOT NULL,
  UNIQUE (target_id, slot, account_hash)
);

CREATE TABLE IF NOT EXISTS vault_allocations (
  snapshot_id INTEGER NOT NULL REFERENCES vault_snapshots(id) ON DELETE CASCADE,
  reserve TEXT NOT NULL,
  target_allocation_weight TEXT NOT NULL,
  ctoken_allocation TEXT NOT NULL,
  token_allocation_cap TEXT NOT NULL,
  ctoken_allocation_cap TEXT NOT NULL,
  token_target_allocation_scaled TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, reserve)
);
