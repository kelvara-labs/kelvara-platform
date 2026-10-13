CREATE TABLE evaluation_receipts (
  receipt_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  policy_revision INTEGER NOT NULL CHECK(policy_revision > 0 AND policy_revision <= 9007199254740991),
  rule_id TEXT NOT NULL CHECK(length(rule_id) BETWEEN 1 AND 128),
  rule_version INTEGER NOT NULL CHECK(rule_version > 0 AND rule_version <= 9007199254740991),
  binding_id TEXT NOT NULL CHECK(length(binding_id) BETWEEN 1 AND 128),
  target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 128),
  evidence_refs_json TEXT NOT NULL CHECK(json_valid(evidence_refs_json)),
  evaluator_version TEXT NOT NULL CHECK(length(evaluator_version) BETWEEN 1 AND 64),
  result TEXT NOT NULL CHECK(result IN ('pass','fail','unknown','stale')),
  evaluated_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX evaluation_receipts_payload_identity ON evaluation_receipts(idempotency_key, payload_hash);
CREATE INDEX evaluation_receipts_target_time ON evaluation_receipts(target_id, evaluated_at);
CREATE TRIGGER evaluation_receipts_no_update BEFORE UPDATE ON evaluation_receipts BEGIN
  SELECT RAISE(ABORT,'append_only_evaluation_receipt');
END;
CREATE TRIGGER evaluation_receipts_no_delete BEFORE DELETE ON evaluation_receipts BEGIN
  SELECT RAISE(ABORT,'append_only_evaluation_receipt');
END;
