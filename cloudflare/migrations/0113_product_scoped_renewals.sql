-- Immutable attribution from the authenticated Store, never customer metadata.
CREATE TABLE subscription_checkout_products (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  product_slug TEXT NOT NULL CHECK (length(product_slug) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER subscription_checkout_products_tenant_guard
BEFORE INSERT ON subscription_checkout_products
WHEN NOT EXISTS (SELECT 1 FROM subscriptions s
  WHERE s.id = NEW.subscription_id AND s.organization_id = NEW.organization_id)
BEGIN
  SELECT RAISE(ABORT, 'invalid_subscription_checkout_product');
END;

CREATE TRIGGER subscription_checkout_products_immutable_guard
BEFORE UPDATE ON subscription_checkout_products
BEGIN
  SELECT RAISE(ABORT, 'immutable_subscription_checkout_product');
END;

CREATE TABLE easy_pay_direct_product_collection_policies (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  product_slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, product_slug)
) STRICT;

-- Only this canary is authorized. No historical subscription is backfilled.
INSERT INTO easy_pay_direct_product_collection_policies
  (organization_id, product_slug, status, created_at)
SELECT id, 'sprout-video-downloader', 'enabled', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM organizations WHERE id IN ('org-serp-billing', 'org-synthetic-e2e-20260815-001');
