PRAGMA foreign_keys = ON;

ALTER TABLE api_keys ADD COLUMN last_used_at TEXT;

CREATE INDEX api_keys_last_used_at_idx ON api_keys(last_used_at DESC, id)
  WHERE last_used_at IS NOT NULL;
