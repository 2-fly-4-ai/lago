-- Fixed-charge units are effective-dated per subscription. This preserves the unit value that
-- applied to an open billing period when a catalog or subscription override schedules a change
-- for the next period, while allowing an explicit immediate change to take effect in the current
-- period. Properties remain versioned on the fixed charge, matching Lago's event model.
CREATE TABLE fixed_charge_unit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  fixed_charge_id TEXT NOT NULL REFERENCES fixed_charges(id) ON DELETE RESTRICT,
  fixed_charge_version INTEGER NOT NULL CHECK (fixed_charge_version >= 0),
  units TEXT NOT NULL CHECK (length(units) > 0),
  effective_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (subscription_id, fixed_charge_id, fixed_charge_version)
) STRICT;

CREATE INDEX fixed_charge_unit_events_lookup_idx
  ON fixed_charge_unit_events(subscription_id, fixed_charge_id, fixed_charge_version DESC,
                              effective_at DESC);
