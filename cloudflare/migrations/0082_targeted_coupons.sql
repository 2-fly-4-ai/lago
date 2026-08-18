CREATE TABLE coupon_targets (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  coupon_id TEXT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('plan', 'billable_metric')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, coupon_id, target_type, target_id)
) STRICT;

CREATE INDEX coupon_targets_coupon_idx
  ON coupon_targets(organization_id, coupon_id, target_type, created_at, target_id);

CREATE TRIGGER coupon_target_requires_owned_resource
BEFORE INSERT ON coupon_targets
WHEN NOT EXISTS (
  SELECT 1 FROM coupons
  WHERE id = NEW.coupon_id AND organization_id = NEW.organization_id
) OR (
  NEW.target_type = 'plan' AND NOT EXISTS (
    SELECT 1 FROM plans
    WHERE id = NEW.target_id AND organization_id = NEW.organization_id
      AND parent_id IS NULL AND active = 1
  )
) OR (
  NEW.target_type = 'billable_metric' AND NOT EXISTS (
    SELECT 1 FROM billable_metrics
    WHERE id = NEW.target_id AND organization_id = NEW.organization_id AND active = 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'coupon_target_scope_conflict');
END;

CREATE TRIGGER coupon_target_identity_immutable
BEFORE UPDATE ON coupon_targets
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.coupon_id <> NEW.coupon_id
  OR OLD.target_type <> NEW.target_type
  OR OLD.target_id <> NEW.target_id
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'coupon_target_identity_immutable');
END;

CREATE TRIGGER coupon_plan_delete_removes_targets
AFTER DELETE ON plans
WHEN OLD.parent_id IS NULL
BEGIN
  DELETE FROM coupon_targets
  WHERE organization_id = OLD.organization_id AND target_type = 'plan' AND target_id = OLD.id;
END;

CREATE TRIGGER coupon_metric_delete_removes_targets
AFTER DELETE ON billable_metrics
BEGIN
  DELETE FROM coupon_targets
  WHERE organization_id = OLD.organization_id
    AND target_type = 'billable_metric' AND target_id = OLD.id;
END;

ALTER TABLE coupon_credits
  ADD COLUMN allocations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allocations_json));

CREATE TABLE coupon_credit_lines (
  coupon_credit_id TEXT NOT NULL REFERENCES coupon_credits(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  invoice_line_id TEXT NOT NULL REFERENCES invoice_lines(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (coupon_credit_id, invoice_line_id)
) STRICT;

CREATE INDEX coupon_credit_lines_invoice_idx
  ON coupon_credit_lines(organization_id, invoice_id, invoice_line_id, coupon_credit_id);

CREATE TRIGGER coupon_credit_line_requires_owned_credit_and_line
BEFORE INSERT ON coupon_credit_lines
WHEN NOT EXISTS (
  SELECT 1 FROM coupon_credits credit
  JOIN invoice_lines line ON line.id = NEW.invoice_line_id
  JOIN invoices invoice ON invoice.id = NEW.invoice_id
  WHERE credit.id = NEW.coupon_credit_id
    AND credit.organization_id = NEW.organization_id
    AND credit.invoice_id = NEW.invoice_id
    AND line.invoice_id = NEW.invoice_id
    AND invoice.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'coupon_credit_line_scope_conflict');
END;

CREATE TRIGGER coupon_credit_insert_materializes_lines
AFTER INSERT ON coupon_credits
BEGIN
  INSERT INTO coupon_credit_lines
    (coupon_credit_id, organization_id, invoice_id, invoice_line_id, amount_minor, created_at)
  SELECT NEW.id, NEW.organization_id, NEW.invoice_id,
         json_extract(allocation.value, '$.lineId'),
         json_extract(allocation.value, '$.amountMinor'), NEW.created_at
  FROM json_each(NEW.allocations_json) allocation;
END;
