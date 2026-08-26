CREATE TRIGGER draft_refresh_after_subscription_update
AFTER UPDATE OF name, plan_id ON subscriptions
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE subscription_id = NEW.id AND status = 'draft';
END;

CREATE TRIGGER draft_refresh_after_plan_update
AFTER UPDATE OF name, invoice_display_name, amount_minor, interval, currency ON plans
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (SELECT id FROM subscriptions WHERE plan_id = NEW.id);
END;

CREATE TRIGGER draft_refresh_after_metric_update
AFTER UPDATE OF name, aggregation_type, field_name, recurring, properties_json ON billable_metrics
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (
      SELECT subscriptions.id
      FROM subscriptions
      JOIN charges ON charges.plan_id = subscriptions.plan_id
      WHERE charges.billable_metric_id = NEW.id AND charges.active = 1
    );
END;

CREATE TRIGGER draft_refresh_after_charge_insert
AFTER INSERT ON charges
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (SELECT id FROM subscriptions WHERE plan_id = NEW.plan_id);
END;

CREATE TRIGGER draft_refresh_after_charge_update
AFTER UPDATE ON charges
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (
      SELECT id FROM subscriptions WHERE plan_id IN (OLD.plan_id, NEW.plan_id)
    );
END;

CREATE TRIGGER draft_refresh_after_fixed_charge_insert
AFTER INSERT ON fixed_charges
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (SELECT id FROM subscriptions WHERE plan_id = NEW.plan_id);
END;

CREATE TRIGGER draft_refresh_after_fixed_charge_update
AFTER UPDATE ON fixed_charges
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (
      SELECT id FROM subscriptions WHERE plan_id IN (OLD.plan_id, NEW.plan_id)
    );
END;

CREATE TRIGGER draft_refresh_after_add_on_update
AFTER UPDATE OF name, invoice_display_name, amount_minor, currency, status ON add_ons
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (
      SELECT subscriptions.id
      FROM subscriptions
      JOIN fixed_charges ON fixed_charges.plan_id = subscriptions.plan_id
      WHERE fixed_charges.add_on_id = NEW.id
    );
END;

CREATE TRIGGER draft_refresh_after_commitment_insert
AFTER INSERT ON minimum_commitments
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (SELECT id FROM subscriptions WHERE plan_id = NEW.plan_id);
END;

CREATE TRIGGER draft_refresh_after_commitment_update
AFTER UPDATE ON minimum_commitments
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (
      SELECT id FROM subscriptions WHERE plan_id IN (OLD.plan_id, NEW.plan_id)
    );
END;

CREATE TRIGGER draft_refresh_after_applied_coupon_insert
AFTER INSERT ON applied_coupons
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE customer_id = NEW.customer_id AND status = 'draft';
END;

CREATE TRIGGER draft_refresh_after_applied_coupon_update
AFTER UPDATE ON applied_coupons
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE customer_id IN (OLD.customer_id, NEW.customer_id) AND status = 'draft';
END;

CREATE TRIGGER draft_refresh_after_tax_insert
AFTER INSERT ON taxes
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE organization_id = NEW.organization_id AND status = 'draft';
END;

CREATE TRIGGER draft_refresh_after_tax_update
AFTER UPDATE ON taxes
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE organization_id IN (OLD.organization_id, NEW.organization_id) AND status = 'draft';
END;

CREATE TRIGGER draft_refresh_after_credit_note_insert
AFTER INSERT ON credit_notes
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE customer_id = NEW.customer_id AND status = 'draft';
END;

CREATE TRIGGER draft_refresh_after_credit_note_update
AFTER UPDATE OF credit_status, balance_amount_minor, currency ON credit_notes
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE customer_id IN (OLD.customer_id, NEW.customer_id) AND status = 'draft';
END;

CREATE TRIGGER draft_refresh_after_wallet_insert
AFTER INSERT ON wallets
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE customer_id = NEW.customer_id AND status = 'draft';
END;

CREATE TRIGGER draft_refresh_after_wallet_update
AFTER UPDATE OF balance_minor, status, expiration_at, priority, rate_amount ON wallets
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE customer_id IN (OLD.customer_id, NEW.customer_id) AND status = 'draft';
END;

CREATE TRIGGER draft_refresh_after_wallet_transaction_insert
AFTER INSERT ON wallet_transactions
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND customer_id = (SELECT customer_id FROM wallets WHERE id = NEW.wallet_id);
END;

CREATE TRIGGER draft_refresh_after_wallet_transaction_update
AFTER UPDATE OF status, transaction_status, remaining_minor ON wallet_transactions
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND customer_id IN (
      SELECT customer_id FROM wallets WHERE id IN (OLD.wallet_id, NEW.wallet_id)
    );
END;

CREATE TRIGGER draft_refresh_after_usage_insert
AFTER INSERT ON usage_events
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE subscription_id = NEW.subscription_id AND status = 'draft';
END;

CREATE TRIGGER draft_refresh_after_usage_update
AFTER UPDATE ON usage_events
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE subscription_id IN (OLD.subscription_id, NEW.subscription_id) AND status = 'draft';
END;
