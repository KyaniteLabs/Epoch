-- Epoch public telemetry receiver — D1 staging schema.
-- Staging-first ingestion: nothing here auto-feeds the community reference
-- database. Promotion to the public dataset is a separate reviewed batch step.

CREATE TABLE IF NOT EXISTS records (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	installation_id TEXT NOT NULL,
	schema_version INTEGER NOT NULL,
	epoch_version TEXT NOT NULL,
	client_name TEXT,
	client_version TEXT,
	transport TEXT,
	runtime_hint TEXT,
	task_type TEXT NOT NULL,
	complexity INTEGER,
	tool TEXT NOT NULL,
	estimated_hours REAL NOT NULL,
	actual_hours REAL NOT NULL,
	ratio REAL NOT NULL,
	record_date TEXT NOT NULL,
	completed_at TEXT,
	received_at TEXT NOT NULL,
	received_day TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_installation_day ON records (installation_id, received_day);
CREATE INDEX IF NOT EXISTS idx_records_received_at ON records (received_at);
CREATE INDEX IF NOT EXISTS idx_records_client_name ON records (client_name);
CREATE INDEX IF NOT EXISTS idx_records_epoch_version ON records (epoch_version);

CREATE TABLE IF NOT EXISTS dedup_keys (
	key TEXT PRIMARY KEY,
	received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	received_at TEXT NOT NULL,
	installation_id TEXT NOT NULL,
	schema_version INTEGER NOT NULL,
	epoch_version TEXT NOT NULL,
	accepted INTEGER NOT NULL,
	deduplicated INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_received_at ON receipts (received_at);
