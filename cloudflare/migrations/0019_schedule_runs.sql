CREATE TABLE schedule_runs (
  id TEXT PRIMARY KEY,
  cron TEXT NOT NULL,
  triggered_at_ms INTEGER NOT NULL,
  triggered_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'partial', 'completed', 'failed')),
  due_schedules_json TEXT NOT NULL,
  unimplemented_schedules_json TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (cron, triggered_at_ms)
) STRICT;

CREATE INDEX schedule_runs_status_idx ON schedule_runs(status, triggered_at_ms);
