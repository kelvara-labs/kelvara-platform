CREATE TABLE scenario_capsule_observations (
  evidence_ref TEXT PRIMARY KEY CHECK(length(evidence_ref) BETWEEN 1 AND 256),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  network TEXT NOT NULL CHECK(network='devnet'),
  program_id TEXT NOT NULL CHECK(length(program_id) BETWEEN 32 AND 44),
  session_address TEXT NOT NULL CHECK(length(session_address) BETWEEN 32 AND 44),
  authority TEXT NOT NULL CHECK(length(authority) BETWEEN 32 AND 44),
  session_id TEXT NOT NULL CHECK(length(session_id)=64 AND session_id NOT GLOB '*[^0-9a-f]*'),
  flags INTEGER NOT NULL CHECK(flags IN (0,4)),
  sequence TEXT NOT NULL CHECK(sequence GLOB '[0-9]*' AND length(sequence) BETWEEN 1 AND 20),
  finalized_slot INTEGER NOT NULL CHECK(finalized_slot>=0 AND finalized_slot<=9007199254740991),
  observed_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX scenario_capsule_observations_session_slot ON scenario_capsule_observations(session_address,finalized_slot);
CREATE TRIGGER scenario_capsule_observations_no_update BEFORE UPDATE ON scenario_capsule_observations BEGIN
  SELECT RAISE(ABORT,'append_only_scenario_capsule_observation');
END;
CREATE TRIGGER scenario_capsule_observations_no_delete BEFORE DELETE ON scenario_capsule_observations BEGIN
  SELECT RAISE(ABORT,'append_only_scenario_capsule_observation');
END;
