CREATE TABLE governance_detections (
 detection_id TEXT PRIMARY KEY,
 rule_id TEXT NOT NULL,
 action_id TEXT NOT NULL,
 network TEXT NOT NULL,
 provider TEXT NOT NULL,
 generation TEXT NOT NULL,
 program_id TEXT NOT NULL,
 multisig_address TEXT NOT NULL,
 vault_address TEXT NOT NULL,
 first_observed_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(rule_id,action_id,network,provider,generation,program_id,multisig_address,vault_address)
);
CREATE TABLE governance_detection_observations (
 observation_id TEXT PRIMARY KEY,
 detection_id TEXT NOT NULL REFERENCES governance_detections(detection_id),
 payload_hash TEXT NOT NULL,
 severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical-time','critical','unknown')),
 current_state TEXT NOT NULL CHECK(current_state IN ('open','resolved')),
 observed_at TEXT NOT NULL,
 evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json)),
 canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json)),
 created_at TEXT NOT NULL
);
CREATE INDEX governance_detection_history ON governance_detection_observations(detection_id,observed_at,observation_id);
CREATE TRIGGER governance_detections_no_update BEFORE UPDATE ON governance_detections BEGIN SELECT RAISE(ABORT,'append_only_governance_detection'); END;
CREATE TRIGGER governance_detections_no_delete BEFORE DELETE ON governance_detections BEGIN SELECT RAISE(ABORT,'append_only_governance_detection'); END;
CREATE TRIGGER governance_detection_observations_no_update BEFORE UPDATE ON governance_detection_observations BEGIN SELECT RAISE(ABORT,'append_only_governance_detection_observation'); END;
CREATE TRIGGER governance_detection_observations_no_delete BEFORE DELETE ON governance_detection_observations BEGIN SELECT RAISE(ABORT,'append_only_governance_detection_observation'); END;
