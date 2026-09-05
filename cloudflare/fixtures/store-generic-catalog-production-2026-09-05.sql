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
('serp-1-app-lifetime-plan-one-time', 'SERP App Lifetime One Time', 'one_time', '9900', 'USD')
)
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM organizations WHERE id='org-serp-billing')
  OR EXISTS(SELECT 1 FROM desired d JOIN plans p ON p.organization_id = 'org-serp-billing'
    AND p.code = d.code AND p.parent_id IS NULL
    AND p.version = (SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id AND v.code=p.code AND v.parent_id IS NULL)
    WHERE p.interval != d.interval OR p.amount_minor != CAST(d.amount_minor AS INTEGER)
      OR p.currency != d.currency OR p.active != 1 OR p.pending_deletion != 0 OR p.pay_in_advance != 1) THEN abs(-9223372036854775808) ELSE 1 END AS catalog_preflight;
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-36e400e17b798e2a06f3458a0602eb63','org-serp-billing','serp-1-app-plan-monthly','SERP App Plan Monthly','monthly',900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-serp-billing' AND code='serp-1-app-plan-monthly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-06c9cdd3299eb5828fc782ea7d96739d','org-serp-billing','serp-1-app-plan-yearly','SERP App Plan Yearly','yearly',7900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-serp-billing' AND code='serp-1-app-plan-yearly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-237071e6ac273b677bc46261eef16d03','org-serp-billing','serp-1-app-plan-one-time','SERP App Plan One Time','one_time',900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-serp-billing' AND code='serp-1-app-plan-one-time' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-140a30091d7f85956050bd83a8a8b01f','org-serp-billing','serp-app-plus-plan-monthly','SERP App Plus Monthly','monthly',1700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-serp-billing' AND code='serp-app-plus-plan-monthly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-a4eff451c24f537548405901d70cdf1d','org-serp-billing','serp-app-plus-plan-yearly','SERP App Plus Yearly','yearly',14900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-serp-billing' AND code='serp-app-plus-plan-yearly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-529ab18cbee17786c4cb5826a34667df','org-serp-billing','serp-app-plus-plan-one-time','SERP App Plus One Time','one_time',1700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-serp-billing' AND code='serp-app-plus-plan-one-time' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-5d319e7525f6c3d4abbacea6a855b803','org-serp-billing','serp-1-app-plus-plan-monthly','SERP App Pro Monthly','monthly',2700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-serp-billing' AND code='serp-1-app-plus-plan-monthly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-d3a5e85f85534db5d4cadbcb88a365b3','org-serp-billing','serp-1-app-plus-plan-yearly','SERP App Pro Yearly','yearly',23900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-serp-billing' AND code='serp-1-app-plus-plan-yearly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-8744612d2f3ad4b391f9bbf99084ddf6','org-serp-billing','serp-1-app-plus-plan-one-time','SERP App Pro One Time','one_time',2700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-serp-billing' AND code='serp-1-app-plus-plan-one-time' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-43a87df6acd2fe9fcad1ecf15bc132b2','org-serp-billing','serp-1-app-premium-plan-monthly','SERP App Premium Monthly','monthly',3700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-serp-billing' AND code='serp-1-app-premium-plan-monthly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-63d838a5f64ced500878236ac70dd77e','org-serp-billing','serp-1-app-premium-plan-yearly','SERP App Premium Yearly','yearly',32900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-serp-billing' AND code='serp-1-app-premium-plan-yearly' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-d91cccdb7261698736570284f321d8a0','org-serp-billing','serp-1-app-premium-plan-one-time','SERP App Premium One Time','one_time',3700,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-serp-billing' AND code='serp-1-app-premium-plan-one-time' AND parent_id IS NULL);
INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT 'catalog-ab35c7376b10bcc1c7a504d6077e6187','org-serp-billing','serp-1-app-lifetime-plan-one-time','SERP App Lifetime One Time','one_time',9900,'USD',1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,'{"source":"store-new","source_commit":"d01233ffdc9718ee7e89fe6250c6e163d4e41172","catalog_repair":"2026-09-05"}',0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id='org-serp-billing' AND code='serp-1-app-lifetime-plan-one-time' AND parent_id IS NULL);
