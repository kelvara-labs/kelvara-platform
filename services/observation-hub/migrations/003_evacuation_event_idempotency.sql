PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

ALTER TABLE evacuation_events RENAME TO evacuation_events_v002;

CREATE TABLE evacuation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  network TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  signature TEXT,
  confirmation_status TEXT,
  confirmation_slot INTEGER,
  observed_at TEXT NOT NULL
);

INSERT INTO evacuation_events (
  id, event_id, idempotency_key, fingerprint, wallet_address, network, status,
  trigger_reason, signature, confirmation_status, confirmation_slot, observed_at
)
SELECT
  id, 'legacy-event-' || id, 'legacy-evacuation-event-' || id, fingerprint,
  wallet_address, network, status, trigger_reason, signature,
  confirmation_status, confirmation_slot, observed_at
FROM evacuation_events_v002;

DROP TABLE evacuation_events_v002;
CREATE INDEX evacuation_events_observed_at_idx ON evacuation_events(observed_at DESC, id DESC);
COMMIT;
PRAGMA foreign_keys = ON;
