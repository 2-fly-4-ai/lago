ALTER TABLE organizations ADD COLUMN net_payment_term INTEGER NOT NULL DEFAULT 0
  CHECK (net_payment_term >= 0);
ALTER TABLE customers ADD COLUMN net_payment_term INTEGER CHECK (net_payment_term >= 0);

ALTER TABLE invoices ADD COLUMN net_payment_term INTEGER NOT NULL DEFAULT 0
  CHECK (net_payment_term >= 0);
ALTER TABLE invoices ADD COLUMN payment_due_date TEXT;
ALTER TABLE invoices ADD COLUMN payment_overdue INTEGER NOT NULL DEFAULT 0
  CHECK (payment_overdue IN (0, 1));

UPDATE invoices
SET net_payment_term = COALESCE(
  (SELECT customers.net_payment_term FROM customers WHERE customers.id = invoices.customer_id),
  (SELECT organizations.net_payment_term FROM organizations
   WHERE organizations.id = invoices.organization_id),
  0
);

UPDATE invoices
SET payment_due_date = date(finalized_at, printf('+%d days', net_payment_term))
WHERE finalized_at IS NOT NULL;

CREATE INDEX invoices_payment_due_idx
  ON invoices(payment_due_date, id)
  WHERE status = 'finalized' AND payment_status <> 'succeeded' AND payment_overdue = 0;
