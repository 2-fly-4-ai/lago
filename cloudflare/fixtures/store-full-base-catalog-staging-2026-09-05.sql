-- Additive flat catalog bootstrap; source d01233ffdc9718ee7e89fe6250c6e163d4e41172.
-- Preflight deliberately fails with integer overflow on missing tenant or conflicting catalog.
WITH desired(code, name, interval, amount_minor, currency) AS (VALUES
('serp-1-app-plan-monthly', 'SERP App Plan Monthly', 'monthly', '900', 'USD'),
('serp-1-app-plan-yearly', 'SERP App Plan Yearly', 'yearly', '7900', 'USD'),
('serp-1-app-plan-one-time', 'SERP App Plan One Time', 'one_time', '900', 'USD'),
('serp-app-plus-plan-monthly', 'SERP App Plus Monthly', 'monthly', '1700', 'USD'),
('serp-app-plus-plan-yearly', 'SERP App Plus Yearly', 'yearly', '14900', 'USD'),
('serp-app-plus-plan-one-time', 'SERP App Plus One Time', 'one_time', '1700', 'USD'),
('serp-1-app-plus-plan-monthly', 'SERP App Pro Monthly', 'monthly', '2700', 'USD'),
('serp-1-app-plus-plan-yearly', 'SERP App Pro Yearly', 'yearly', '23900', 'USD'),
('serp-1-app-plus-plan-one-time', 'SERP App Pro One Time', 'one_time', '2700', 'USD'),
('serp-1-app-premium-plan-monthly', 'SERP App Premium Monthly', 'monthly', '3700', 'USD'),
('serp-1-app-premium-plan-yearly', 'SERP App Premium Yearly', 'yearly', '32900', 'USD'),
('serp-1-app-premium-plan-one-time', 'SERP App Premium One Time', 'one_time', '3700', 'USD'),
('serp-1-app-lifetime-plan-one-time', 'SERP App Lifetime One Time', 'one_time', '9900', 'USD'),
('serp-downloaders-bundle-monthly', 'SERP Downloaders Bundle Monthly', 'monthly', '7900', 'USD'),
('serp-downloaders-bundle-yearly', 'SERP Downloaders Bundle Yearly', 'yearly', '87900', 'USD')
)
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM organizations WHERE id='org-synthetic-e2e-20260815-001')
  OR EXISTS(SELECT 1 FROM desired d JOIN plans p ON p.organization_id = 'org-synthetic-e2e-20260815-001'
    AND p.code = d.code AND p.parent_id IS NULL
    AND p.version = (SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id AND v.code=p.code AND v.parent_id IS NULL)
    WHERE p.interval != d.interval OR p.amount_minor != CAST(d.amount_minor AS INTEGER)
      OR p.currency != d.currency OR p.active != 1 OR p.pending_deletion != 0 OR p.pay_in_advance != 1) THEN abs(-9223372036854775808) ELSE 1 END AS catalog_preflight;
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-522e9cf1cee25ab56b05520bad63d606','org-synthetic-e2e-20260815-001','serp-1-app-plan-monthly','SERP App Plan Monthly','monthly',900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-synthetic-e2e-20260815-001' AND code='serp-1-app-plan-monthly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-d65978c462b3d903b6842eaa496fe1aa','org-synthetic-e2e-20260815-001','serp-1-app-plan-yearly','SERP App Plan Yearly','yearly',7900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-synthetic-e2e-20260815-001' AND code='serp-1-app-plan-yearly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-fad7bbcff09f1ce4e4b3cfe5986c1744','org-synthetic-e2e-20260815-001','serp-1-app-plan-one-time','SERP App Plan One Time','one_time',900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-synthetic-e2e-20260815-001' AND code='serp-1-app-plan-one-time' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-cbf62556fba7170d3ccb149ade0f05fe','org-synthetic-e2e-20260815-001','serp-app-plus-plan-monthly','SERP App Plus Monthly','monthly',1700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-synthetic-e2e-20260815-001' AND code='serp-app-plus-plan-monthly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-4954123b86a689d1e84901c080898a68','org-synthetic-e2e-20260815-001','serp-app-plus-plan-yearly','SERP App Plus Yearly','yearly',14900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-synthetic-e2e-20260815-001' AND code='serp-app-plus-plan-yearly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-f13c921b71d3c020971f35d678e3e687','org-synthetic-e2e-20260815-001','serp-app-plus-plan-one-time','SERP App Plus One Time','one_time',1700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-synthetic-e2e-20260815-001' AND code='serp-app-plus-plan-one-time' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-09713fe44c15b7675f4bbd783c0c656f','org-synthetic-e2e-20260815-001','serp-1-app-plus-plan-monthly','SERP App Pro Monthly','monthly',2700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-synthetic-e2e-20260815-001' AND code='serp-1-app-plus-plan-monthly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-19394b24f7ce913a2acc863926abcf9b','org-synthetic-e2e-20260815-001','serp-1-app-plus-plan-yearly','SERP App Pro Yearly','yearly',23900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-synthetic-e2e-20260815-001' AND code='serp-1-app-plus-plan-yearly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-aa08ac15a7ca8dbb113aa3498360aa2d','org-synthetic-e2e-20260815-001','serp-1-app-plus-plan-one-time','SERP App Pro One Time','one_time',2700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-synthetic-e2e-20260815-001' AND code='serp-1-app-plus-plan-one-time' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-52b14a141c99b9ab098010ee876ea017','org-synthetic-e2e-20260815-001','serp-1-app-premium-plan-monthly','SERP App Premium Monthly','monthly',3700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-synthetic-e2e-20260815-001' AND code='serp-1-app-premium-plan-monthly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-d88faedd2831f9f4ec9133c92d53f63d','org-synthetic-e2e-20260815-001','serp-1-app-premium-plan-yearly','SERP App Premium Yearly','yearly',32900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-synthetic-e2e-20260815-001' AND code='serp-1-app-premium-plan-yearly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-913a27c8f71a5471f17402506aff70c0','org-synthetic-e2e-20260815-001','serp-1-app-premium-plan-one-time','SERP App Premium One Time','one_time',3700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-synthetic-e2e-20260815-001' AND code='serp-1-app-premium-plan-one-time' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-5663b63b37fd7031c9fda3d820eb7ef4','org-synthetic-e2e-20260815-001','serp-1-app-lifetime-plan-one-time','SERP App Lifetime One Time','one_time',9900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-synthetic-e2e-20260815-001' AND code='serp-1-app-lifetime-plan-one-time' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-2714fa77cb336c011490e201e098ec64','org-synthetic-e2e-20260815-001','serp-downloaders-bundle-monthly','SERP Downloaders Bundle Monthly','monthly',7900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-synthetic-e2e-20260815-001' AND code='serp-downloaders-bundle-monthly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-4e8d2aefcd8d39e4418d5fe612e059af','org-synthetic-e2e-20260815-001','serp-downloaders-bundle-yearly','SERP Downloaders Bundle Yearly','yearly',87900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-synthetic-e2e-20260815-001' AND code='serp-downloaders-bundle-yearly' AND parent_id IS NULL);
