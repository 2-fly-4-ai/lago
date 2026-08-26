PRAGMA foreign_keys = ON;

ALTER TABLE customers
  ADD COLUMN payment_receipt_counter INTEGER NOT NULL DEFAULT 0
  CHECK (payment_receipt_counter >= 0);

CREATE TABLE payment_receipts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  billing_entity_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_id TEXT NOT NULL,
  payment_kind TEXT NOT NULL CHECK (payment_kind IN ('invoice', 'payment_request')),
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  number TEXT NOT NULL,
  file_url TEXT,
  xml_url TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payment_kind, payment_id),
  UNIQUE (organization_id, number)
) STRICT;

CREATE INDEX payment_receipts_org_created_idx
  ON payment_receipts(organization_id, created_at DESC, id DESC);
CREATE INDEX payment_receipts_customer_idx
  ON payment_receipts(customer_id, created_at DESC, id DESC);

CREATE TRIGGER payment_receipt_tenant_guard
BEFORE INSERT ON payment_receipts
WHEN NEW.billing_entity_id <> NEW.organization_id
  OR NOT EXISTS (
    SELECT 1
    FROM payment_attempts payment
    JOIN invoices invoice ON invoice.id = payment.invoice_id
    WHERE NEW.payment_kind = 'invoice'
      AND payment.id = NEW.payment_id
      AND payment.organization_id = NEW.organization_id
      AND payment.status = 'succeeded'
      AND invoice.organization_id = NEW.organization_id
      AND invoice.customer_id = NEW.customer_id
      AND invoice.payment_status = 'succeeded'
    UNION ALL
    SELECT 1
    FROM payment_request_payments payment
    JOIN payment_requests request ON request.id = payment.payment_request_id
    WHERE NEW.payment_kind = 'payment_request'
      AND payment.id = NEW.payment_id
      AND payment.organization_id = NEW.organization_id
      AND payment.status = 'succeeded'
      AND request.organization_id = NEW.organization_id
      AND request.customer_id = NEW.customer_id
      AND request.payment_status = 'succeeded'
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_payment_receipt_tenant_or_state');
END;

CREATE TRIGGER payment_receipt_identity_immutable
BEFORE UPDATE OF organization_id, billing_entity_id, payment_id, payment_kind, customer_id, number
ON payment_receipts
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.billing_entity_id <> NEW.billing_entity_id
  OR OLD.payment_id <> NEW.payment_id
  OR OLD.payment_kind <> NEW.payment_kind
  OR OLD.customer_id <> NEW.customer_id
  OR OLD.number <> NEW.number
BEGIN
  SELECT RAISE(ABORT, 'immutable_payment_receipt_identity');
END;

CREATE TRIGGER payment_receipt_outbox_version_guard
BEFORE INSERT ON outbox_events
WHEN NEW.aggregate_type = 'payment_receipt' AND NOT EXISTS (
  SELECT 1 FROM payment_receipts receipt
  WHERE receipt.id = NEW.aggregate_id
    AND receipt.organization_id = NEW.organization_id
    AND receipt.version = NEW.aggregate_version
)
BEGIN
  SELECT RAISE(ABORT, 'payment_receipt_outbox_version_conflict');
END;

CREATE TRIGGER payment_receipt_after_invoice_payment_insert
AFTER INSERT ON payment_attempts
WHEN NEW.status = 'succeeded'
  AND EXISTS (
    SELECT 1 FROM invoices invoice
    WHERE invoice.id = NEW.invoice_id
      AND invoice.organization_id = NEW.organization_id
      AND invoice.payment_status = 'succeeded'
  )
  AND NOT EXISTS (
    SELECT 1 FROM payment_receipts
    WHERE payment_kind = 'invoice' AND payment_id = NEW.id
  )
BEGIN
  UPDATE customers
  SET payment_receipt_counter = payment_receipt_counter + 1
  WHERE id = (SELECT customer_id FROM invoices WHERE id = NEW.invoice_id)
    AND organization_id = NEW.organization_id;

  INSERT INTO payment_receipts
    (id, organization_id, billing_entity_id, payment_id, payment_kind, customer_id, number,
     file_url, xml_url, version, created_at, updated_at)
  SELECT 'payment-receipt:' || NEW.id, NEW.organization_id, NEW.organization_id, NEW.id,
         'invoice', invoice.customer_id,
         customer.external_id || '-RCPT-' || printf('%06d', customer.payment_receipt_counter),
         NULL, NULL, 1, NEW.updated_at, NEW.updated_at
  FROM invoices invoice
  JOIN customers customer ON customer.id = invoice.customer_id
  WHERE invoice.id = NEW.invoice_id
    AND invoice.organization_id = NEW.organization_id
    AND invoice.payment_status = 'succeeded';

  INSERT INTO outbox_events
    (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
     aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
  SELECT 'payment-receipt-created:' || receipt.id, receipt.organization_id,
         'payment_receipt.created', 1, 'payment_receipt', receipt.id, receipt.version,
         NEW.id, NEW.id,
         json_object('organizationId', receipt.organization_id,
                     'paymentReceiptId', receipt.id, 'paymentId', receipt.payment_id),
         receipt.created_at, NULL
  FROM payment_receipts receipt
  WHERE receipt.payment_kind = 'invoice' AND receipt.payment_id = NEW.id;
END;

CREATE TRIGGER payment_receipt_after_invoice_payment_update
AFTER UPDATE OF status ON payment_attempts
WHEN OLD.status <> 'succeeded' AND NEW.status = 'succeeded'
  AND EXISTS (
    SELECT 1 FROM invoices invoice
    WHERE invoice.id = NEW.invoice_id
      AND invoice.organization_id = NEW.organization_id
      AND invoice.payment_status = 'succeeded'
  )
  AND NOT EXISTS (
    SELECT 1 FROM payment_receipts
    WHERE payment_kind = 'invoice' AND payment_id = NEW.id
  )
BEGIN
  UPDATE customers
  SET payment_receipt_counter = payment_receipt_counter + 1
  WHERE id = (SELECT customer_id FROM invoices WHERE id = NEW.invoice_id)
    AND organization_id = NEW.organization_id;

  INSERT INTO payment_receipts
    (id, organization_id, billing_entity_id, payment_id, payment_kind, customer_id, number,
     file_url, xml_url, version, created_at, updated_at)
  SELECT 'payment-receipt:' || NEW.id, NEW.organization_id, NEW.organization_id, NEW.id,
         'invoice', invoice.customer_id,
         customer.external_id || '-RCPT-' || printf('%06d', customer.payment_receipt_counter),
         NULL, NULL, 1, NEW.updated_at, NEW.updated_at
  FROM invoices invoice
  JOIN customers customer ON customer.id = invoice.customer_id
  WHERE invoice.id = NEW.invoice_id
    AND invoice.organization_id = NEW.organization_id
    AND invoice.payment_status = 'succeeded';

  INSERT INTO outbox_events
    (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
     aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
  SELECT 'payment-receipt-created:' || receipt.id, receipt.organization_id,
         'payment_receipt.created', 1, 'payment_receipt', receipt.id, receipt.version,
         NEW.id, NEW.id,
         json_object('organizationId', receipt.organization_id,
                     'paymentReceiptId', receipt.id, 'paymentId', receipt.payment_id),
         receipt.created_at, NULL
  FROM payment_receipts receipt
  WHERE receipt.payment_kind = 'invoice' AND receipt.payment_id = NEW.id;
END;

CREATE TRIGGER payment_receipt_after_invoice_settlement
AFTER UPDATE OF payment_status ON invoices
WHEN OLD.payment_status <> 'succeeded' AND NEW.payment_status = 'succeeded'
  AND EXISTS (
    SELECT 1 FROM payment_attempts payment
    WHERE payment.invoice_id = NEW.id AND payment.organization_id = NEW.organization_id
      AND payment.status = 'succeeded'
  )
  AND NOT EXISTS (
    SELECT 1 FROM payment_receipts receipt
    WHERE receipt.payment_kind = 'invoice'
      AND receipt.payment_id = (
        SELECT payment.id FROM payment_attempts payment
        WHERE payment.invoice_id = NEW.id AND payment.organization_id = NEW.organization_id
          AND payment.status = 'succeeded'
        ORDER BY payment.created_at DESC, payment.id DESC LIMIT 1
      )
  )
BEGIN
  UPDATE customers
  SET payment_receipt_counter = payment_receipt_counter + 1
  WHERE id = NEW.customer_id AND organization_id = NEW.organization_id;

  INSERT INTO payment_receipts
    (id, organization_id, billing_entity_id, payment_id, payment_kind, customer_id, number,
     file_url, xml_url, version, created_at, updated_at)
  SELECT 'payment-receipt:' || payment.id, NEW.organization_id, NEW.organization_id, payment.id,
         'invoice', NEW.customer_id,
         customer.external_id || '-RCPT-' || printf('%06d', customer.payment_receipt_counter),
         NULL, NULL, 1, NEW.updated_at, NEW.updated_at
  FROM payment_attempts payment
  JOIN customers customer ON customer.id = NEW.customer_id
  WHERE payment.invoice_id = NEW.id AND payment.organization_id = NEW.organization_id
    AND payment.status = 'succeeded'
  ORDER BY payment.created_at DESC, payment.id DESC LIMIT 1;

  INSERT INTO outbox_events
    (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
     aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
  SELECT 'payment-receipt-created:' || receipt.id, receipt.organization_id,
         'payment_receipt.created', 1, 'payment_receipt', receipt.id, receipt.version,
         receipt.payment_id, receipt.payment_id,
         json_object('organizationId', receipt.organization_id,
                     'paymentReceiptId', receipt.id, 'paymentId', receipt.payment_id),
         receipt.created_at, NULL
  FROM payment_receipts receipt
  WHERE receipt.payment_kind = 'invoice'
    AND receipt.payment_id = (
      SELECT payment.id FROM payment_attempts payment
      WHERE payment.invoice_id = NEW.id AND payment.organization_id = NEW.organization_id
        AND payment.status = 'succeeded'
      ORDER BY payment.created_at DESC, payment.id DESC LIMIT 1
    );
END;

CREATE TRIGGER payment_receipt_after_request_payment_insert
AFTER INSERT ON payment_request_payments
WHEN NEW.status = 'succeeded'
  AND EXISTS (
    SELECT 1 FROM payment_requests request
    WHERE request.id = NEW.payment_request_id
      AND request.organization_id = NEW.organization_id
      AND request.payment_status = 'succeeded'
  )
  AND NOT EXISTS (
    SELECT 1 FROM payment_receipts
    WHERE payment_kind = 'payment_request' AND payment_id = NEW.id
  )
BEGIN
  UPDATE customers
  SET payment_receipt_counter = payment_receipt_counter + 1
  WHERE id = (SELECT customer_id FROM payment_requests WHERE id = NEW.payment_request_id)
    AND organization_id = NEW.organization_id;

  INSERT INTO payment_receipts
    (id, organization_id, billing_entity_id, payment_id, payment_kind, customer_id, number,
     file_url, xml_url, version, created_at, updated_at)
  SELECT 'payment-receipt:' || NEW.id, NEW.organization_id, NEW.organization_id, NEW.id,
         'payment_request', request.customer_id,
         customer.external_id || '-RCPT-' || printf('%06d', customer.payment_receipt_counter),
         NULL, NULL, 1, NEW.updated_at, NEW.updated_at
  FROM payment_requests request
  JOIN customers customer ON customer.id = request.customer_id
  WHERE request.id = NEW.payment_request_id
    AND request.organization_id = NEW.organization_id
    AND request.payment_status = 'succeeded';

  INSERT INTO outbox_events
    (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
     aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
  SELECT 'payment-receipt-created:' || receipt.id, receipt.organization_id,
         'payment_receipt.created', 1, 'payment_receipt', receipt.id, receipt.version,
         NEW.id, NEW.id,
         json_object('organizationId', receipt.organization_id,
                     'paymentReceiptId', receipt.id, 'paymentId', receipt.payment_id),
         receipt.created_at, NULL
  FROM payment_receipts receipt
  WHERE receipt.payment_kind = 'payment_request' AND receipt.payment_id = NEW.id;
END;

CREATE TRIGGER payment_receipt_after_request_payment_update
AFTER UPDATE OF status ON payment_request_payments
WHEN OLD.status <> 'succeeded' AND NEW.status = 'succeeded'
  AND EXISTS (
    SELECT 1 FROM payment_requests request
    WHERE request.id = NEW.payment_request_id
      AND request.organization_id = NEW.organization_id
      AND request.payment_status = 'succeeded'
  )
  AND NOT EXISTS (
    SELECT 1 FROM payment_receipts
    WHERE payment_kind = 'payment_request' AND payment_id = NEW.id
  )
BEGIN
  UPDATE customers
  SET payment_receipt_counter = payment_receipt_counter + 1
  WHERE id = (SELECT customer_id FROM payment_requests WHERE id = NEW.payment_request_id)
    AND organization_id = NEW.organization_id;

  INSERT INTO payment_receipts
    (id, organization_id, billing_entity_id, payment_id, payment_kind, customer_id, number,
     file_url, xml_url, version, created_at, updated_at)
  SELECT 'payment-receipt:' || NEW.id, NEW.organization_id, NEW.organization_id, NEW.id,
         'payment_request', request.customer_id,
         customer.external_id || '-RCPT-' || printf('%06d', customer.payment_receipt_counter),
         NULL, NULL, 1, NEW.updated_at, NEW.updated_at
  FROM payment_requests request
  JOIN customers customer ON customer.id = request.customer_id
  WHERE request.id = NEW.payment_request_id
    AND request.organization_id = NEW.organization_id
    AND request.payment_status = 'succeeded';

  INSERT INTO outbox_events
    (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
     aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
  SELECT 'payment-receipt-created:' || receipt.id, receipt.organization_id,
         'payment_receipt.created', 1, 'payment_receipt', receipt.id, receipt.version,
         NEW.id, NEW.id,
         json_object('organizationId', receipt.organization_id,
                     'paymentReceiptId', receipt.id, 'paymentId', receipt.payment_id),
         receipt.created_at, NULL
  FROM payment_receipts receipt
  WHERE receipt.payment_kind = 'payment_request' AND receipt.payment_id = NEW.id;
END;

CREATE TRIGGER payment_receipt_after_request_settlement
AFTER UPDATE OF payment_status ON payment_requests
WHEN OLD.payment_status <> 'succeeded' AND NEW.payment_status = 'succeeded'
  AND EXISTS (
    SELECT 1 FROM payment_request_payments payment
    WHERE payment.payment_request_id = NEW.id AND payment.organization_id = NEW.organization_id
      AND payment.status = 'succeeded'
  )
  AND NOT EXISTS (
    SELECT 1 FROM payment_receipts receipt
    WHERE receipt.payment_kind = 'payment_request'
      AND receipt.payment_id = (
        SELECT payment.id FROM payment_request_payments payment
        WHERE payment.payment_request_id = NEW.id AND payment.organization_id = NEW.organization_id
          AND payment.status = 'succeeded'
        ORDER BY payment.created_at DESC, payment.id DESC LIMIT 1
      )
  )
BEGIN
  UPDATE customers
  SET payment_receipt_counter = payment_receipt_counter + 1
  WHERE id = NEW.customer_id AND organization_id = NEW.organization_id;

  INSERT INTO payment_receipts
    (id, organization_id, billing_entity_id, payment_id, payment_kind, customer_id, number,
     file_url, xml_url, version, created_at, updated_at)
  SELECT 'payment-receipt:' || payment.id, NEW.organization_id, NEW.organization_id, payment.id,
         'payment_request', NEW.customer_id,
         customer.external_id || '-RCPT-' || printf('%06d', customer.payment_receipt_counter),
         NULL, NULL, 1, NEW.updated_at, NEW.updated_at
  FROM payment_request_payments payment
  JOIN customers customer ON customer.id = NEW.customer_id
  WHERE payment.payment_request_id = NEW.id AND payment.organization_id = NEW.organization_id
    AND payment.status = 'succeeded'
  ORDER BY payment.created_at DESC, payment.id DESC LIMIT 1;

  INSERT INTO outbox_events
    (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
     aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
  SELECT 'payment-receipt-created:' || receipt.id, receipt.organization_id,
         'payment_receipt.created', 1, 'payment_receipt', receipt.id, receipt.version,
         receipt.payment_id, receipt.payment_id,
         json_object('organizationId', receipt.organization_id,
                     'paymentReceiptId', receipt.id, 'paymentId', receipt.payment_id),
         receipt.created_at, NULL
  FROM payment_receipts receipt
  WHERE receipt.payment_kind = 'payment_request'
    AND receipt.payment_id = (
      SELECT payment.id FROM payment_request_payments payment
      WHERE payment.payment_request_id = NEW.id AND payment.organization_id = NEW.organization_id
        AND payment.status = 'succeeded'
      ORDER BY payment.created_at DESC, payment.id DESC LIMIT 1
    );
END;
