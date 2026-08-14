CREATE TABLE plan_mutation_guards (
  request_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  target_version INTEGER NOT NULL CHECK (target_version = source_version + 1),
  target_active INTEGER NOT NULL CHECK (target_active IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;
