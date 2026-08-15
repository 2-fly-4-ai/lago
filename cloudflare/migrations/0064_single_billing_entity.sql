PRAGMA foreign_keys = ON;

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
       'align_with_finalization_date' AS subscription_invoice_issuing_date_adjustment,
       'next_period_start' AS subscription_invoice_issuing_date_anchor,
       document_locale,
       1 AS is_default,
       0 AS eu_tax_management,
       NULL AS logo_url,
       version,
       created_at,
       updated_at
FROM organizations;

CREATE TRIGGER billing_entity_outbox_version_guard
BEFORE INSERT ON outbox_events
WHEN NEW.event_type = 'billing_entity.updated' AND NOT EXISTS (
  SELECT 1 FROM organizations
  WHERE id = NEW.aggregate_id
    AND id = NEW.organization_id
    AND version = NEW.aggregate_version
)
BEGIN
  SELECT RAISE(ABORT, 'billing_entity_outbox_version_conflict');
END;
