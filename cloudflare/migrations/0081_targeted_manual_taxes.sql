CREATE TABLE tax_targets (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  tax_id TEXT NOT NULL REFERENCES taxes(id) ON DELETE RESTRICT,
  target_type TEXT NOT NULL CHECK (
    target_type IN (
      'billing_entity',
      'customer',
      'plan',
      'charge',
      'fixed_charge',
      'commitment',
      'add_on'
    )
  ),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, tax_id, target_type, target_id)
) STRICT;

CREATE INDEX tax_targets_lookup_idx
  ON tax_targets(organization_id, target_type, target_id, created_at, tax_id);

CREATE TRIGGER tax_target_requires_owned_resources
BEFORE INSERT ON tax_targets
WHEN NOT EXISTS (
  SELECT 1 FROM taxes
  WHERE id = NEW.tax_id AND organization_id = NEW.organization_id AND status = 'active'
) OR (
  NEW.target_type = 'billing_entity' AND NEW.target_id <> NEW.organization_id
) OR (
  NEW.target_type = 'customer' AND NOT EXISTS (
    SELECT 1 FROM customers WHERE id = NEW.target_id AND organization_id = NEW.organization_id
  )
) OR (
  NEW.target_type = 'plan' AND NOT EXISTS (
    SELECT 1 FROM plans WHERE id = NEW.target_id AND organization_id = NEW.organization_id
  )
) OR (
  NEW.target_type = 'charge' AND NOT EXISTS (
    SELECT 1 FROM charges WHERE id = NEW.target_id AND organization_id = NEW.organization_id
  )
) OR (
  NEW.target_type = 'fixed_charge' AND NOT EXISTS (
    SELECT 1 FROM fixed_charges WHERE id = NEW.target_id AND organization_id = NEW.organization_id
  )
) OR (
  NEW.target_type = 'commitment' AND NOT EXISTS (
    SELECT 1 FROM minimum_commitments
    WHERE id = NEW.target_id AND organization_id = NEW.organization_id
  )
) OR (
  NEW.target_type = 'add_on' AND NOT EXISTS (
    SELECT 1 FROM add_ons WHERE id = NEW.target_id AND organization_id = NEW.organization_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'tax_target_scope_conflict');
END;

INSERT INTO tax_targets (organization_id, tax_id, target_type, target_id, created_at)
SELECT tax.organization_id, tax.id, 'billing_entity', tax.organization_id, tax.created_at
FROM taxes tax
WHERE tax.status = 'active' AND tax.applied_to_organization = 1;

INSERT INTO tax_targets (organization_id, tax_id, target_type, target_id, created_at)
SELECT link.organization_id, link.tax_id, 'customer', link.customer_id, link.created_at
FROM customer_applied_taxes link
JOIN taxes tax ON tax.id = link.tax_id
WHERE tax.status = 'active';

CREATE TRIGGER tax_target_identity_immutable
BEFORE UPDATE ON tax_targets
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.tax_id <> NEW.tax_id
  OR OLD.target_type <> NEW.target_type
  OR OLD.target_id <> NEW.target_id
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'tax_target_identity_immutable');
END;

CREATE TRIGGER tax_delete_removes_targets
BEFORE DELETE ON taxes
BEGIN
  DELETE FROM tax_targets
  WHERE organization_id = OLD.organization_id AND tax_id = OLD.id;
END;

CREATE TRIGGER customer_delete_removes_tax_targets
AFTER DELETE ON customers
BEGIN
  DELETE FROM tax_targets
  WHERE organization_id = OLD.organization_id AND target_type = 'customer' AND target_id = OLD.id;
END;

CREATE TRIGGER plan_delete_removes_tax_targets
AFTER DELETE ON plans
BEGIN
  DELETE FROM tax_targets
  WHERE organization_id = OLD.organization_id AND target_type = 'plan' AND target_id = OLD.id;
END;

CREATE TRIGGER charge_delete_removes_tax_targets
AFTER DELETE ON charges
BEGIN
  DELETE FROM tax_targets
  WHERE organization_id = OLD.organization_id AND target_type = 'charge' AND target_id = OLD.id;
