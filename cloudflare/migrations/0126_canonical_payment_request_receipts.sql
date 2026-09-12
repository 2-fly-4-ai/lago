PRAGMA foreign_keys = ON;

-- Payment-request reconciliation mirrors a single-invoice provider payment into
-- payment_attempts so credit-note refunds can use the invoice ledger. The mirror
-- is not a second customer payment and must never mint a second receipt.
DROP TRIGGER payment_receipt_after_invoice_payment_insert;
DROP TRIGGER payment_receipt_after_invoice_payment_update;
DROP TRIGGER payment_receipt_after_invoice_settlement;

-- Remove historical receipts created for an invoice mirror when the same
-- provider transaction is already represented by a payment-request payment.
-- Delete dependent outbox rows first; the canonical payment-request receipt
-- and its document remain untouched. If a historical shadow receipt somehow
-- already has an archived document, retain that immutable evidence rather than
-- orphaning the object-store file. Such a row remains hidden by the canonical
-- payment ledger and cannot generate another document event.
DELETE FROM outbox_events
WHERE aggregate_type = 'payment_receipt'
  AND aggregate_id IN (
    SELECT receipt.id
    FROM payment_receipts receipt
    JOIN payment_attempts attempt
      ON receipt.payment_kind = 'invoice' AND receipt.payment_id = attempt.id
    JOIN invoices_payment_requests link ON link.invoice_id = attempt.invoice_id
    JOIN payment_request_payments request_payment
      ON request_payment.payment_request_id = link.payment_request_id
     AND request_payment.provider = attempt.provider
     AND request_payment.provider_account_code = attempt.provider_account_code
     AND request_payment.provider_transaction_id = attempt.provider_transaction_id
  );

DELETE FROM payment_receipts
WHERE payment_kind = 'invoice'
  AND NOT EXISTS (
    SELECT 1 FROM payment_receipt_document_artifacts artifact
    WHERE artifact.payment_receipt_id = payment_receipts.id
  )
  AND EXISTS (
    SELECT 1
    FROM payment_attempts attempt
    JOIN invoices_payment_requests link ON link.invoice_id = attempt.invoice_id
    JOIN payment_request_payments request_payment
      ON request_payment.payment_request_id = link.payment_request_id
     AND request_payment.provider = attempt.provider
     AND request_payment.provider_account_code = attempt.provider_account_code
     AND request_payment.provider_transaction_id = attempt.provider_transaction_id
    WHERE attempt.id = payment_receipts.payment_id
  );

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
    SELECT 1
    FROM invoices_payment_requests link
    JOIN payment_request_payments request_payment
      ON request_payment.payment_request_id = link.payment_request_id
    WHERE link.invoice_id = NEW.invoice_id
      AND request_payment.provider = NEW.provider
      AND request_payment.provider_account_code = NEW.provider_account_code
      AND request_payment.provider_transaction_id = NEW.provider_transaction_id
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
    SELECT 1
    FROM invoices_payment_requests link
    JOIN payment_request_payments request_payment
      ON request_payment.payment_request_id = link.payment_request_id
    WHERE link.invoice_id = NEW.invoice_id
      AND request_payment.provider = NEW.provider
      AND request_payment.provider_account_code = NEW.provider_account_code
      AND request_payment.provider_transaction_id = NEW.provider_transaction_id
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
    WHERE payment.invoice_id = NEW.id
      AND payment.organization_id = NEW.organization_id
      AND payment.status = 'succeeded'
      AND NOT EXISTS (
        SELECT 1
        FROM invoices_payment_requests link
        JOIN payment_request_payments request_payment
          ON request_payment.payment_request_id = link.payment_request_id
        WHERE link.invoice_id = payment.invoice_id
          AND request_payment.provider = payment.provider
          AND request_payment.provider_account_code = payment.provider_account_code
          AND request_payment.provider_transaction_id = payment.provider_transaction_id
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM payment_receipts receipt
    WHERE receipt.payment_kind = 'invoice'
      AND receipt.payment_id = (
        SELECT payment.id FROM payment_attempts payment
        WHERE payment.invoice_id = NEW.id
          AND payment.organization_id = NEW.organization_id
          AND payment.status = 'succeeded'
          AND NOT EXISTS (
            SELECT 1
            FROM invoices_payment_requests link
            JOIN payment_request_payments request_payment
              ON request_payment.payment_request_id = link.payment_request_id
            WHERE link.invoice_id = payment.invoice_id
              AND request_payment.provider = payment.provider
              AND request_payment.provider_account_code = payment.provider_account_code
              AND request_payment.provider_transaction_id = payment.provider_transaction_id
          )
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
  WHERE payment.invoice_id = NEW.id
    AND payment.organization_id = NEW.organization_id
    AND payment.status = 'succeeded'
    AND NOT EXISTS (
      SELECT 1
      FROM invoices_payment_requests link
      JOIN payment_request_payments request_payment
        ON request_payment.payment_request_id = link.payment_request_id
      WHERE link.invoice_id = payment.invoice_id
        AND request_payment.provider = payment.provider
        AND request_payment.provider_account_code = payment.provider_account_code
        AND request_payment.provider_transaction_id = payment.provider_transaction_id
    )
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
      WHERE payment.invoice_id = NEW.id
        AND payment.organization_id = NEW.organization_id
        AND payment.status = 'succeeded'
        AND NOT EXISTS (
          SELECT 1
          FROM invoices_payment_requests link
          JOIN payment_request_payments request_payment
            ON request_payment.payment_request_id = link.payment_request_id
          WHERE link.invoice_id = payment.invoice_id
            AND request_payment.provider = payment.provider
            AND request_payment.provider_account_code = payment.provider_account_code
            AND request_payment.provider_transaction_id = payment.provider_transaction_id
        )
      ORDER BY payment.created_at DESC, payment.id DESC LIMIT 1
    );
END;
