-- NULL retains the historical customer-wide coupon behavior. Store checkout
-- applies regional pricing to an immutable external subscription identity before
-- its initial invoice is generated, never to the whole customer.
ALTER TABLE applied_coupons ADD COLUMN external_subscription_id TEXT;
CREATE INDEX applied_coupons_subscription_scope_idx
  ON applied_coupons(organization_id, customer_id, external_subscription_id, status);
