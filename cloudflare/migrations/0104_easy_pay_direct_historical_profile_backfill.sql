-- Deliberately do not infer stored-credential consent from historical checkout rows.
--
-- Older EPD profiles can contain a vault reference, but those checkouts predate the explicit
-- recurring/stored-credential fields and original-transaction capture required for a subsequent
-- merchant-initiated transaction. A fresh customer-initiated checkout through the current code is
-- required before automatic collection can be enabled for that subscription.
SELECT 1;
