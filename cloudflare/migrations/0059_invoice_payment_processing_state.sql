ALTER TABLE invoices ADD COLUMN ready_for_payment_processing INTEGER NOT NULL DEFAULT 1
  CHECK (ready_for_payment_processing IN (0, 1));

CREATE INDEX invoices_dunning_ready_idx
  ON invoices(customer_id, currency, created_at, id)
  WHERE status = 'finalized' AND payment_overdue = 1 AND ready_for_payment_processing = 1;

DROP TRIGGER invoices_payment_requests_insert_guard;

CREATE TRIGGER invoices_payment_requests_insert_guard
BEFORE INSERT ON invoices_payment_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM payment_requests request
  JOIN invoices invoice ON invoice.id = NEW.invoice_id
  WHERE request.id = NEW.payment_request_id
    AND request.organization_id = NEW.organization_id
    AND invoice.organization_id = NEW.organization_id
    AND invoice.customer_id = request.customer_id
    AND invoice.version = NEW.invoice_version
    AND invoice.status = 'finalized'
    AND invoice.payment_status <> 'succeeded'
    AND invoice.payment_overdue = 1
    AND invoice.ready_for_payment_processing = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_payment_request_invoice');
END;

DROP TRIGGER dunning_attempt_guard_current_state;

CREATE TRIGGER dunning_attempt_guard_current_state
BEFORE INSERT ON dunning_attempt_guards
WHEN NOT EXISTS (
  SELECT 1
  FROM customers customer
  JOIN organizations organization ON organization.id = customer.organization_id
  JOIN dunning_campaigns campaign ON campaign.id = NEW.dunning_campaign_id
  JOIN dunning_campaign_thresholds threshold
    ON threshold.id = NEW.dunning_campaign_threshold_id
   AND threshold.dunning_campaign_id = campaign.id
  WHERE customer.id = NEW.customer_id
    AND customer.organization_id = NEW.organization_id
    AND campaign.organization_id = NEW.organization_id
    AND threshold.organization_id = NEW.organization_id
    AND campaign.active = 1
    AND threshold.deleted_at IS NULL
    AND customer.exclude_from_dunning_campaign = 0
    AND customer.currency = threshold.currency
    AND COALESCE(customer.applied_dunning_campaign_id,
                 organization.applied_dunning_campaign_id) = campaign.id
    AND customer.version = NEW.expected_customer_version
    AND customer.last_dunning_campaign_attempt = NEW.expected_attempt
    AND (
      customer.last_dunning_campaign_attempt_at = NEW.expected_last_attempt_at OR
      (customer.last_dunning_campaign_attempt_at IS NULL AND
       NEW.expected_last_attempt_at IS NULL)
    )
    AND NEW.expected_attempt < campaign.max_attempts
    AND (
      customer.last_dunning_campaign_attempt_at IS NULL OR
      datetime(customer.last_dunning_campaign_attempt_at,
               printf('+%d days', campaign.days_between_attempts)) <= datetime(NEW.created_at)
    )
    AND threshold.amount_minor <= COALESCE((
      SELECT SUM(invoice.total_due_minor)
      FROM invoices invoice
      WHERE invoice.customer_id = customer.id
        AND invoice.organization_id = NEW.organization_id
        AND invoice.currency = threshold.currency
        AND invoice.status = 'finalized'
        AND invoice.payment_status <> 'succeeded'
        AND invoice.payment_overdue = 1
        AND invoice.ready_for_payment_processing = 1
    ), 0)
)
BEGIN
  SELECT RAISE(ABORT, 'dunning_attempt_conflict');
END;
