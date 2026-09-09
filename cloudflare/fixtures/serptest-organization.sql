-- Dedicated SERP TEST bootstrap only; never run against existing environments.
-- Fail closed if any other organization exists in the target database.
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM organizations WHERE id != 'org-epd-serptest-20260909'
) THEN abs(-9223372036854775808) ELSE 1 END AS isolated_org_guard;

INSERT INTO organizations (id, external_id, name, created_at, updated_at)
SELECT 'org-epd-serptest-20260909', 'epd-serptest-20260909', 'SERP TEST isolated QA',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE id = 'org-epd-serptest-20260909');
