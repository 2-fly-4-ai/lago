ALTER TABLE subscriptions
  ADD COLUMN on_termination_credit_note TEXT
  CHECK (on_termination_credit_note IN ('credit', 'skip', 'refund', 'offset'));

ALTER TABLE subscriptions
  ADD COLUMN on_termination_invoice TEXT
  CHECK (on_termination_invoice IN ('generate', 'skip'));
