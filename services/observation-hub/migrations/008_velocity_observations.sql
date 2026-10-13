CREATE TABLE IF NOT EXISTS velocity_observations (
 observation_id TEXT PRIMARY KEY CHECK(length(observation_id) BETWEEN 1 AND 128),
 kind TEXT NOT NULL CHECK(kind IN ('program','account')),
 network TEXT NOT NULL CHECK(network IN ('mainnet-beta','devnet','testnet','localnet')), program_id TEXT NOT NULL, address TEXT NOT NULL,
 slot INTEGER NOT NULL CHECK(slot >= 0 AND slot <= 9007199254740991), owner TEXT, executable INTEGER CHECK(executable IS NULL OR executable IN (0,1)),
 data_length INTEGER CHECK(data_length IS NULL OR (data_length >= 0 AND data_length <= 9007199254740991)), data_hash TEXT CHECK(data_hash IS NULL OR (length(data_hash)=64 AND data_hash NOT GLOB '*[^0-9a-f]*')), observed_at TEXT NOT NULL,
 provenance TEXT NOT NULL CHECK(json_valid(provenance)), status TEXT NOT NULL CHECK(status IN ('verified','unknown','unresolved')),
 unknown_reason TEXT, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
 UNIQUE(program_id,address,slot)
);
CREATE INDEX IF NOT EXISTS velocity_observations_address_slot ON velocity_observations(address,slot DESC);
CREATE TRIGGER IF NOT EXISTS velocity_observations_no_update BEFORE UPDATE ON velocity_observations BEGIN SELECT RAISE(ABORT,'append_only_velocity_observation'); END;
CREATE TRIGGER IF NOT EXISTS velocity_observations_no_delete BEFORE DELETE ON velocity_observations BEGIN SELECT RAISE(ABORT,'append_only_velocity_observation'); END;
