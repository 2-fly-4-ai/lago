CREATE TABLE indirect_tax_rule_components (
  rule_id TEXT NOT NULL REFERENCES indirect_tax_rules(id),
  code TEXT NOT NULL CHECK(code IN ('GST','HST','PST','RST','QST')),
  rate_ppm INTEGER NOT NULL CHECK(rate_ppm > 0 AND rate_ppm <= 1000000),
  source_url TEXT NOT NULL,
  PRIMARY KEY(rule_id,code)
);
CREATE TRIGGER indirect_tax_components_draft_insert
BEFORE INSERT ON indirect_tax_rule_components
WHEN NOT EXISTS (
  SELECT 1 FROM indirect_tax_rules r JOIN indirect_tax_rule_sets s ON s.id=r.rule_set_id
  WHERE r.id=NEW.rule_id AND s.status='draft' AND r.country='CA'
)
BEGIN SELECT RAISE(ABORT,'tax_components_require_canadian_draft'); END;
CREATE TRIGGER indirect_tax_components_no_update
BEFORE UPDATE ON indirect_tax_rule_components
BEGIN SELECT RAISE(ABORT,'immutable_tax_component'); END;
CREATE TRIGGER indirect_tax_components_no_delete
BEFORE DELETE ON indirect_tax_rule_components
BEGIN SELECT RAISE(ABORT,'immutable_tax_component'); END;
