ALTER TABLE billable_metrics ADD COLUMN filters_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(filters_json) AND json_type(filters_json) = 'array');

ALTER TABLE charges ADD COLUMN filters_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(filters_json) AND json_type(filters_json) = 'array');

DROP TRIGGER draft_refresh_after_metric_update;
DROP TRIGGER draft_refresh_after_generation_metric_update;

CREATE TRIGGER draft_refresh_after_metric_update
AFTER UPDATE OF name, aggregation_type, field_name, recurring, properties_json, filters_json
ON billable_metrics
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

CREATE TRIGGER draft_refresh_after_generation_metric_update
AFTER UPDATE OF name, aggregation_type, field_name, recurring, properties_json, filters_json
ON billable_metrics
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND id IN (
    SELECT invoice_subscriptions.invoice_id FROM invoice_subscriptions
    JOIN subscriptions ON subscriptions.id = invoice_subscriptions.subscription_id
    JOIN charges ON charges.plan_id = subscriptions.plan_id
    WHERE charges.billable_metric_id = NEW.id AND charges.active = 1
  );
END;
