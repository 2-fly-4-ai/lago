-- Apply as one transactional D1 file/batch only after environment-specific approval.
-- No prices, intervals, routing, registrations, or existing tax classifications change.
WITH desired(code, amount, currency, interval) AS (VALUES ('serp-1-app-plan-monthly',900,'USD','monthly'),('serp-1-app-plan-yearly',7900,'USD','yearly'),('serp-1-app-plan-one-time',900,'USD','one_time'),('serp-app-plus-plan-monthly',1700,'USD','monthly'),('serp-app-plus-plan-yearly',14900,'USD','yearly'),('serp-app-plus-plan-one-time',1700,'USD','one_time'),('serp-1-app-plus-plan-monthly',2700,'USD','monthly'),('serp-1-app-plus-plan-yearly',23900,'USD','yearly'),('serp-1-app-plus-plan-one-time',2700,'USD','one_time'),('serp-1-app-premium-plan-monthly',3700,'USD','monthly'),('serp-1-app-premium-plan-yearly',32900,'USD','yearly'),('serp-1-app-premium-plan-one-time',3700,'USD','one_time'),('serp-1-app-lifetime-plan-one-time',9900,'USD','one_time'))
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM organizations WHERE id='org-epd-serptest-20260909')
 OR EXISTS(SELECT 1 FROM desired d LEFT JOIN plans p ON p.code=d.code AND p.organization_id='org-epd-serptest-20260909' AND p.parent_id IS NULL
    AND p.version=(SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id
      AND v.code=p.code AND v.parent_id IS NULL)
   WHERE p.id IS NULL OR p.amount_minor!=d.amount OR p.currency!=d.currency
     OR p.interval!=d.interval OR p.active!=1 OR p.pending_deletion!=0
     OR p.pay_in_advance!=1 OR NOT json_valid(p.metadata_json)
     OR (json_extract(p.metadata_json,'$.tax_code') IS NOT NULL
         AND json_extract(p.metadata_json,'$.tax_code')!='txcd_10202000'))
 THEN abs(-9223372036854775808) ELSE 1 END AS classification_preflight;
UPDATE plans AS p SET
 metadata_json=json_set(p.metadata_json,'$.tax_code','txcd_10202000',
   '$.tax_classification','downloaded-prewritten-software-consumer','$.tax_classification_evidence','docs/evidence/generic-plan-tax-classification-2026-09-06.md',
   '$.tax_classification_reviewed_on','2026-09-06'),
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE p.organization_id='org-epd-serptest-20260909' AND p.parent_id IS NULL
    AND p.version=(SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id
      AND v.code=p.code AND v.parent_id IS NULL) AND p.code='serp-1-app-plan-monthly' AND json_extract(p.metadata_json,'$.tax_code') IS NULL;
UPDATE plans AS p SET
 metadata_json=json_set(p.metadata_json,'$.tax_code','txcd_10202000',
   '$.tax_classification','downloaded-prewritten-software-consumer','$.tax_classification_evidence','docs/evidence/generic-plan-tax-classification-2026-09-06.md',
   '$.tax_classification_reviewed_on','2026-09-06'),
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE p.organization_id='org-epd-serptest-20260909' AND p.parent_id IS NULL
    AND p.version=(SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id
      AND v.code=p.code AND v.parent_id IS NULL) AND p.code='serp-1-app-plan-yearly' AND json_extract(p.metadata_json,'$.tax_code') IS NULL;
UPDATE plans AS p SET
 metadata_json=json_set(p.metadata_json,'$.tax_code','txcd_10202000',
   '$.tax_classification','downloaded-prewritten-software-consumer','$.tax_classification_evidence','docs/evidence/generic-plan-tax-classification-2026-09-06.md',
   '$.tax_classification_reviewed_on','2026-09-06'),
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE p.organization_id='org-epd-serptest-20260909' AND p.parent_id IS NULL
    AND p.version=(SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id
      AND v.code=p.code AND v.parent_id IS NULL) AND p.code='serp-1-app-plan-one-time' AND json_extract(p.metadata_json,'$.tax_code') IS NULL;
UPDATE plans AS p SET
 metadata_json=json_set(p.metadata_json,'$.tax_code','txcd_10202000',
   '$.tax_classification','downloaded-prewritten-software-consumer','$.tax_classification_evidence','docs/evidence/generic-plan-tax-classification-2026-09-06.md',
   '$.tax_classification_reviewed_on','2026-09-06'),
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE p.organization_id='org-epd-serptest-20260909' AND p.parent_id IS NULL
    AND p.version=(SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id
      AND v.code=p.code AND v.parent_id IS NULL) AND p.code='serp-app-plus-plan-monthly' AND json_extract(p.metadata_json,'$.tax_code') IS NULL;
UPDATE plans AS p SET
 metadata_json=json_set(p.metadata_json,'$.tax_code','txcd_10202000',
   '$.tax_classification','downloaded-prewritten-software-consumer','$.tax_classification_evidence','docs/evidence/generic-plan-tax-classification-2026-09-06.md',
   '$.tax_classification_reviewed_on','2026-09-06'),
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE p.organization_id='org-epd-serptest-20260909' AND p.parent_id IS NULL
    AND p.version=(SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id
      AND v.code=p.code AND v.parent_id IS NULL) AND p.code='serp-app-plus-plan-yearly' AND json_extract(p.metadata_json,'$.tax_code') IS NULL;
