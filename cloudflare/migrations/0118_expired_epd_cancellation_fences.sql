-- Transaction-local assertion. No provider request, subscription or child mutation
-- can be authorized by an expired-date decision from an earlier HTTP read.
CREATE TABLE expired_epd_cancellation_fences (
  guard_id TEXT PRIMARY KEY,
  eligible INTEGER NOT NULL CONSTRAINT expired_epd_cancellation_current CHECK (eligible = 1)
);