END;

CREATE TRIGGER fixed_charge_delete_removes_tax_targets
AFTER DELETE ON fixed_charges
BEGIN
  DELETE FROM tax_targets
  WHERE organization_id = OLD.organization_id
    AND target_type = 'fixed_charge' AND target_id = OLD.id;
END;

CREATE TRIGGER commitment_delete_removes_tax_targets
AFTER DELETE ON minimum_commitments
BEGIN
  DELETE FROM tax_targets
  WHERE organization_id = OLD.organization_id AND target_type = 'commitment' AND target_id = OLD.id;
END;

CREATE TRIGGER add_on_delete_removes_tax_targets
AFTER DELETE ON add_ons
BEGIN
  DELETE FROM tax_targets
  WHERE organization_id = OLD.organization_id AND target_type = 'add_on' AND target_id = OLD.id;
END;

CREATE TRIGGER tax_target_insert_invalidates_drafts
AFTER INSERT ON tax_targets
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1, updated_at = NEW.created_at
  WHERE organization_id = NEW.organization_id AND status = 'draft' AND (
    NEW.target_type = 'billing_entity'
    OR (NEW.target_type = 'customer' AND customer_id = NEW.target_id)
    OR EXISTS (
      SELECT 1 FROM invoice_lines line
      WHERE line.invoice_id = invoices.id
        AND line.source_type = NEW.target_type AND line.source_id = NEW.target_id
    )
    OR EXISTS (
      SELECT 1 FROM subscriptions subscription
      WHERE subscription.id = invoices.subscription_id
        AND (
          (NEW.target_type = 'plan' AND subscription.plan_id = NEW.target_id)
          OR (NEW.target_type = 'charge' AND EXISTS (
            SELECT 1 FROM charges
            WHERE id = NEW.target_id AND plan_id = subscription.plan_id
          ))
          OR (NEW.target_type = 'fixed_charge' AND EXISTS (
            SELECT 1 FROM fixed_charges
            WHERE id = NEW.target_id AND plan_id = subscription.plan_id
          ))
          OR (NEW.target_type = 'commitment' AND EXISTS (
            SELECT 1 FROM minimum_commitments
            WHERE id = NEW.target_id AND plan_id = subscription.plan_id
          ))
        )
    )
    OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link
      JOIN subscriptions subscription ON subscription.id = link.subscription_id
      WHERE link.invoice_id = invoices.id AND (
        (NEW.target_type = 'plan' AND subscription.plan_id = NEW.target_id)
        OR (NEW.target_type = 'charge' AND EXISTS (
          SELECT 1 FROM charges
          WHERE id = NEW.target_id AND plan_id = subscription.plan_id
        ))
        OR (NEW.target_type = 'fixed_charge' AND EXISTS (
          SELECT 1 FROM fixed_charges
          WHERE id = NEW.target_id AND plan_id = subscription.plan_id
        ))
        OR (NEW.target_type = 'commitment' AND EXISTS (
          SELECT 1 FROM minimum_commitments
          WHERE id = NEW.target_id AND plan_id = subscription.plan_id
        ))
      )
    )
  );
END;

