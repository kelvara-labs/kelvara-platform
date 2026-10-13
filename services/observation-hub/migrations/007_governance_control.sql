CREATE TABLE IF NOT EXISTS governance_control_observations (
  observation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  batch_hash TEXT NOT NULL CHECK (length(batch_hash) = 64 AND batch_hash NOT GLOB '*[^0-9a-f]*'),
  subject_address TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('mainnet-beta', 'devnet', 'testnet', 'localnet')),
  provider TEXT NOT NULL CHECK (provider = 'squads'),
  generation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified', 'unsupported', 'invalid')),
  program_id TEXT,
  multisig_address TEXT,
  authority_address TEXT,
  authority_index INTEGER CHECK (authority_index IS NULL OR (authority_index >= 0 AND authority_index <= 255)),
  threshold INTEGER CHECK (threshold IS NULL OR (threshold > 0 AND threshold <= 64)),
  time_lock_seconds INTEGER CHECK (time_lock_seconds IS NULL OR (time_lock_seconds >= 0 AND time_lock_seconds <= 31536000)),
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
  finalized_slot INTEGER NOT NULL CHECK (finalized_slot >= 0 AND finalized_slot <= 9007199254740991),
  observed_at TEXT NOT NULL,
  decoder_family TEXT NOT NULL,
  decoder_version TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS governance_control_identity ON governance_control_observations(subject_address, network, program_id, provider, generation, finalized_slot, payload_hash);
CREATE TRIGGER IF NOT EXISTS governance_control_no_update BEFORE UPDATE ON governance_control_observations BEGIN SELECT RAISE(ABORT, 'append_only_governance_control'); END;
CREATE TRIGGER IF NOT EXISTS governance_control_no_delete BEFORE DELETE ON governance_control_observations BEGIN SELECT RAISE(ABORT, 'append_only_governance_control'); END;
