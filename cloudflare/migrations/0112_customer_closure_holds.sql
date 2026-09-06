CREATE TABLE customer_closure_holds (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE customer_closure_email_holds (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, email)
);
