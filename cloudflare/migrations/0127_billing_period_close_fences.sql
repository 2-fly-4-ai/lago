-- Transaction-local assertions: a failed eligibility recheck rolls back the
-- entire invoice/credits/period/outbox batch. Successful fences are removed in
-- the same batch; no customer or financial history is modified by migration.
CREATE TABLE billing_period_close_fences (
  guard_id TEXT PRIMARY KEY,
  eligible INTEGER NOT NULL CHECK (eligible = 1)
) STRICT;
