CREATE TABLE IF NOT EXISTS evacuation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  network TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  signature TEXT,
  confirmation_status TEXT,
  confirmation_slot INTEGER,
  observed_at TEXT NOT NULL,
  UNIQUE (fingerprint, signature, status)
);
CREATE INDEX IF NOT EXISTS evacuation_events_observed_at_idx ON evacuation_events(observed_at);
