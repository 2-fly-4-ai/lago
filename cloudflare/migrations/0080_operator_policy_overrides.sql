PRAGMA foreign_keys = ON;

ALTER TABLE customers ADD COLUMN finalize_zero_amount_invoice INTEGER
  CHECK (finalize_zero_amount_invoice IS NULL OR finalize_zero_amount_invoice IN (0, 1));

ALTER TABLE subscriptions ADD COLUMN progressive_billing_disabled INTEGER NOT NULL DEFAULT 0
  CHECK (progressive_billing_disabled IN (0, 1));

ALTER TABLE organizations ADD COLUMN subscription_invoice_issuing_date_adjustment TEXT NOT NULL
  DEFAULT 'align_with_finalization_date'
  CHECK (subscription_invoice_issuing_date_adjustment IN ('keep_anchor', 'align_with_finalization_date'));
ALTER TABLE organizations ADD COLUMN subscription_invoice_issuing_date_anchor TEXT NOT NULL
  DEFAULT 'next_period_start'
  CHECK (subscription_invoice_issuing_date_anchor IN ('current_period_end', 'next_period_start'));

DROP VIEW billing_entities;

CREATE VIEW billing_entities AS
SELECT id,
       id AS organization_id,
       'default' AS code,
       name,
       default_currency,
       country,
       address_line1,
       address_line2,
       city,
       state,
       zipcode,
       0 AS einvoicing,
       email,
       legal_name,
       legal_number,
       timezone,
       net_payment_term,
       email_settings_json,
       CASE document_numbering
         WHEN 'per_organization' THEN 'per_billing_entity'
         ELSE document_numbering
       END AS document_numbering,
       document_number_prefix,
       tax_identification_number,
       finalize_zero_amount_invoice,
       invoice_footer,
       invoice_grace_period,
       subscription_invoice_issuing_date_adjustment,
       subscription_invoice_issuing_date_anchor,
       document_locale,
       1 AS is_default,
       0 AS eu_tax_management,
       NULL AS logo_url,
       version,
       created_at,
       updated_at
FROM organizations;
