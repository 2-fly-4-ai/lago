WITH production_plan_names(code, name, invoice_display_name, description) AS (
  VALUES
    ('serp-1-app-plan-monthly', 'SERP App Plan Monthly', 'SERP App Plan', 'One eligible SERP app, billed monthly.'),
    ('serp-1-app-plan-yearly', 'SERP App Plan Yearly', 'SERP App Plan', 'One eligible SERP app, billed yearly.')
)
UPDATE plans
SET name = (
      SELECT seed.name FROM production_plan_names seed WHERE seed.code = plans.code
    ),
    invoice_display_name = (
      SELECT seed.invoice_display_name
      FROM production_plan_names seed
      WHERE seed.code = plans.code
    ),
    description = (
      SELECT seed.description FROM production_plan_names seed WHERE seed.code = plans.code
    ),
    version = version + 1,
    updated_at = '2026-08-28T00:00:00.000Z'
WHERE organization_id = 'org-serp-billing'
  AND code IN (SELECT code FROM production_plan_names);

INSERT OR IGNORE INTO plans
  (id, organization_id, code, name, interval, amount_minor, currency, version,
   active, created_at, updated_at, invoice_display_name, description,
   pay_in_advance, metadata_json)
SELECT
  'plan-serp-billing-serp-1-app-plan-one-time',
  organization.id,
  'serp-1-app-plan-one-time',
  'SERP App Plan One Time',
  'one_time',
  900,
  'USD',
  1,
  1,
  '2026-08-28T00:00:00.000Z',
  '2026-08-28T00:00:00.000Z',
  'SERP App Plan',
  'One eligible SERP app with a one-time payment.',
  1,
  '{"consumer":"serp-prod-safe-store","purchase_models":"one_time","billing_route":"lago-epd"}'
FROM organizations organization
WHERE organization.id = 'org-serp-billing';
