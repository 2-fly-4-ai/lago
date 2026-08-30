CREATE UNIQUE INDEX indirect_tax_rules_null_safe_identity_idx
  ON indirect_tax_rules (
    rule_set_id,
    country,
    ifnull(region, ''),
    ifnull(postal_prefix, ''),
    product_tax_code,
    priority
  );

CREATE UNIQUE INDEX indirect_tax_registration_scopes_null_safe_identity_idx
  ON indirect_tax_registration_scopes (
    organization_id,
    rule_set_id,
    country,
    ifnull(region, '')
  );
