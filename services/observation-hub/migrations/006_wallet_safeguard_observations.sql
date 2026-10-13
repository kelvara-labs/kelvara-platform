CREATE TABLE wallet_safeguard_observations (
  evidence_ref TEXT PRIMARY KEY CHECK(length(evidence_ref) BETWEEN 1 AND 256),
  producer_id TEXT NOT NULL CHECK(length(producer_id) BETWEEN 1 AND 128),
  target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 128),
  observed_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX wallet_safeguard_observations_identity ON wallet_safeguard_observations(producer_id,target_id,evidence_ref);
CREATE TRIGGER wallet_safeguard_observations_no_update BEFORE UPDATE ON wallet_safeguard_observations BEGIN
  SELECT RAISE(ABORT,'append_only_wallet_safeguard_observation');
END;
CREATE TRIGGER wallet_safeguard_observations_no_delete BEFORE DELETE ON wallet_safeguard_observations BEGIN
  SELECT RAISE(ABORT,'append_only_wallet_safeguard_observation');
END;
