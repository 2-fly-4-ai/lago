WITH store_plan_seed(code, name, interval, amount_minor, invoice_display_name) AS (
  VALUES
    ('serp-1-app-plan-monthly', 'Synthetic Store SERP App Plan Monthly', 'monthly', 900, 'Synthetic Store App Plan'),
    ('serp-1-app-plan-yearly', 'Synthetic Store SERP App Plan Yearly', 'yearly', 7900, 'Synthetic Store App Plan'),
    ('serp-1-app-plan-one-time', 'Synthetic Store SERP App Plan One Time', 'one_time', 900, 'Synthetic Store App Plan'),
    ('serp-app-plus-plan-monthly', 'Synthetic Store SERP App Plus Monthly', 'monthly', 1700, 'Synthetic Store App Plus'),
    ('serp-app-plus-plan-yearly', 'Synthetic Store SERP App Plus Yearly', 'yearly', 14900, 'Synthetic Store App Plus'),
    ('serp-app-plus-plan-one-time', 'Synthetic Store SERP App Plus One Time', 'one_time', 1700, 'Synthetic Store App Plus'),
    ('serp-1-app-plus-plan-monthly', 'Synthetic Store SERP App Pro Monthly', 'monthly', 2700, 'Synthetic Store App Pro'),
    ('serp-1-app-plus-plan-yearly', 'Synthetic Store SERP App Pro Yearly', 'yearly', 23900, 'Synthetic Store App Pro'),
    ('serp-1-app-plus-plan-one-time', 'Synthetic Store SERP App Pro One Time', 'one_time', 2700, 'Synthetic Store App Pro'),
    ('serp-1-app-premium-plan-monthly', 'Synthetic Store SERP App Premium Monthly', 'monthly', 3700, 'Synthetic Store App Premium'),
    ('serp-1-app-premium-plan-yearly', 'Synthetic Store SERP App Premium Yearly', 'yearly', 32900, 'Synthetic Store App Premium'),
    ('serp-1-app-premium-plan-one-time', 'Synthetic Store SERP App Premium One Time', 'one_time', 3700, 'Synthetic Store App Premium'),
    ('serp-1-app-lifetime-plan-one-time', 'Synthetic Store SERP App Lifetime', 'one_time', 9900, 'Synthetic Store App Lifetime')
)
INSERT OR IGNORE INTO plans
  (id, organization_id, code, name, interval, amount_minor, currency, version,
   active, created_at, updated_at, invoice_display_name, description,
   pay_in_advance, metadata_json)
SELECT
  'plan-store-staging-' || seed.code || '-20260826',
  organization.id,
  seed.code,
  seed.name,
  seed.interval,
  seed.amount_minor,
  'USD',
  1,
  1,
  '2026-08-26T00:00:00.000Z',
  '2026-08-26T00:00:00.000Z',
  seed.invoice_display_name,
  'Synthetic-only Store-to-Lago staging contract plan',
  1,
  '{"synthetic":true,"consumer":"serp-dev-safe-store","purchase_models":"subscription,one_time"}'
FROM organizations organization
CROSS JOIN store_plan_seed seed
WHERE organization.id = 'org-synthetic-e2e-20260815-001';
