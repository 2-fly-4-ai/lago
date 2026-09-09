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
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM organizations WHERE id='org-epd-serptest-20260909')
  OR EXISTS(SELECT 1 FROM desired d JOIN plans p ON p.organization_id = 'org-epd-serptest-20260909'
    AND p.code = d.code AND p.parent_id IS NULL
    AND p.version = (SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id AND v.code=p.code AND v.parent_id IS NULL)
    WHERE p.interval != d.interval OR p.amount_minor != CAST(d.amount_minor AS INTEGER)
      OR p.currency != d.currency OR p.active != 1 OR p.pending_deletion != 0 OR p.pay_in_advance != 1) THEN abs(-9223372036854775808) ELSE 1 END AS catalog_preflight;
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-e7fdc03afb032c7241629cf0b2ea098e','org-epd-serptest-20260909','serp-1-app-plan-monthly','SERP App Plan Monthly','monthly',900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-epd-serptest-20260909' AND code='serp-1-app-plan-monthly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-0450581bd8c810a7c5f10cdc5adb2703','org-epd-serptest-20260909','serp-1-app-plan-yearly','SERP App Plan Yearly','yearly',7900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-epd-serptest-20260909' AND code='serp-1-app-plan-yearly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-fa8cf95d256c29496ca0f3f16e070e26','org-epd-serptest-20260909','serp-1-app-plan-one-time','SERP App Plan One Time','one_time',900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-epd-serptest-20260909' AND code='serp-1-app-plan-one-time' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-8719f97655361055ab2b6df86f64d21a','org-epd-serptest-20260909','serp-app-plus-plan-monthly','SERP App Plus Monthly','monthly',1700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-epd-serptest-20260909' AND code='serp-app-plus-plan-monthly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-adf15ba2fb73f3985eca5c5368c3b29f','org-epd-serptest-20260909','serp-app-plus-plan-yearly','SERP App Plus Yearly','yearly',14900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-epd-serptest-20260909' AND code='serp-app-plus-plan-yearly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-368a4a00c54cb8860032c1bafdbbfaea','org-epd-serptest-20260909','serp-app-plus-plan-one-time','SERP App Plus One Time','one_time',1700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-epd-serptest-20260909' AND code='serp-app-plus-plan-one-time' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-f3db2635348b8dfea99eb447ddfd4860','org-epd-serptest-20260909','serp-1-app-plus-plan-monthly','SERP App Pro Monthly','monthly',2700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-epd-serptest-20260909' AND code='serp-1-app-plus-plan-monthly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-c67997ef3760f3ea383cdd7c248fcdcb','org-epd-serptest-20260909','serp-1-app-plus-plan-yearly','SERP App Pro Yearly','yearly',23900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-epd-serptest-20260909' AND code='serp-1-app-plus-plan-yearly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-0a66645abe6403bcf3864b2538cf3591','org-epd-serptest-20260909','serp-1-app-plus-plan-one-time','SERP App Pro One Time','one_time',2700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-epd-serptest-20260909' AND code='serp-1-app-plus-plan-one-time' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-d15d1b7b1bd0f8898491018aeefb60b6','org-epd-serptest-20260909','serp-1-app-premium-plan-monthly','SERP App Premium Monthly','monthly',3700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-epd-serptest-20260909' AND code='serp-1-app-premium-plan-monthly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-1e9f9cf68c2203ae087234c9c4a29e7e','org-epd-serptest-20260909','serp-1-app-premium-plan-yearly','SERP App Premium Yearly','yearly',32900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-epd-serptest-20260909' AND code='serp-1-app-premium-plan-yearly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-d69f56c9f604549a77e2a7f9e6469cb4','org-epd-serptest-20260909','serp-1-app-premium-plan-one-time','SERP App Premium One Time','one_time',3700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-epd-serptest-20260909' AND code='serp-1-app-premium-plan-one-time' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-0cfa142a6e1a9577432a15e677c20279','org-epd-serptest-20260909','serp-1-app-lifetime-plan-one-time','SERP App Lifetime One Time','one_time',9900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-epd-serptest-20260909' AND code='serp-1-app-lifetime-plan-one-time' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-218985f918c423d9ab2ac46da4127399','org-epd-serptest-20260909','serp-downloaders-bundle-monthly','SERP Downloaders Bundle Monthly','monthly',7900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-epd-serptest-20260909' AND code='serp-downloaders-bundle-monthly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-daad998e506ae6d85c7b2ca0f26a11eb','org-epd-serptest-20260909','serp-downloaders-bundle-yearly','SERP Downloaders Bundle Yearly','yearly',87900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-epd-serptest-20260909' AND code='serp-downloaders-bundle-yearly' AND parent_id IS NULL);
