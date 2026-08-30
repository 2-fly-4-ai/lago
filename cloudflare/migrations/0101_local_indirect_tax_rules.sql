CREATE TABLE indirect_tax_rule_sets (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_published_at TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  refreshed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE (version)
) STRICT;

CREATE UNIQUE INDEX indirect_tax_rule_sets_one_active_idx
  ON indirect_tax_rule_sets(status) WHERE status = 'active';

CREATE TRIGGER indirect_tax_rule_set_identity_immutable
BEFORE UPDATE OF version, source_name, source_url, source_published_at, effective_from,
  effective_to, content_sha256, refreshed_at, created_at
ON indirect_tax_rule_sets
BEGIN
  SELECT RAISE(ABORT, 'immutable_indirect_tax_rule_set_identity');
END;

CREATE TABLE indirect_tax_rules (
  id TEXT PRIMARY KEY,
  rule_set_id TEXT NOT NULL REFERENCES indirect_tax_rule_sets(id) ON DELETE RESTRICT,
  country TEXT NOT NULL CHECK (length(country) = 2 AND country = upper(country)),
  region TEXT CHECK (region IS NULL OR (length(region) BETWEEN 1 AND 100 AND region = upper(region))),
  postal_prefix TEXT CHECK (
    postal_prefix IS NULL OR
    (length(postal_prefix) BETWEEN 1 AND 20 AND postal_prefix = upper(postal_prefix))
  ),
  product_tax_code TEXT NOT NULL CHECK (product_tax_code GLOB 'txcd_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  taxability TEXT NOT NULL CHECK (taxability IN ('taxable', 'exempt')),
  rate_ppm INTEGER NOT NULL CHECK (rate_ppm BETWEEN 0 AND 1000000),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 1000),
  source_url TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_at TEXT NOT NULL,
  CHECK (taxability = 'taxable' OR rate_ppm = 0),
  UNIQUE (rule_set_id, country, region, postal_prefix, product_tax_code, priority)
) STRICT;

CREATE INDEX indirect_tax_rules_match_idx
  ON indirect_tax_rules(rule_set_id, country, product_tax_code, region, postal_prefix, priority);

CREATE TRIGGER indirect_tax_rule_immutable
BEFORE UPDATE ON indirect_tax_rules
BEGIN
  SELECT RAISE(ABORT, 'immutable_indirect_tax_rule');
END;

CREATE TABLE indirect_tax_registration_scopes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  rule_set_id TEXT NOT NULL REFERENCES indirect_tax_rule_sets(id) ON DELETE RESTRICT,
  country TEXT NOT NULL CHECK (length(country) = 2 AND country = upper(country)),
  region TEXT CHECK (region IS NULL OR (length(region) BETWEEN 1 AND 100 AND region = upper(region))),
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  registration_reference TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, rule_set_id, country, region)
) STRICT;

CREATE INDEX indirect_tax_registration_scopes_match_idx
  ON indirect_tax_registration_scopes(organization_id, rule_set_id, country, region, status);

CREATE TRIGGER indirect_tax_registration_scope_identity_immutable
BEFORE UPDATE OF organization_id, rule_set_id, country, region, registration_reference,
  effective_from, created_at
ON indirect_tax_registration_scopes
BEGIN
  SELECT RAISE(ABORT, 'immutable_indirect_tax_registration_scope_identity');
END;

ALTER TABLE easy_pay_direct_checkout_tax_quotes ADD COLUMN local_rule_set_id TEXT
  REFERENCES indirect_tax_rule_sets(id) ON DELETE RESTRICT;
ALTER TABLE easy_pay_direct_checkout_tax_quotes ADD COLUMN local_rule_id TEXT
  REFERENCES indirect_tax_rules(id) ON DELETE RESTRICT;

CREATE TRIGGER easy_pay_direct_checkout_local_tax_identity_immutable
BEFORE UPDATE OF local_rule_set_id, local_rule_id
ON easy_pay_direct_checkout_tax_quotes
BEGIN
  SELECT RAISE(ABORT, 'immutable_easy_pay_direct_checkout_local_tax_identity');
END;
