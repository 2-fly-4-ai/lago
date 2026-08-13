CREATE TABLE add_ons (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  invoice_display_name TEXT,
  description TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'terminated')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminated_at TEXT
) STRICT;

CREATE UNIQUE INDEX add_ons_active_code_idx
  ON add_ons(organization_id, code) WHERE status = 'active';
CREATE INDEX add_ons_org_status_idx ON add_ons(organization_id, status, created_at);

CREATE TABLE fixed_charges (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  add_on_id TEXT NOT NULL REFERENCES add_ons(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  invoice_display_name TEXT,
  charge_model TEXT NOT NULL CHECK (charge_model IN ('standard', 'graduated', 'volume')),
  properties_json TEXT NOT NULL,
  units TEXT NOT NULL,
  pay_in_advance INTEGER NOT NULL DEFAULT 0 CHECK (pay_in_advance = 0),
  prorated INTEGER NOT NULL DEFAULT 0 CHECK (prorated = 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_id, code)
) STRICT;

CREATE INDEX fixed_charges_plan_idx ON fixed_charges(plan_id, created_at);
