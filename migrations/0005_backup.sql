CREATE TABLE IF NOT EXISTS backup_settings (
  account_id TEXT PRIMARY KEY,
  encrypted_payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
  remote_name TEXT,
  size INTEGER,
  counts TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS backup_runs_account_started ON backup_runs(account_id, started_at DESC);
