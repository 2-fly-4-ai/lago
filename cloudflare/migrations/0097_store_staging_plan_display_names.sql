WITH store_plan_names(code, name, invoice_display_name, description) AS (
  VALUES
    ('serp-1-app-plan-monthly', 'SERP App Plan Monthly', 'SERP App Plan', 'One eligible SERP app, billed monthly.'),
    ('serp-1-app-plan-yearly', 'SERP App Plan Yearly', 'SERP App Plan', 'One eligible SERP app, billed yearly.'),
    ('serp-1-app-plan-one-time', 'SERP App Plan One Time', 'SERP App Plan', 'One eligible SERP app with a one-time payment.'),
    ('serp-app-plus-plan-monthly', 'SERP App Plus Monthly', 'SERP App Plus', 'One eligible SERP App Plus product, billed monthly.'),
    ('serp-app-plus-plan-yearly', 'SERP App Plus Yearly', 'SERP App Plus', 'One eligible SERP App Plus product, billed yearly.'),
    ('serp-app-plus-plan-one-time', 'SERP App Plus One Time', 'SERP App Plus', 'One eligible SERP App Plus product with a one-time payment.'),
    ('serp-1-app-plus-plan-monthly', 'SERP App Pro Monthly', 'SERP App Pro', 'One eligible SERP App Pro product, billed monthly.'),
    ('serp-1-app-plus-plan-yearly', 'SERP App Pro Yearly', 'SERP App Pro', 'One eligible SERP App Pro product, billed yearly.'),
    ('serp-1-app-plus-plan-one-time', 'SERP App Pro One Time', 'SERP App Pro', 'One eligible SERP App Pro product with a one-time payment.'),
    ('serp-1-app-premium-plan-monthly', 'SERP App Premium Monthly', 'SERP App Premium', 'One eligible SERP App Premium product, billed monthly.'),
    ('serp-1-app-premium-plan-yearly', 'SERP App Premium Yearly', 'SERP App Premium', 'One eligible SERP App Premium product, billed yearly.'),
    ('serp-1-app-premium-plan-one-time', 'SERP App Premium One Time', 'SERP App Premium', 'One eligible SERP App Premium product with a one-time payment.'),
    ('serp-1-app-lifetime-plan-one-time', 'SERP App Lifetime', 'SERP App Lifetime', 'Lifetime access to one eligible SERP app.')
)
UPDATE plans
SET name = (
      SELECT seed.name FROM store_plan_names seed WHERE seed.code = plans.code
    ),
    invoice_display_name = (
      SELECT seed.invoice_display_name FROM store_plan_names seed WHERE seed.code = plans.code
    ),
    description = (
      SELECT seed.description FROM store_plan_names seed WHERE seed.code = plans.code
    ),
    version = version + 1,
    updated_at = '2026-08-26T08:30:00.000Z'
WHERE organization_id = 'org-synthetic-e2e-20260815-001'
  AND code IN (SELECT code FROM store_plan_names);
