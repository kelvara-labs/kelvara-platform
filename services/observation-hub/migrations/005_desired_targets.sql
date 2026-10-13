CREATE TABLE IF NOT EXISTS desired_targets (
  target_id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  network TEXT NOT NULL,
  protocol TEXT NOT NULL,
  kind TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','validating','validated','activated','provisioning','observing','degraded','paused','retired')),
  revision INTEGER NOT NULL,
  decoder_family TEXT,
  decoder_version TEXT,
  expected_owner TEXT,
  expected_data_length INTEGER,
  updated_at TEXT NOT NULL,
  UNIQUE(chain, network, protocol, kind, address)
);

CREATE TABLE IF NOT EXISTS reconciliation_history (
  id INTEGER PRIMARY KEY,
  indexer_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('accepted','unsupported','provisioning','observing','degraded','paused','retired')),
  cursor_json TEXT,
  error_json TEXT,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS target_assignments (
  target_id TEXT NOT NULL REFERENCES desired_targets(target_id),
  indexer_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  network TEXT NOT NULL,
  assignment_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(target_id, indexer_id)
);