CREATE TRIGGER tax_target_delete_invalidates_drafts
AFTER DELETE ON tax_targets
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE organization_id = OLD.organization_id AND status = 'draft' AND (
    OLD.target_type = 'billing_entity'
    OR (OLD.target_type = 'customer' AND customer_id = OLD.target_id)
    OR EXISTS (
      SELECT 1 FROM invoice_lines line
      WHERE line.invoice_id = invoices.id
        AND line.source_type = OLD.target_type AND line.source_id = OLD.target_id
    )
    OR EXISTS (
      SELECT 1 FROM subscriptions subscription
      WHERE subscription.id = invoices.subscription_id
        AND (
          (OLD.target_type = 'plan' AND subscription.plan_id = OLD.target_id)
          OR (OLD.target_type = 'charge' AND EXISTS (
            SELECT 1 FROM charges
            WHERE id = OLD.target_id AND plan_id = subscription.plan_id
          ))
          OR (OLD.target_type = 'fixed_charge' AND EXISTS (
            SELECT 1 FROM fixed_charges
            WHERE id = OLD.target_id AND plan_id = subscription.plan_id
          ))
          OR (OLD.target_type = 'commitment' AND EXISTS (
            SELECT 1 FROM minimum_commitments
            WHERE id = OLD.target_id AND plan_id = subscription.plan_id
          ))
        )
    )
    OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link
      JOIN subscriptions subscription ON subscription.id = link.subscription_id
      WHERE link.invoice_id = invoices.id AND (
        (OLD.target_type = 'plan' AND subscription.plan_id = OLD.target_id)
        OR (OLD.target_type = 'charge' AND EXISTS (
          SELECT 1 FROM charges
          WHERE id = OLD.target_id AND plan_id = subscription.plan_id
        ))
        OR (OLD.target_type = 'fixed_charge' AND EXISTS (
          SELECT 1 FROM fixed_charges
          WHERE id = OLD.target_id AND plan_id = subscription.plan_id
        ))
        OR (OLD.target_type = 'commitment' AND EXISTS (
          SELECT 1 FROM minimum_commitments
          WHERE id = OLD.target_id AND plan_id = subscription.plan_id
        ))
      )
    )
  );
END;

CREATE TRIGGER targeted_tax_update_invalidates_drafts
AFTER UPDATE OF code, name, description, rate ON taxes
WHEN OLD.code <> NEW.code OR OLD.name <> NEW.name
  OR OLD.description IS NOT NEW.description OR OLD.rate <> NEW.rate
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1, updated_at = NEW.updated_at
  WHERE organization_id = NEW.organization_id AND status = 'draft' AND EXISTS (
    SELECT 1 FROM tax_targets target
    WHERE target.organization_id = NEW.organization_id AND target.tax_id = NEW.id AND (
      target.target_type = 'billing_entity'
      OR (target.target_type = 'customer' AND invoices.customer_id = target.target_id)
      OR EXISTS (
        SELECT 1 FROM invoice_lines line
        WHERE line.invoice_id = invoices.id
          AND line.source_type = target.target_type AND line.source_id = target.target_id
      )
      OR EXISTS (
        SELECT 1 FROM subscriptions subscription
        WHERE subscription.id = invoices.subscription_id AND (
          (target.target_type = 'plan' AND subscription.plan_id = target.target_id)
          OR (target.target_type = 'charge' AND EXISTS (
            SELECT 1 FROM charges
            WHERE id = target.target_id AND plan_id = subscription.plan_id
          ))
          OR (target.target_type = 'fixed_charge' AND EXISTS (
            SELECT 1 FROM fixed_charges
            WHERE id = target.target_id AND plan_id = subscription.plan_id
          ))
          OR (target.target_type = 'commitment' AND EXISTS (
            SELECT 1 FROM minimum_commitments
            WHERE id = target.target_id AND plan_id = subscription.plan_id
          ))
        )
      )
      OR EXISTS (
        SELECT 1 FROM invoice_subscriptions link
        JOIN subscriptions subscription ON subscription.id = link.subscription_id
        WHERE link.invoice_id = invoices.id AND (
          (target.target_type = 'plan' AND subscription.plan_id = target.target_id)
          OR (target.target_type = 'charge' AND EXISTS (
            SELECT 1 FROM charges
            WHERE id = target.target_id AND plan_id = subscription.plan_id
          ))
          OR (target.target_type = 'fixed_charge' AND EXISTS (
            SELECT 1 FROM fixed_charges
            WHERE id = target.target_id AND plan_id = subscription.plan_id
          ))
          OR (target.target_type = 'commitment' AND EXISTS (
            SELECT 1 FROM minimum_commitments
            WHERE id = target.target_id AND plan_id = subscription.plan_id
          ))
        )
      )
    )
  );
END;

CREATE TRIGGER terminated_tax_removes_targets
AFTER UPDATE OF status ON taxes
WHEN OLD.status = 'active' AND NEW.status = 'terminated'
BEGIN
  DELETE FROM tax_targets
  WHERE organization_id = NEW.organization_id AND tax_id = NEW.id;
END;
