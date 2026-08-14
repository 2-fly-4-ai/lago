ALTER TABLE plans ADD COLUMN parent_id TEXT REFERENCES plans(id) ON DELETE RESTRICT;

ALTER TABLE charges ADD COLUMN parent_id TEXT REFERENCES charges(id) ON DELETE RESTRICT;

ALTER TABLE fixed_charges ADD COLUMN parent_id TEXT REFERENCES fixed_charges(id) ON DELETE RESTRICT;

CREATE INDEX plans_parent_idx ON plans(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX charges_parent_idx ON charges(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX fixed_charges_parent_idx ON fixed_charges(parent_id) WHERE parent_id IS NOT NULL;
