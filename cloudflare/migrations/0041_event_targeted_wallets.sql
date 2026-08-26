ALTER TABLE charges ADD COLUMN accepts_target_wallet INTEGER NOT NULL DEFAULT 0
  CHECK (accepts_target_wallet IN (0, 1));

CREATE INDEX charges_accepts_target_wallet_idx
  ON charges(organization_id, plan_id, billable_metric_id)
  WHERE active = 1 AND accepts_target_wallet = 1;
