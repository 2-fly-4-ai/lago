ALTER TABLE fixed_charges ADD COLUMN version INTEGER NOT NULL DEFAULT 1
  CHECK (version > 0);

ALTER TABLE fixed_charges ADD COLUMN active INTEGER NOT NULL DEFAULT 1
  CHECK (active IN (0, 1));

CREATE INDEX fixed_charges_active_plan_idx
  ON fixed_charges(plan_id, created_at)
  WHERE active = 1;