UPDATE plans AS p SET
 metadata_json=json_set(p.metadata_json,'$.tax_code','txcd_10202000',
   '$.tax_classification','downloaded-prewritten-software-consumer','$.tax_classification_evidence','docs/evidence/generic-plan-tax-classification-2026-09-06.md',
   '$.tax_classification_reviewed_on','2026-09-06'),
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE p.organization_id='org-epd-serptest-20260909' AND p.parent_id IS NULL
    AND p.version=(SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id
      AND v.code=p.code AND v.parent_id IS NULL) AND p.code='serp-app-plus-plan-one-time' AND json_extract(p.metadata_json,'$.tax_code') IS NULL;
UPDATE plans AS p SET
 metadata_json=json_set(p.metadata_json,'$.tax_code','txcd_10202000',
   '$.tax_classification','downloaded-prewritten-software-consumer','$.tax_classification_evidence','docs/evidence/generic-plan-tax-classification-2026-09-06.md',
   '$.tax_classification_reviewed_on','2026-09-06'),
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE p.organization_id='org-epd-serptest-20260909' AND p.parent_id IS NULL
    AND p.version=(SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id
      AND v.code=p.code AND v.parent_id IS NULL) AND p.code='serp-1-app-plus-plan-monthly' AND json_extract(p.metadata_json,'$.tax_code') IS NULL;
UPDATE plans AS p SET
 metadata_json=json_set(p.metadata_json,'$.tax_code','txcd_10202000',
   '$.tax_classification','downloaded-prewritten-software-consumer','$.tax_classification_evidence','docs/evidence/generic-plan-tax-classification-2026-09-06.md',
   '$.tax_classification_reviewed_on','2026-09-06'),
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE p.organization_id='org-epd-serptest-20260909' AND p.parent_id IS NULL
    AND p.version=(SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id
      AND v.code=p.code AND v.parent_id IS NULL) AND p.code='serp-1-app-plus-plan-yearly' AND json_extract(p.metadata_json,'$.tax_code') IS NULL;
UPDATE plans AS p SET
 metadata_json=json_set(p.metadata_json,'$.tax_code','txcd_10202000',
   '$.tax_classification','downloaded-prewritten-software-consumer','$.tax_classification_evidence','docs/evidence/generic-plan-tax-classification-2026-09-06.md',
   '$.tax_classification_reviewed_on','2026-09-06'),
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE p.organization_id='org-epd-serptest-20260909' AND p.parent_id IS NULL
    AND p.version=(SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id
      AND v.code=p.code AND v.parent_id IS NULL) AND p.code='serp-1-app-plus-plan-one-time' AND json_extract(p.metadata_json,'$.tax_code') IS NULL;
UPDATE plans AS p SET
 metadata_json=json_set(p.metadata_json,'$.tax_code','txcd_10202000',
   '$.tax_classification','downloaded-prewritten-software-consumer','$.tax_classification_evidence','docs/evidence/generic-plan-tax-classification-2026-09-06.md',
   '$.tax_classification_reviewed_on','2026-09-06'),
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE p.organization_id='org-epd-serptest-20260909' AND p.parent_id IS NULL
    AND p.version=(SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id
      AND v.code=p.code AND v.parent_id IS NULL) AND p.code='serp-1-app-premium-plan-monthly' AND json_extract(p.metadata_json,'$.tax_code') IS NULL;
UPDATE plans AS p SET
 metadata_json=json_set(p.metadata_json,'$.tax_code','txcd_10202000',
   '$.tax_classification','downloaded-prewritten-software-consumer','$.tax_classification_evidence','docs/evidence/generic-plan-tax-classification-2026-09-06.md',
   '$.tax_classification_reviewed_on','2026-09-06'),
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE p.organization_id='org-epd-serptest-20260909' AND p.parent_id IS NULL
    AND p.version=(SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id
      AND v.code=p.code AND v.parent_id IS NULL) AND p.code='serp-1-app-premium-plan-yearly' AND json_extract(p.metadata_json,'$.tax_code') IS NULL;
UPDATE plans AS p SET
 metadata_json=json_set(p.metadata_json,'$.tax_code','txcd_10202000',
   '$.tax_classification','downloaded-prewritten-software-consumer','$.tax_classification_evidence','docs/evidence/generic-plan-tax-classification-2026-09-06.md',
   '$.tax_classification_reviewed_on','2026-09-06'),
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE p.organization_id='org-epd-serptest-20260909' AND p.parent_id IS NULL
    AND p.version=(SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id
      AND v.code=p.code AND v.parent_id IS NULL) AND p.code='serp-1-app-premium-plan-one-time' AND json_extract(p.metadata_json,'$.tax_code') IS NULL;
UPDATE plans AS p SET
 metadata_json=json_set(p.metadata_json,'$.tax_code','txcd_10202000',
   '$.tax_classification','downloaded-prewritten-software-consumer','$.tax_classification_evidence','docs/evidence/generic-plan-tax-classification-2026-09-06.md',
   '$.tax_classification_reviewed_on','2026-09-06'),
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE p.organization_id='org-epd-serptest-20260909' AND p.parent_id IS NULL
    AND p.version=(SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id
      AND v.code=p.code AND v.parent_id IS NULL) AND p.code='serp-1-app-lifetime-plan-one-time' AND json_extract(p.metadata_json,'$.tax_code') IS NULL;
