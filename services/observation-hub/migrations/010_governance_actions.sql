CREATE TABLE governance_actions (
  action_id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  program_id TEXT NOT NULL,
  multisig_address TEXT NOT NULL,
  vault_address TEXT NOT NULL,
  action_type TEXT NOT NULL,
  transaction_index INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(network,program_id,multisig_address,vault_address,action_type,transaction_index)
);
CREATE TABLE governance_action_observations (
  observation_id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES governance_actions(action_id),
  payload_hash TEXT NOT NULL,
  batch_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  observed_slot INTEGER NOT NULL CHECK(observed_slot>=0),
  observed_at TEXT NOT NULL,
  canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json)),
  created_at TEXT NOT NULL,
  UNIQUE(action_id,observed_slot,payload_hash)
);
CREATE INDEX governance_action_observations_history ON governance_action_observations(action_id,observed_slot);
CREATE TRIGGER governance_actions_no_update BEFORE UPDATE ON governance_actions BEGIN SELECT RAISE(ABORT,'append_only_governance_action'); END;
CREATE TRIGGER governance_actions_no_delete BEFORE DELETE ON governance_actions BEGIN SELECT RAISE(ABORT,'append_only_governance_action'); END;
CREATE TRIGGER governance_action_observations_no_update BEFORE UPDATE ON governance_action_observations BEGIN SELECT RAISE(ABORT,'append_only_governance_action_observation'); END;
CREATE TRIGGER governance_action_observations_no_delete BEFORE DELETE ON governance_action_observations BEGIN SELECT RAISE(ABORT,'append_only_governance_action_observation'); END;
